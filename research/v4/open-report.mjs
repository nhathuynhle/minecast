// Open V4 quorum format. This computes allocations; it does NOT authenticate Farcaster data.
import { encodeAbiParameters, hashTypedData, keccak256, concatHex, toHex, zeroHash, zeroAddress, getAddress } from 'viem'
import { miningPoolForDay } from './node/bootstrap-model.mjs'

export const POLICY_HASH = keccak256(toHex('MineCast.OpenV4.Quorum.10:premine2100000:decay50bps:cap100bps:floor10000:followers1-10x-engagement0-10-sqrt-reactors30d-at-close:node3x-prevday-own-commit-fixed-at-cutoff:invite+0.1-max10-in-cap100-fid-once-f100:surplus5-95:onchain-sessions:claim7d:boost-burn-L1-9-x0.2-1M-each-cap*(1+0.2L)-ceil200:followers-weekly-mon-link7d-account30d:utc-day-sessions:commit30m-salted-open-until-reveal:review1h:cast30m-one-day:dupe-text-earliest'))
export const types = { DailyReport: [
  { name: 'day', type: 'uint256' }, { name: 'root', type: 'bytes32' },
  { name: 'totalWeight', type: 'uint256' }, { name: 'allocated', type: 'uint256' },
  { name: 'leafCount', type: 'uint256' }, { name: 'sourceHash', type: 'bytes32' }, { name: 'policyHash', type: 'bytes32' },
] }
export function typedReport(chainId, distributor, report) {
  return { domain: { name: 'MineCast Daily Report', version: '4-open', chainId, verifyingContract: distributor },
    types, primaryType: 'DailyReport', message: { ...report, policyHash: POLICY_HASH } }
}
export function openDigest(chainId, distributor, report) { return hashTypedData(typedReport(chainId, distributor, report)) }
// While total weight is below 10,000 base units, one unit earns at most pool / 10,000; the rest is surplus.
export const MIN_TOTAL_WEIGHT = 500_000n
// Tier floors, highest first; a report carries the floor, never the raw count.
export const FOLLOWER_FLOORS = [100_000, 50_000, 25_000, 10_000, 5_000, 2_000, 1_000, 500, 100, 0]
// floor(sqrt(n)) steps up to 10: accounts 30+ days old, not the author, that liked or recast by the cohort close.
export const ENGAGEMENT_FLOORS = [100, 81, 64, 49, 36, 25, 16, 9, 4, 1, 0]
const factor = (floors, n) => { const i = floors.findIndex(f => n >= f); return BigInt(floors.length - 1 - i) }
// Weights are in fiftieths: min(min(followers 1..10 × engagement 0..10 × node 3 × (1 + 0.1 × invites), 100) × (1 + 0.2 × level), 200) × 50.
export function weightOf(entry) {
  const base = (factor(FOLLOWER_FLOORS, Number(entry.followers)) + 1n) * factor(ENGAGEMENT_FLOORS, Number(entry.engagement))
    * (entry.nodeWork ? 3n : 1n) * (10n + BigInt(Math.min(entry.invites ?? 0, 10)))
  const boosted = (base > 1000n ? 1000n : base) * (5n + BigInt(entry.level ?? 0))
  return boosted > 10000n ? 10000n : boosted
}
const components = [ { name: 'fid', type: 'uint64' }, { name: 'wallet', type: 'address' },
  { name: 'followers', type: 'uint64' }, { name: 'engagement', type: 'uint64' }, { name: 'nodeWork', type: 'bool' },
  { name: 'castHash', type: 'bytes20' }, { name: 'startedAt', type: 'uint64' }, { name: 'nodeKey', type: 'address' },
  { name: 'level', type: 'uint8' }, { name: 'invites', type: 'uint8' } ]
export function openLeaf(chainId, distributor, day, index, entry, amount) {
  return keccak256(keccak256(encodeAbiParameters([
    { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'tuple', components }, { type: 'uint256' },
  ], [BigInt(chainId), distributor, day, BigInt(index), entry, amount])))
}
const pair = (a, b) => keccak256(concatHex(BigInt(a) < BigInt(b) ? [a, b] : [b, a]))
function integer(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('Use a decimal string for large integers')
  if (typeof value !== 'bigint' && typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) throw Error('Invalid integer')
  const result = BigInt(value)
  if (result < 0n) throw Error('Negative integer')
  return result
}

/** Canonical FID order, exact integers, indexed leaves, full published list. Caller authenticates inputs. */
export function buildOpenReport({ chainId, distributor, day, launchTime, entries, sourceHash }) {
  day = integer(day); launchTime = integer(launchTime)
  // The distributor binds sourceHash to its onchain sessionsHash(day); zero means no session started that day.
  if (!/^0x[0-9a-f]{64}$/i.test(sourceHash) || (sourceHash === zeroHash && entries.length)) throw Error('sourceHash must be the day\'s sessionsHash')
  const pool = miningPoolForDay(day)
  if (pool === 0n) throw Error('Mining emission ended')
  const fids = new Set(), wallets = new Set(), casts = new Set()
  const canonical = entries.map(entry => {
    const e = { ...entry, wallet: getAddress(entry.wallet), fid: integer(entry.fid), followers: integer(entry.followers),
      engagement: integer(entry.engagement),
      startedAt: integer(entry.startedAt), nodeKey: getAddress(entry.nodeKey ?? zeroAddress), level: Number(entry.level ?? 0),
      invites: Number(entry.invites ?? 0) }
    const start = launchTime + day * 86400n
    if (e.fid <= 0n || e.fid >= 2n ** 64n || e.followers < 0n || e.followers > BigInt(Number.MAX_SAFE_INTEGER)
      || e.engagement > BigInt(Number.MAX_SAFE_INTEGER)
      || typeof e.nodeWork !== 'boolean' || e.startedAt >= 2n ** 64n || e.startedAt < start || e.startedAt >= start + 86400n
      || /^0x0{40}$/i.test(e.wallet) || !/^0x[0-9a-f]{40}$/i.test(e.castHash) || /^0x0{40}$/i.test(e.castHash)
      || e.nodeWork !== (e.nodeKey !== zeroAddress) || !Number.isInteger(e.level) || e.level < 0 || e.level > 9
      || !Number.isInteger(e.invites) || e.invites < 0 || e.invites > 10) throw Error('Invalid entry')
    const fid = String(e.fid), wallet = e.wallet.toLowerCase(), cast = e.castHash.toLowerCase()
    if (fids.has(fid) || wallets.has(wallet) || casts.has(cast)) throw Error('Duplicate FID, wallet or cast')
    fids.add(fid); wallets.add(wallet); casts.add(cast)
    return e
  }).sort((a, b) => a.fid < b.fid ? -1 : 1)
  const totalWeight = canonical.reduce((sum, e) => sum + weightOf(e), 0n)
  const amounts = canonical.map(e => {
    const proportional = pool * weightOf(e) / (totalWeight > MIN_TOTAL_WEIGHT ? totalWeight : MIN_TOTAL_WEIGHT), cap = pool * (5n + BigInt(e.level)) / 500n
    return proportional < cap ? proportional : cap
  })
  const leaves = canonical.map((e, i) => openLeaf(chainId, distributor, day, i, e, amounts[i]))
  const levels = [leaves]
  while (levels.at(-1).length > 1) {
    const prev = levels.at(-1), next = []
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i])
    levels.push(next)
  }
  const proofs = leaves.map((_, i) => {
    const proof = []
    for (let depth = 0; depth < levels.length - 1; depth++) {
      const sibling = i ^ 1
      if (sibling < levels[depth].length) proof.push(levels[depth][sibling])
      i = Math.floor(i / 2)
    }
    return proof
  })
  return { report: { day, root: leaves.length ? levels.at(-1)[0] : zeroHash, totalWeight,
    allocated: amounts.reduce((a, b) => a + b, 0n), leafCount: BigInt(leaves.length), sourceHash },
    entries: canonical, amounts, leaves, proofs }
}
