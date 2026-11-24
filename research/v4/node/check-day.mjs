// Check a certified day against this machine's own Farcaster view. Anyone can run it; it signs and sends nothing.
//   V4_CHAIN_ID=84532 V4_RPC_URL=... V4_DISTRIBUTOR_ADDRESS=0x... SNAPCHAIN_URL=... node research/v4/node/check-day.mjs <day>
// It rebuilds the day with the worker's own rules and lists every paid row that differs from what it can prove.
// Run it soon after a day is certified: a cast deleted or a wallet unverified later also shows up as a difference.
import { pathToFileURL } from 'node:url'
import { createPublicClient, getAddress, http, parseAbi } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { ENGAGEMENT_FLOORS, FOLLOWER_FLOORS } from '../open-report.mjs'
import { collect } from './open-worker.mjs'

const tierStep = (floors, a, b) => Math.abs(floors.indexOf(Number(a)) - floors.indexOf(Number(b)))

/** Rows paid onchain vs rows this node proves. One tier step is normal (follows and reactions read at different moments). */
export function compareDay(mine, paid, complete = true) {
  const proven = new Map(mine.map(e => [getAddress(e.wallet), e])), issues = []
  for (const p of paid) {
    const m = proven.get(getAddress(p.wallet))
    proven.delete(getAddress(p.wallet))
    if (!m) { issues.push({ wallet: p.wallet, fid: p.fid, problem: 'paid, but this node cannot prove the session (cast, wallet or FID)' }); continue }
    if (BigInt(m.fid) !== BigInt(p.fid) || m.castHash.toLowerCase() !== p.castHash.toLowerCase()) issues.push({ wallet: p.wallet, fid: p.fid, problem: 'paid for a different FID or cast' })
    else if (tierStep(FOLLOWER_FLOORS, m.followers, p.followers) > 1) issues.push({ wallet: p.wallet, fid: p.fid, problem: `paid as ${p.followers} followers, this node sees the ${m.followers} tier` })
    else if (tierStep(ENGAGEMENT_FLOORS, m.engagement, p.engagement) > 1) issues.push({ wallet: p.wallet, fid: p.fid, problem: `paid as ${p.engagement} engaged accounts, this node sees the ${m.engagement} tier` })
    else if (m.nodeWork !== p.nodeWork) issues.push({ wallet: p.wallet, fid: p.fid, problem: `node bonus ${p.nodeWork ? 'paid' : 'missing'}, this node computes ${m.nodeWork}` })
  }
  if (complete) for (const m of proven.values()) issues.push({ wallet: m.wallet, fid: m.fid, problem: 'proven miner left out of the paid report' })
  return issues
}

const abi = parseAbi([
  'struct Report { uint256 day; bytes32 root; uint256 totalWeight; uint256 allocated; uint256 leafCount; bytes32 sourceHash; }',
  'struct Day { bytes32 digest; Report report; uint256 published; uint256 observedWeight; uint256 observedAllocation; uint256 claimed; uint64 claimEnd; bool contested; }',
  'function token() view returns (address)',
  'function launchTime() view returns (uint64)',
  'function distributorForDay(uint256 day) view returns (address)',
  'function dayInfo(uint256 day) view returns (Day)',
  'event AllocationPublished(uint256 indexed day, uint256 indexed index, address indexed wallet, uint64 fid, uint64 followers, uint64 engagement, bool nodeWork, bytes20 castHash, uint256 amount)',
])

// Published rows of one day, scanned from about the cohort close (Base: ~2 s blocks) in RPC-friendly chunks.
async function paidRows(client, distributor, day, dayEnd, published) {
  const latest = await client.getBlockNumber(), now = (await client.getBlock()).timestamp
  let from = latest - (now > dayEnd ? (now - dayEnd) / 2n : 0n) - 1800n
  if (from < 0n) from = 0n
  const rows = []
  for (; from <= latest && BigInt(rows.length) < published; from += 2000n) {
    const logs = await client.getContractEvents({ address: distributor, abi, eventName: 'AllocationPublished', args: { day }, fromBlock: from, toBlock: from + 1999n < latest ? from + 1999n : latest })
    rows.push(...logs.map(l => l.args))
  }
  return rows
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const env = name => { if (!process.env[name]) throw Error('Missing ' + name); return process.env[name] }
  const chain = { [base.id]: base, [baseSepolia.id]: baseSepolia }[Number(env('V4_CHAIN_ID'))]
  if (!chain || !/^\d+$/.test(process.argv[2] ?? '')) throw Error('Usage: node research/v4/node/check-day.mjs <day>   (V4_CHAIN_ID 8453 or 84532)')
  const client = createPublicClient({ chain, transport: http(env('V4_RPC_URL')) }), day = BigInt(process.argv[2])
  const read = (address, functionName, args) => client.readContract({ address, abi, functionName, args })
  const token = await read(getAddress(env('V4_DISTRIBUTOR_ADDRESS')), 'token')
  const launchTime = await read(token, 'launchTime'), distributor = await read(token, 'distributorForDay', [day])
  const info = await read(distributor, 'dayInfo', [day])
  if (info.published === 0n) { console.log(`day ${day}: nothing published yet`); process.exit(0) }
  const paid = await paidRows(client, distributor, day, launchTime + (day + 1n) * 86400n, info.published)
  const { entries } = await collect({ client, distributor, day, launchTime })
  const issues = compareDay(entries, paid, info.published === info.report.leafCount)
  console.log(`day ${day}: ${paid.length} paid rows${info.published < info.report.leafCount ? ` (${info.published}/${info.report.leafCount} published so far)` : ''}, ${entries.length} proven here, ${issues.length} differences`)
  for (const i of issues) console.log(`  fid ${i.fid} ${i.wallet}: ${i.problem}`)
  process.exitCode = issues.length ? 1 : 0
}
