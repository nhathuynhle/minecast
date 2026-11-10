import test from "node:test"
import assert from "node:assert/strict"
import { allocate, followerWeight } from "./allocation.mjs"

const alice = { fid: 1, wallet: "0x0000000000000000000000000000000000000001", followers: 1000 }
const bob = { fid: 2, wallet: "0x0000000000000000000000000000000000000002", followers: 2000 }

test("tier boundaries and invalid input", () => {
  assert.equal(followerWeight(999), 4n)
  assert.equal(followerWeight(1000), 6n)
  assert.equal(followerWeight(1999), 6n)
  assert.equal(followerWeight(2000), 10n)
  assert.equal(followerWeight(4999), 10n)
  assert.equal(followerWeight(100000), 100n)
  assert.throws(() => followerWeight(-1))
})
test("weighted allocation and rounding", () => {
  const result = allocate(10001n, 10000n, [alice, bob])
  assert.deepEqual(result.allocations.map(x => x.amount), [3750n, 6250n])
  assert.equal(result.remainder, 1n)
})
test("cap and empty day preserve unallocated supply", () => {
  const result = allocate(10000n, 1000n, [alice, bob])
  assert.equal(result.allocated, 2000n)
  assert.equal(result.remainder, 8000n)
  assert.equal(allocate(10n, 10n, []).remainder, 10n)
})
test("duplicate identity and wallet rejected", () => {
  assert.throws(() => allocate(100n, 100n, [alice, { ...bob, fid: 1 }]))
  assert.throws(() => allocate(100n, 100n, [alice, { ...bob, wallet: alice.wallet.toUpperCase().replace("0X", "0x") }]))
})

test("worker multiplier applies once to verified FID and wallet, with a combined 100x ceiling", () => {
  const verified = new Map([[alice.fid, alice.wallet]])
  for (const [followers, expected] of [[0, 5n], [500, 20n], [1000, 30n], [2000, 50n], [5000, 90n], [10000, 100n], [100000, 100n]]) {
    const result = allocate(1000n, 10n, [{ ...alice, followers }, { ...bob, node: true }], verified)
    assert.deepEqual(result.allocations.map(x => x.weight), [expected, 10n])
    assert.equal(result.allocated + result.remainder, 1000n)
    assert.equal(result.allocations[0].amount, 10n)
  }
  assert.equal(allocate(10n, 10n, [alice], new Map([[alice.fid, bob.wallet]])).allocations[0].weight, 6n)
})
