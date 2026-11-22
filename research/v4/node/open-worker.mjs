// Open V4 quorum worker. One pass: for each open cohort day, verify the onchain sessions
// against this operator's own Snapchain node, sign the report at most once, then relay it to
// Base (signature, allocations, activation). Every step is idempotent; run it on a schedule, every minute
// around the 00:00 UTC cohort close (30-minute commit phase, 1-hour review) and every 10 minutes otherwise:
//   */10 * * * * node research/v4/node/open-worker.mjs
//   * 0,1 * * * node research/v4/node/open-worker.mjs
// Env: V4_CHAIN_ID, V4_DISTRIBUTOR_ADDRESS (any distributor of the deployment: each day is routed to
//      token.distributorForDay, so a governance upgrade needs no config change, only a matching worker build),
//      V4_RPC_URL, NODE_SIGNING_KEY (bonded key, also pays gas),
//      NODE_JOURNAL_DIR (durable; never wipe or restore an old copy). No MineCast backend is needed.
// Every node must run the same collect() rules, or honest nodes sign different digests.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWalletClient, encodeAbiParameters, getAddress, http, keccak256, parseAbi, publicActions, zeroAddress, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { FOLLOWER_TIERS } from '../allocation.mjs'
import { miningPoolForDay } from './bootstrap-model.mjs'
import { buildOpenReport, openDigest, typedReport } from '../open-report.mjs'
import { FARCASTER_EPOCH, castById, followersOf, hasVerifiedWallet, lastFidRegisteredBy } from './farcaster-source.mjs'

const DAY = 86400n, HOUR = 3600n, COMMIT_WINDOW = 1800n, REVIEW_PERIOD = HOUR
const CONCURRENCY = 8 // parallel Snapchain/RPC reads; hosted APIs allow ~10 requests per second per endpoint
// Follower tiers are fixed per UTC week (Monday 00:00), counted from raw Snapchain follows with a bot
// filter: a follow must be a week old and the follower account a month old at the week start.
const FOLLOW_MIN_AGE = 7n * DAY, ACCOUNT_MIN_AGE = 30n * DAY
const weekStart = t => t - ((t / DAY + 3n) % 7n) * DAY // 1970-01-01 was a Thursday
const abi = parseAbi([
  'struct Report { uint256 day; bytes32 root; uint256 totalWeight; uint256 allocated; uint256 leafCount; bytes32 sourceHash; }',
  'struct Entry { uint64 fid; address wallet; uint64 followers; bool nodeWork; bytes20 castHash; uint64 startedAt; address nodeKey; uint8 level; uint8 invites; }',
  'struct Day { bytes32 digest; Report report; uint256 published; uint256 observedWeight; uint256 observedAllocation; uint256 claimed; uint64 claimEnd; bool contested; }',
  'function token() view returns (address)',
  'function registry() view returns (address)',
  'function launchTime() view returns (uint64)',
  'function dailyEmissionForDay(uint256 day) view returns (uint256)',
  'function reportDigest(Report r) view returns (bytes32)',
  'function weightAt(address signingKey, uint256 day) view returns (uint256)',
  'function totalWeightAt(uint256 day) view returns (uint256)',
  'function dayInfo(uint256 day) view returns (Day)',
  'function certificate(bytes32 digest) view returns (uint256 signedWeight, uint256 certifiedAt)',
  'function hasSigned(bytes32 digest, address signer) view returns (bool)',
  'function signedAt(bytes32 digest, address signer) view returns (uint256)',
  'function sessionCount(uint256 day) view returns (uint256)',
  'function sessionWallet(uint256 day, uint256 index) view returns (address)',
  'function sessions(uint256 day, address wallet) view returns (uint64 fid, bytes20 castHash, uint8 invites, uint64 startedAt, uint8 level)',
  'function sessionsHash(uint256 day) view returns (bytes32)',
  'function distributorForDay(uint256 day) view returns (address)',
  'function keysOf(address operator) view returns (address[])',
  'function submitSignatures(Report r, address[] signers, bytes[] signatures)',
  'function publishAllocations(uint256 day, Entry[] entries, bytes32[][] proofs)',
  'function activateDay(uint256 day)',
  'function announced(uint256 day, address signer) view returns (bool)',
  'function announcementCount(uint256 day) view returns (uint256)',
  'function announcementAt(uint256 day, uint256 index) view returns (address signer, uint64 blockNumber)',
  'function announceReport(uint256 day, Report r, Entry[] entries)',
  'function commitReport(uint256 day, bytes32 commitment)',
  'function commitments(uint256 day, address signer) view returns (bytes32)',
  'function certifiedSigner(uint256 day, address signingKey) view returns (bool)',
  'function proveCertifiedSignature(uint256 day, address signingKey)',
  'function nodes(address) view returns (address operator, uint64 readyAt, uint64 startDay, uint64 endDay, uint208 weight, bool activated, bool slashed, bool withdrawn)',
  'function activateNode(address signingKey)',
  'event ReportAnnounced(uint256 indexed day, address indexed signer, Entry[] entries)',
])
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)
// A key's commitment to its own report: bound to the key, so a peer cannot copy someone else's.
export const commitmentOf = (digest, key) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [digest, key]))

// Sessions live onchain (distributor.startMining), so any node rebuilds a day from plain RPC reads.
async function sessionsOf(client, address, day) {
  const read = (functionName, args) => client.readContract({ address, abi, functionName, args })
  const count = Number(await read('sessionCount', [day])), sessions = []
  // Sessions are cheap to spam on an L2: read in bounded batches so a flood cannot exhaust the RPC.
  for (let i = 0; i < count; i += 50) sessions.push(...await Promise.all(Array.from({ length: Math.min(50, count - i) }, async (_, j) => {
    const wallet = await read('sessionWallet', [day, BigInt(i + j)])
    const [fid, castHash, invites, startedAt, level] = await read('sessions', [day, wallet])
    return { fid, wallet, castHash, startedAt, level, invites }
  })))
  return sessions
}

async function followerTier(fid, week, maxFollowerFid) {
  let count = 0
  for await (const follower of followersOf(fid, week - FOLLOW_MIN_AGE)) {
    if (follower <= maxFollowerFid && ++count >= FOLLOWER_TIERS[0][0]) break
  }
  return FOLLOWER_TIERS.find(([floor]) => count >= floor)?.[0] ?? 0
}

const sessionKey = s => `${getAddress(s.wallet)}:${s.castHash.toLowerCase()}`
// The distributor's quorum threshold: floor(2 * total / 3) + 1.
export const requiredWeight = total => total / 3n * 2n + total % 3n * 2n / 3n + 1n

async function holdsQuorum(read, key, day) {
  const registry = await read('registry')
  const [weight, total] = await Promise.all([read('weightAt', [key, day], registry), read('totalWeightAt', [day], registry)])
  return weight > 0n && weight >= requiredWeight(total)
}

// The cast half of the rule: the cast is posted, then the session is opened onchain within 24 hours (5 minutes of clock skew).
async function castProvable(s) {
  if (s.fid > BigInt(Number.MAX_SAFE_INTEGER)) return false
  const cast = await castById(Number(s.fid), s.castHash)
  const castAt = cast && BigInt(FARCASTER_EPOCH + cast.data.timestamp)
  return !!cast && castAt >= s.startedAt - DAY && castAt <= s.startedAt + 300n
}

// Session inputs are attacker-chosen: never let one throw, only Snapchain/RPC failures may abort the day.
// `casts` holds sessions whose cast was already missing or out of range while the cohort was open; that never
// changes, so spam is read once. A seen cast is read again: it may have been deleted, or the wallet unverified.
async function provable(s, casts = {}) {
  if (casts[sessionKey(s)] === false) return false
  return await castProvable(s) && await hasVerifiedWallet(Number(s.fid), s.wallet)
}

// Bounded parallel map that keeps input order; any failure rejects the batch once every worker has stopped.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  const failed = settled.find(r => r.status === 'rejected')
  if (failed) throw failed.reason
  return out
}

// A node counts each FID once per week (tiers-<week>); the caches only save reads, never change a result.
function jsonCache(cacheDir, name) {
  const file = cacheDir && path.join(cacheDir, `${name}.json`)
  const cache = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const save = () => { if (file) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(cache)); fs.renameSync(file + '.tmp', file) } }
  return { cache, save }
}

async function fillTiers(fids, week, { cache, save }) {
  try {
    if (fids.length && cache.maxFollowerFid === undefined) cache.maxFollowerFid = await lastFidRegisteredBy(Number(week - ACCOUNT_MIN_AGE))
    await mapLimit([...new Set(fids)], CONCURRENCY, async fid => { cache[fid] ??= await followerTier(fid, week, cache.maxFollowerFid) })
  } finally { save() } // keep the tiers already read even if one read failed
}

/** Keep a day's onchain session only if our Snapchain view proves it; any read error aborts the day. */
export async function collect({ client, distributor, day, launchTime, cacheDir }) {
  const read = (functionName, args, address = distributor) => client.readContract({ address, abi, functionName, args })
  const registry = await read('registry')
  const sessions = await sessionsOf(client, distributor, day)
  // Casts and wallets are judged after the cohort closes (a deleted cast or removed verification drops out).
  const casts = jsonCache(cacheDir, `casts-${day}`).cache
  const proven = await mapLimit(sessions, CONCURRENCY, s => provable(s, casts))
  const kept = new Map() // fid -> earliest provable session that day (one allocation per FID)
  sessions.forEach((s, i) => {
    if (!proven[i]) return
    const other = kept.get(s.fid)
    if (!other || s.startedAt < other.startedAt || (s.startedAt === other.startedAt && BigInt(s.wallet) < BigInt(other.wallet))) kept.set(s.fid, s)
  })
  const week = weekStart(launchTime + day * DAY), tiers = jsonCache(cacheDir, `tiers-${week}`)
  await fillTiers([...kept.keys()].map(Number), week, tiers)
  const prev = await previousCertificate(read, day)
  const entries = await mapLimit([...kept.values()], CONCURRENCY, async s =>
    ({ ...s, followers: tiers.cache[Number(s.fid)], ...await nodeWork(read, registry, day, launchTime, s.wallet, prev) }))
  return { day, launchTime, entries, sourceHash: await read('sessionsHash', [day]) }
}

/** While a cohort is open, check each new session's cast once and fill this week's follower tiers for the FIDs
 *  whose cast exists, so the report right after the close re-reads only real miners. */
export async function prewarm({ client, distributor, day, launchTime, cacheDir, now }) {
  const sessions = await sessionsOf(client, distributor, day)
  const casts = jsonCache(cacheDir, `casts-${day}`), fresh = sessions.filter(s => casts.cache[sessionKey(s)] === undefined)
  try {
    await mapLimit(fresh, CONCURRENCY, async s => {
      const ok = await castProvable(s)
      // A missing cast may still be propagating just after the session opens: judge it final after 10 minutes.
      if (ok || now >= s.startedAt + 600n) casts.cache[sessionKey(s)] = ok
    })
  } finally { casts.save() }
  const week = weekStart(launchTime + day * DAY), tiers = jsonCache(cacheDir, `tiers-${week}`)
  const fids = sessions.filter(s => casts.cache[sessionKey(s)] === true).map(s => Number(s.fid)).filter(fid => tiers.cache[fid] === undefined)
  if (fids.length) await fillTiers(fids, week, tiers)
  return { casts: fresh.length, fids: new Set(fids).size }
}

async function previousCertificate(read, day) {
  if (day === 0n) return null
  const { digest } = await read('dayInfo', [day - 1n])
  const [, certifiedAt] = await read('certificate', [digest])
  return { digest, certifiedAt }
}

// Same rule the distributor checks onchain: the payout wallet operates a key that signed the previous
// day's certified report, and both happened before this day's report window opened (its cohort close).
async function nodeWork(read, registry, day, launchTime, wallet, prev) {
  const none = { nodeWork: false, nodeKey: zeroAddress }
  const cutoff = launchTime + (day + 1n) * DAY
  if (!prev || prev.digest === zeroHash || prev.certifiedAt === 0n || prev.certifiedAt > cutoff) return none
  const keys = [...await read('keysOf', [wallet], registry)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)
  for (const key of keys) {
    const signed = await read('signedAt', [prev.digest, key])
    // The bonus needs the key's own phase-1 commitment to equal the certified report (copying peers earns none).
    if (signed !== 0n && signed <= cutoff && await read('commitments', [day - 1n, key]) === commitmentOf(prev.digest, key)) return { nodeWork: true, nodeKey: key }
  }
  return none
}

// Nodes read follows at different moments, so an unfollow in between can move a tier by one step. A node
// co-signs the earliest announced entry list that matches its own on everything else and stays within one tier.
const TIER_FLOORS = [...FOLLOWER_TIERS.map(([floor]) => floor), 0]
const tierIndex = followers => TIER_FLOORS.indexOf(Number(followers))
export function withinTolerance(mine, theirs) {
  if (mine.length !== theirs.length) return false
  const byWallet = new Map(theirs.map(e => [getAddress(e.wallet), e]))
  return byWallet.size === theirs.length && mine.every(m => {
    const t = byWallet.get(getAddress(m.wallet))
    return !!t && tierIndex(t.followers) >= 0 && Math.abs(tierIndex(t.followers) - tierIndex(m.followers)) <= 1
      && BigInt(t.fid) === BigInt(m.fid) && t.castHash.toLowerCase() === m.castHash.toLowerCase()
      && BigInt(t.startedAt) === BigInt(m.startedAt) && Number(t.level) === Number(m.level) && Number(t.invites) === Number(m.invites)
      && t.nodeWork === m.nodeWork && getAddress(t.nodeKey) === getAddress(m.nodeKey)
  })
}

/** Entries of the earliest announcement this node can co-sign, or null to announce its own. */
export function pickAnnouncement(input, announcements, chainId, distributor) {
  for (const entries of announcements) {
    if (!withinTolerance(input.entries, entries)) continue
    try { buildOpenReport({ chainId, distributor, ...input, entries }); return entries } catch { /* malformed: skip */ }
  }
  return null
}

async function announcementsOf(client, read, distributor, day) {
  const list = []
  for (let i = 0n, count = await read('announcementCount', [day]); i < count; i++) {
    const [signer, blockNumber] = await read('announcementAt', [day, i])
    const [log] = await client.getContractEvents({ address: distributor, abi, eventName: 'ReportAnnounced',
      args: { day, signer }, fromBlock: blockNumber, toBlock: blockNumber })
    if (log) list.push(log.args.entries)
  }
  return list
}

function loadSigned(file, chainId, distributor) {
  if (!fs.existsSync(file)) return null
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  const bundle = buildOpenReport({ chainId, distributor, ...saved.input })
  if (openDigest(chainId, distributor, bundle.report) !== saved.digest) throw Error(file + ' does not rebuild its signed digest')
  return { ...bundle, digest: saved.digest, signature: saved.signature }
}

// A journaled signature or commitment the deployed contracts reject would lock this node out of the day,
// so the pool must equal TokenCastOpenV4's and the digest (domain, policy hash) the distributor's.
async function checkedBuild(chainId, distributor, input, read) {
  const bundle = buildOpenReport({ chainId, distributor, ...input })
  const digest = openDigest(chainId, distributor, bundle.report)
  if (await read('dailyEmissionForDay', [bundle.report.day], await read('token')) !== miningPoolForDay(bundle.report.day)
    || await read('reportDigest', [bundle.report]) !== digest) throw Error('This node build does not match the deployed TokenCast V4 / distributor')
  return { bundle, digest }
}

// Journal and commit files are created exclusively and fsynced before anything leaves this process,
// so a restart, a concurrent pass or changed data can never produce a second digest for the day.
function writeOnce(file, value) {
  const fd = fs.openSync(file, 'wx')
  try { fs.writeSync(fd, json(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dir); fs.closeSync(dir) }
}

async function saveSigned(file, account, chainId, distributor, input, read, announce) {
  const { bundle, digest } = await checkedBuild(chainId, distributor, input, read)
  if (announce) await announce(bundle) // reveal before signing so peers can adopt it
  const signature = await account.signTypedData(typedReport(chainId, distributor, bundle.report))
  writeOnce(file, { digest, signature, input })
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
  const open = end, reveal = end + COMMIT_WINDOW // the report window opens at the cohort's 00:00 UTC close
  const live = now >= open && now + REVIEW_PERIOD < end + 8n * DAY
  const bonded = live && await read('weightAt', [account.address, day], await read('registry')) > 0n
  const file = path.join(dir, `${chainId}-${distributor.toLowerCase()}-${day}.json`), commitFile = file.replace(/\.json$/, '.commit.json')
  let mine = loadSigned(file, chainId, distributor)
  if (!mine && bonded && now < reveal) {
    // Phase 1: build our own report and commit to it before any peer report is visible.
    if (!fs.existsSync(commitFile)) {
      const input = await collect(day, launchTime, distributor)
      writeOnce(commitFile, { digest: (await checkedBuild(chainId, distributor, input, read)).digest, input })
    }
    const { digest } = JSON.parse(fs.readFileSync(commitFile, 'utf8'))
    if (await read('commitments', [day, account.address]) === zeroHash) await send('commitReport', [day, commitmentOf(digest, account.address)])
    return 'committed; reveal and signing open when the 30-minute commit phase ends'
  }
  if (!mine && bonded) {
    // Phase 2: co-sign the earliest announcement within tolerance, or reveal and sign our own commitment.
    const committed = fs.existsSync(commitFile) ? JSON.parse(fs.readFileSync(commitFile, 'utf8')) : null
    const own = committed ? { ...committed.input, day: BigInt(committed.input.day), launchTime: BigInt(committed.input.launchTime) }
      : await collect(day, launchTime, distributor)
    const adopted = pickAnnouncement(own, await announcementsOf(client, read, distributor, day), chainId, distributor)
    const canReveal = committed && !(await read('announced', [day, account.address]))
      && await read('commitments', [day, account.address]) === commitmentOf(committed.digest, account.address)
    // A key that alone holds the quorum may certify without a commitment: it signs its own report late, unannounced.
    if (!adopted && !canReveal && !(await holdsQuorum(read, account.address, day))) return 'missed the commit phase; waiting for an announcement to co-sign'
    mine = await saveSigned(file, account, chainId, distributor, adopted ? { ...own, entries: adopted } : own, read,
      adopted || !canReveal ? null : bundle => send('announceReport', [day, bundle.report, bundle.entries]))
  }
  if (!mine) return 'not signing: outside the report window or key not bonded for this day'
  if (bonded && !(await read('hasSigned', [mine.digest, account.address]))) await send('submitSignatures', [mine.report, [account.address], [mine.signature]])
  info = await read('dayInfo', [day])
  if (info.digest === zeroHash) return 'waiting for quorum'
  if (info.digest !== mine.digest) return 'another report certified' // its signers publish it; we hold no proofs for it
  const [, certifiedAt] = await read('certificate', [mine.digest])
  if (certifiedAt === 0n) return 'quorum lost to double-sign evidence; waiting for keys that have not signed'
  // Keep this key counted as part of the accepted quorum (a key absent from 14 certified days can be ejected).
  if (await read('hasSigned', [mine.digest, account.address])
    && !(await read('certifiedSigner', [day, account.address], await read('registry')))) await send('proveCertifiedSignature', [day, account.address])
  for (let i = Number(info.published); i < mine.entries.length; i += 100) {
    await send('publishAllocations', [day, mine.entries.slice(i, i + 100), mine.proofs.slice(i, i + 100)])
  }
  if (now < certifiedAt + REVIEW_PERIOD) return 'waiting for review'
  await send('activateDay', [day])
  return 'activated'
}

// A registered key activates itself as soon as its 7-day join delay ends (anyone may call activateNode),
// so the operator never has to catch the moment by hand. It counts from the next day (day 0 if before launch).
async function activateSelf({ client, account, distributor }, now) {
  const registry = await client.readContract({ address: distributor, abi, functionName: 'registry' })
  const [operator, readyAt, , endDay, , activated] = await client.readContract({ address: registry, abi, functionName: 'nodes', args: [account.address] })
  if (operator === zeroAddress || activated || endDay !== 2n ** 64n - 1n || now < readyAt) return
  const hash = await client.writeContract({ address: registry, abi, functionName: 'activateNode', args: [account.address], account })
  if ((await client.waitForTransactionReceipt({ hash })).status !== 'success') throw Error('activateNode reverted')
  console.log('node: activated; it counts from the next day')
}

export async function runPass(ctx) {
  const tokenRead = async (functionName, args) => ctx.client.readContract({ address: token, abi, functionName, args })
  const token = await ctx.client.readContract({ address: ctx.distributor, abi, functionName: 'token' })
  const launchTime = await tokenRead('launchTime')
  const now = (await ctx.client.getBlock()).timestamp
  const today = now < launchTime ? 0n : (now - launchTime) / DAY
  try { await activateSelf(ctx, now) } catch (error) { process.exitCode = 1; console.error(`node: activation failed: ${error.shortMessage ?? error.message}`) }
  for (let day = today > 8n ? today - 8n : 0n; day < today; day++) {
    // A distributor built for other rules makes saveSigned refuse its days: upgrade the worker to match.
    try { console.log(`day ${day}: ${await processDay({ ...ctx, distributor: await tokenRead('distributorForDay', [day]) }, day, launchTime, now)}`) }
    catch (error) { process.exitCode = 1; console.error(`day ${day}: ${error.shortMessage ?? error.message}`) }
  }
  if (now < launchTime || !ctx.prewarm) return
  try {
    const warmed = await ctx.prewarm(await tokenRead('distributorForDay', [today]), today, launchTime, now)
    if (warmed.casts || warmed.fids) console.log(`day ${today}: checked ${warmed.casts} new casts, cached tiers for ${warmed.fids} FIDs`)
  } catch (error) { console.error(`day ${today}: tier prewarm failed (retried next pass): ${error.shortMessage ?? error.message}`) }
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
  const cacheDir = distributor => path.join(dir, 'tier-cache', distributor.toLowerCase())
  await runPass({ client, account, distributor, dir,
    collect: (day, launchTime, distributor) => collect({ client, distributor, day, launchTime, cacheDir: cacheDir(distributor) }),
    // Only a key bonded for the open cohort will report it, so only then spend Snapchain reads ahead of time.
    prewarm: async (distributor, day, launchTime, now) => {
      const registry = await client.readContract({ address: distributor, abi, functionName: 'registry' })
      if (await client.readContract({ address: registry, abi, functionName: 'weightAt', args: [account.address, day] }) === 0n) return { casts: 0, fids: 0 }
      return prewarm({ client, distributor, day, launchTime, cacheDir: cacheDir(distributor), now })
    } })
}
