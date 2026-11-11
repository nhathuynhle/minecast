// Open V4 quorum worker. One pass: for each open cohort day, verify the onchain sessions
// against this operator's own Snapchain node, sign the report at most once, then relay it to
// Base (signature, allocations, activation). Every step is idempotent; run it on a schedule:
//   */10 * * * * node research/v4/node/open-worker.mjs
// Env: V4_CHAIN_ID, V4_DISTRIBUTOR_ADDRESS, V4_RPC_URL, NODE_SIGNING_KEY (bonded key, also pays gas),
//      NODE_JOURNAL_DIR (durable; never wipe or restore an old copy). No MineCast backend is needed.
// Every node must run the same collect() rules, or honest nodes sign different digests.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWalletClient, getAddress, http, parseAbi, publicActions, zeroAddress, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { FOLLOWER_TIERS } from '../allocation.mjs'
import { miningPoolForDay } from './bootstrap-model.mjs'
import { buildOpenReport, openDigest, typedReport } from '../open-report.mjs'
import { FARCASTER_EPOCH, castById, followersOf, hasVerifiedWallet } from './farcaster-source.mjs'

const DAY = 86400n, HOUR = 3600n
const abi = parseAbi([
  'struct Report { uint256 day; bytes32 root; uint256 totalWeight; uint256 allocated; uint256 leafCount; bytes32 sourceHash; }',
  'struct Entry { uint64 fid; address wallet; uint64 followers; bool nodeWork; bytes20 castHash; uint64 startedAt; address nodeKey; uint8 level; }',
  'struct Day { bytes32 digest; Report report; uint256 published; uint256 observedWeight; uint256 observedAllocation; uint256 claimed; uint64 claimEnd; bool contested; }',
  'function token() view returns (address)',
  'function registry() view returns (address)',
  'function launchTime() view returns (uint64)',
  'function dailyEmissionForDay(uint256 day) view returns (uint256)',
  'function reportDigest(Report r) view returns (bytes32)',
  'function weightAt(address signingKey, uint256 day) view returns (uint256)',
  'function dayInfo(uint256 day) view returns (Day)',
  'function certificate(bytes32 digest) view returns (uint256 signedWeight, uint256 certifiedAt)',
  'function hasSigned(bytes32 digest, address signer) view returns (bool)',
  'function signedAt(bytes32 digest, address signer) view returns (uint256)',
  'function sessionCount(uint256 day) view returns (uint256)',
  'function sessionWallet(uint256 day, uint256 index) view returns (address)',
  'function sessions(uint256 day, address wallet) view returns (uint64 fid, bytes20 castHash, uint64 startedAt, uint8 level)',
  'function sessionsHash(uint256 day) view returns (bytes32)',
  'function distributorForDay(uint256 day) view returns (address)',
  'function keysOf(address operator) view returns (address[])',
  'function submitSignatures(Report r, address[] signers, bytes[] signatures)',
  'function publishAllocations(uint256 day, Entry[] entries, bytes32[][] proofs)',
  'function activateDay(uint256 day)',
])
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)

// Sessions live onchain (distributor.startMining), so any node rebuilds a day from plain RPC reads.
async function sessionsOf(client, address, day) {
  const read = (functionName, args) => client.readContract({ address, abi, functionName, args })
  const count = Number(await read('sessionCount', [day])), sessions = []
  // Sessions are cheap to spam on an L2: read in bounded batches so a flood cannot exhaust the RPC.
  for (let i = 0; i < count; i += 50) sessions.push(...await Promise.all(Array.from({ length: Math.min(50, count - i) }, async (_, j) => {
    const wallet = await read('sessionWallet', [day, BigInt(i + j)])
    const [fid, castHash, startedAt, level] = await read('sessions', [day, wallet])
    return { fid, wallet, castHash, startedAt, level }
  })))
  return sessions
}

async function followerTier(fid, at) {
  let count = 0
  for await (const _ of followersOf(fid, at)) if (++count >= FOLLOWER_TIERS[0][0]) break
  return FOLLOWER_TIERS.find(([floor]) => count >= floor)?.[0] ?? 0
}

// Session inputs are attacker-chosen: never let one throw, only Snapchain/RPC failures may abort the day.
async function provable(s) {
  if (s.fid > BigInt(Number.MAX_SAFE_INTEGER)) return false
  const cast = await castById(Number(s.fid), s.castHash)
  const castAt = cast && BigInt(FARCASTER_EPOCH + cast.data.timestamp)
  // The cast is posted, then the session is opened onchain within 24 hours (5 minutes of clock skew).
  return !!cast && castAt >= s.startedAt - DAY && castAt <= s.startedAt + 300n && await hasVerifiedWallet(Number(s.fid), s.wallet)
}

/** Keep a day's onchain session only if our Snapchain view proves it; any read error aborts the day. */
export async function collect({ client, distributor, day, launchTime }) {
  const read = (functionName, args, address = distributor) => client.readContract({ address, abi, functionName, args })
  const [token, registry] = await Promise.all([read('token'), read('registry')])
  const kept = new Map() // fid -> earliest provable session that day (one allocation per FID)
  for (const s of await sessionsOf(client, distributor, day)) {
    if (!(await provable(s))) continue
    const other = kept.get(s.fid)
    if (!other || s.startedAt < other.startedAt || (s.startedAt === other.startedAt && BigInt(s.wallet) < BigInt(other.wallet))) kept.set(s.fid, s)
  }
  // A FID's provable session from yesterday (any of its wallets) must have ended first.
  const yesterday = day > 0n ? await sessionsOf(client, await read('distributorForDay', [day - 1n], token), day - 1n) : []
  const entries = []
  for (const s of kept.values()) {
    let overlaps = false
    for (const p of yesterday) if (p.fid === s.fid && p.startedAt + DAY > s.startedAt && await hasVerifiedWallet(Number(p.fid), p.wallet)) overlaps = true
    if (overlaps) continue
    entries.push({ ...s, followers: await followerTier(Number(s.fid), s.startedAt), ...await nodeWork(read, registry, day, launchTime, s.wallet) })
  }
  return { day, launchTime, entries, sourceHash: await read('sessionsHash', [day]) }
}

// Same rule the distributor checks onchain: the payout wallet operates a key that signed the previous
// day's certified report, and both happened before this day's report window opened.
async function nodeWork(read, registry, day, launchTime, wallet) {
  const none = { nodeWork: false, nodeKey: zeroAddress }
  if (day === 0n) return none
  const cutoff = launchTime + (day + 2n) * DAY + 6n * HOUR
  const { digest } = await read('dayInfo', [day - 1n])
  const [, certifiedAt] = await read('certificate', [digest])
  if (digest === zeroHash || certifiedAt === 0n || certifiedAt > cutoff) return none
  const keys = [...await read('keysOf', [wallet], registry)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)
  for (const key of keys) {
    const signed = await read('signedAt', [digest, key])
    if (signed !== 0n && signed <= cutoff) return { nodeWork: true, nodeKey: key }
  }
  return none
}

function loadSigned(file, chainId, distributor) {
  if (!fs.existsSync(file)) return null
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  const bundle = buildOpenReport({ chainId, distributor, ...saved.input })
  if (openDigest(chainId, distributor, bundle.report) !== saved.digest) throw Error(file + ' does not rebuild its signed digest')
  return { ...bundle, digest: saved.digest, signature: saved.signature }
}

// The journal file is created exclusively and fsynced before the signature can leave this process,
// so a restart, a concurrent pass or changed data can never produce a second digest for the day.
async function saveSigned(file, account, chainId, distributor, input, read) {
  const bundle = buildOpenReport({ chainId, distributor, ...input })
  const digest = openDigest(chainId, distributor, bundle.report)
  // A journaled signature the deployed contracts reject would lock this node out of the day for good,
  // so the pool must equal TokenCastOpenV4's and the digest (domain, policy hash) the distributor's.
  if (await read('dailyEmissionForDay', [bundle.report.day], await read('token')) !== miningPoolForDay(bundle.report.day)
    || await read('reportDigest', [bundle.report]) !== digest) throw Error('This node build does not match the deployed TokenCast V4 / distributor')
  const signature = await account.signTypedData(typedReport(chainId, distributor, bundle.report))
  const fd = fs.openSync(file, 'wx')
  try { fs.writeSync(fd, json({ digest, signature, input })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dir); fs.closeSync(dir) }
  return { ...bundle, digest, signature }
}

export async function processDay({ client, account, distributor, dir, collect }, day, launchTime, now) {
  const contract = { address: distributor, abi }
  const read = (functionName, args, address = distributor) => client.readContract({ address, abi, functionName, args })
  async function send(functionName, args) {
    const request = { ...contract, functionName, args, account }
    const gas = await client.estimateContractGas(request)
    const receipt = await client.waitForTransactionReceipt({ hash: await client.writeContract({ ...request, gas: gas + gas / 5n }) })
    if (receipt.status !== 'success') throw Error(functionName + ' reverted')
  }
  const chainId = client.chain.id, end = launchTime + (day + 1n) * DAY
  let info = await read('dayInfo', [day])
  if (info.contested) return 'contested'
  if (info.claimEnd !== 0n) return 'claims open'
  const signing = now >= end + DAY + 6n * HOUR && now + 2n * DAY < end + 8n * DAY
  const bonded = signing && await read('weightAt', [account.address, day], await read('registry')) > 0n
  const file = path.join(dir, `${chainId}-${distributor.toLowerCase()}-${day}.json`)
  const mine = loadSigned(file, chainId, distributor) ?? (bonded ? await saveSigned(file, account, chainId, distributor, await collect(day, launchTime), read) : null)
  if (!mine) return 'not signing: outside the report window or key not bonded for this day'
  if (bonded && !(await read('hasSigned', [mine.digest, account.address]))) await send('submitSignatures', [mine.report, [account.address], [mine.signature]])
  info = await read('dayInfo', [day])
  if (info.digest === zeroHash) return 'waiting for quorum'
  if (info.digest !== mine.digest) return 'another report certified' // its signers publish it; we hold no proofs for it
  for (let i = Number(info.published); i < mine.entries.length; i += 100) {
    await send('publishAllocations', [day, mine.entries.slice(i, i + 100), mine.proofs.slice(i, i + 100)])
  }
  const [, certifiedAt] = await read('certificate', [mine.digest])
  if (now < certifiedAt + 2n * DAY) return 'waiting for review'
  await send('activateDay', [day])
  return 'activated'
}

export async function runPass(ctx) {
  const launchTime = await ctx.client.readContract({ address: await ctx.client.readContract({ address: ctx.distributor, abi, functionName: 'token' }), abi, functionName: 'launchTime' })
  const now = (await ctx.client.getBlock()).timestamp
  const today = now < launchTime ? 0n : (now - launchTime) / DAY
  for (let day = today > 8n ? today - 8n : 0n; day < today; day++) {
    try { console.log(`day ${day}: ${await processDay(ctx, day, launchTime, now)}`) }
    catch (error) { process.exitCode = 1; console.error(`day ${day}: ${error.shortMessage ?? error.message}`) }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const env = name => { if (!process.env[name]) throw Error('Missing ' + name); return process.env[name] }
  const chain = { [base.id]: base, [baseSepolia.id]: baseSepolia }[Number(env('V4_CHAIN_ID'))]
  if (!chain) throw Error('V4_CHAIN_ID must be 8453 or 84532')
  const account = privateKeyToAccount(env('NODE_SIGNING_KEY'))
  const client = createWalletClient({ account, chain, transport: http(env('V4_RPC_URL')) }).extend(publicActions)
  if (await client.getChainId() !== chain.id) throw Error('V4_RPC_URL is on another chain')
  const distributor = getAddress(env('V4_DISTRIBUTOR_ADDRESS')), dir = env('NODE_JOURNAL_DIR')
  fs.mkdirSync(dir, { recursive: true })
  await runPass({ client, account, distributor, dir, collect: (day, launchTime) => collect({ client, distributor, day, launchTime }) })
}
