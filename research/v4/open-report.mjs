// Open V4 quorum format. This computes allocations; it does NOT authenticate Farcaster data.
import { encodeAbiParameters, hashTypedData, keccak256, concatHex, toHex, zeroHash, zeroAddress, getAddress } from 'viem'
import { followerWeight } from './allocation.mjs'
import { miningPoolForDay } from './node/bootstrap-model.mjs'

export const POLICY_HASH = keccak256(toHex('MineCast.OpenV4.Quorum.3:premine2100000:decay50bps:cap100bps:tiers1-2-4-6-10-18-30-50-75-100:node5x-prevday-signer:surplus5-95:onchain-sessions:claim7d:boost-burn-L1-9-x0.2-1M*L-cap*(1+0.2L)'))
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
// Weights are in fifths: base (follower tier × node 5, capped at 100) × (5 + burn-boost level).
export function weightOf(entry) {
  const weight = followerWeight(Number(entry.followers)) * (entry.nodeWork ? 5n : 1n)
  return (weight > 100n ? 100n : weight) * (5n + BigInt(entry.level ?? 0))
}
const components = [ { name: 'fid', type: 'uint64' }, { name: 'wallet', type: 'address' },
  { name: 'followers', type: 'uint64' }, { name: 'nodeWork', type: 'bool' },
  { name: 'castHash', type: 'bytes20' }, { name: 'startedAt', type: 'uint64' }, { name: 'nodeKey', type: 'address' },
  { name: 'level', type: 'uint8' } ]
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
      startedAt: integer(entry.startedAt), nodeKey: getAddress(entry.nodeKey ?? zeroAddress), level: Number(entry.level ?? 0) }
    const start = launchTime + day * 86400n
    if (e.fid <= 0n || e.fid >= 2n ** 64n || e.followers < 0n || e.followers > BigInt(Number.MAX_SAFE_INTEGER)
      || typeof e.nodeWork !== 'boolean' || e.startedAt >= 2n ** 64n || e.startedAt < start || e.startedAt >= start + 86400n
      || /^0x0{40}$/i.test(e.wallet) || !/^0x[0-9a-f]{40}$/i.test(e.castHash) || /^0x0{40}$/i.test(e.castHash)
      || e.nodeWork !== (e.nodeKey !== zeroAddress) || !Number.isInteger(e.level) || e.level < 0 || e.level > 9) throw Error('Invalid entry')
    const fid = String(e.fid), wallet = e.wallet.toLowerCase(), cast = e.castHash.toLowerCase()
    if (fids.has(fid) || wallets.has(wallet) || casts.has(cast)) throw Error('Duplicate FID, wallet or cast')
    fids.add(fid); wallets.add(wallet); casts.add(cast)
    return e
  }).sort((a, b) => a.fid < b.fid ? -1 : 1)
  const totalWeight = canonical.reduce((sum, e) => sum + weightOf(e), 0n)
  const amounts = canonical.map(e => {
    const proportional = pool * weightOf(e) / totalWeight, cap = pool * (5n + BigInt(e.level)) / 500n
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
