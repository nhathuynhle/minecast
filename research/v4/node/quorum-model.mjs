// Research-only quorum arithmetic. NO cryptographic, source-data or network validation.
// IDs and stake weights are supplied fixtures, not authenticated validator records.
import { pathToFileURL } from 'node:url'

export function certificateSupport(snapshot, signerIds, minimumTotalBond = 1n) {
  if (!Array.isArray(snapshot) || !Array.isArray(signerIds)
      || typeof minimumTotalBond !== 'bigint' || minimumTotalBond < 1n) {
    throw new TypeError('Invalid model input')
  }
  const weights = new Map()
  let totalStake = 0n
  for (const { id, stake } of snapshot) {
    if (typeof id !== 'string' || !id || weights.has(id)
        || typeof stake !== 'bigint' || stake <= 0n) throw new Error('Invalid snapshot')
    weights.set(id, stake)
    totalStake += stake
  }
  const seen = new Set()
  let signedStake = 0n
  for (const id of signerIds) {
    if (!weights.has(id) || seen.has(id)) throw new Error('Unknown or duplicate signer')
    seen.add(id)
    signedStake += weights.get(id)
  }
  // Strictly greater than 2/3; unlike Solidity, JS BigInt has no uint256 overflow.
  const requiredStake = totalStake * 2n / 3n + 1n
  const enoughBond = totalStake >= minimumTotalBond
  return { totalStake, signedStake, requiredStake, enoughBond,
    quorumReached: enoughBond && signedStake >= requiredStake }
}

// Intersection of two hypothetical conflicting certificates for the SAME context.
// Real slashing requires both authentic EIP-712 signatures, not this set intersection.
export function conflictingSigners(first, second) {
  const other = new Set(second)
  return [...new Set(first)].filter(id => other.has(id))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const network = [{ id: 'founder', stake: 20n }, { id: 'alice', stake: 40n }, { id: 'bob', stake: 40n }]
  const concentrated = [{ id: 'founder', stake: 40n }, { id: 'alice', stake: 30n }, { id: 'bob', stake: 30n }]
  const unsplit = [{ id: 'operator', stake: 600n }, { id: 'others', stake: 400n }]
  const split = [...Array.from({ length: 600 }, (_, i) => ({ id: 'node-' + i, stake: 1n })),
    { id: 'others', stake: 400n }]
  const examples = [
    { scenario: 'Founder 20% offline: remaining 80% can certify', ...certificateSupport(network, ['alice', 'bob']) },
    { scenario: 'Founder 40% offline: remaining 60% cannot certify', ...certificateSupport(concentrated, ['alice', 'bob']) },
    { scenario: 'One operator has 60% of stake', ...certificateSupport(unsplit, ['operator']) },
    { scenario: 'Same 60% split across 600 nodes', ...certificateSupport(split, split.slice(0, 600).map(x => x.id)) },
  ]
  console.log('Quorum arithmetic only. A certificate does not prove correct follower data or rewards.')
  console.log(JSON.stringify(examples, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
}
