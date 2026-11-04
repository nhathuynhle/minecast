import test from "node:test"
import assert from "node:assert/strict"
import { allocate, followerWeight } from "./allocation.mjs"

const alice = { fid: 1, wallet: "0x0000000000000000000000000000000000000001", followers: 1000 }
const bob = { fid: 2, wallet: "0x0000000000000000000000000000000000000002", followers: 2000 }

test("tier boundaries and invalid input", () => {
  assert.equal(followerWeight(999), 4n)
  assert.equal(followerWeight(1000), 10n)
  assert.equal(followerWeight(100000), 100n)
  assert.throws(() => followerWeight(-1))
})
test("weighted allocation and rounding", () => {
  const result = allocate(10000n, 10000n, [alice, bob])
  assert.deepEqual(result.allocations.map(x => x.amount), [3846n, 6153n])
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
