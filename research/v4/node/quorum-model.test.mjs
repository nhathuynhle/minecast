import test from 'node:test'
import assert from 'node:assert/strict'
import { certificateSupport, conflictingSigners } from './quorum-model.mjs'

test('strict quorum boundary, including exact two thirds and large integers', () => {
  const snapshot = [{ id: 'a', stake: 66n }, { id: 'b', stake: 1n }, { id: 'c', stake: 33n }]
  assert.equal(certificateSupport(snapshot, ['a']).quorumReached, false)
  assert.equal(certificateSupport(snapshot, ['a', 'b']).quorumReached, true)
  for (const scale of [1n, 10n ** 30n]) {
    assert.equal(certificateSupport([{ id: 'a', stake: 2n * scale }, { id: 'b', stake: scale }], ['a']).quorumReached, false)
  }
})

test('offline validators stay in the snapshot denominator', () => {
  const result = certificateSupport([{ id: 'online', stake: 20n }, { id: 'offline', stake: 80n }], ['online'])
  assert.equal(result.totalStake, 100n)
  assert.equal(result.quorumReached, false)
})

test('splitting one operator into 600 nodes does not increase its power', () => {
  const before = certificateSupport([{ id: 'a', stake: 600n }, { id: 'b', stake: 400n }], ['a'])
  const nodes = Array.from({ length: 600 }, (_, i) => ({ id: String(i), stake: 1n }))
  const after = certificateSupport([...nodes, { id: 'b', stake: 400n }], nodes.map(x => x.id))
  assert.deepEqual(after, before)
  assert.equal(after.quorumReached, false)
})

test('duplicate or unknown signers cannot manufacture voting weight', () => {
  const snapshot = [{ id: 'a', stake: 40n }, { id: 'b', stake: 60n }]
  assert.throws(() => certificateSupport(snapshot, ['a', 'a']), /duplicate signer/)
  assert.throws(() => certificateSupport(snapshot, ['unknown']), /Unknown/)
  assert.throws(() => certificateSupport([...snapshot, snapshot[0]], ['a']), /snapshot/)
})

test('empty or insufficiently bonded networks cannot bootstrap a certificate', () => {
  assert.equal(certificateSupport([], []).quorumReached, false)
  const result = certificateSupport([{ id: 'a', stake: 99n }], ['a'], 100n)
  assert.equal(result.enoughBond, false)
  assert.equal(result.quorumReached, false)
})

test('two conflicting quorums expose over one third overlapping stake in this fixture', () => {
  const snapshot = [{ id: 'a', stake: 40n }, { id: 'b', stake: 30n }, { id: 'c', stake: 30n }]
  const first = ['a', 'b'], second = ['a', 'c']
  assert.equal(certificateSupport(snapshot, first).quorumReached, true)
  assert.equal(certificateSupport(snapshot, second).quorumReached, true)
  const overlap = conflictingSigners(first, second)
  assert.deepEqual(overlap, ['a'])
  assert.ok(certificateSupport(snapshot, overlap).signedStake * 3n > 100n)
})

test('founder shutdown depends on its stake share, not just other node count', () => {
  const remaining = ['b', 'c']
  assert.equal(certificateSupport([{ id: 'a', stake: 20n }, { id: 'b', stake: 40n }, { id: 'c', stake: 40n }], remaining).quorumReached, true)
  assert.equal(certificateSupport([{ id: 'a', stake: 40n }, { id: 'b', stake: 30n }, { id: 'c', stake: 30n }], remaining).quorumReached, false)
})

test('supermajority support alone says nothing about report truth', () => {
  // There is deliberately no root/data/proof argument. Never use this model as a verifier.
  const result = certificateSupport([{ id: 'colluding', stake: 70n }, { id: 'honest', stake: 30n }], ['colluding'])
  assert.equal(result.quorumReached, true)
})
