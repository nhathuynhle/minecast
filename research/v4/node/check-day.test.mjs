import assert from 'node:assert/strict'
import test from 'node:test'
import { compareDay } from './check-day.mjs'

const w = n => '0x' + String(n).padStart(2, '0').repeat(20)
const row = (n, followers = 1000, extra = {}) => ({ fid: BigInt(n), wallet: w(n), castHash: w(n + 50), followers: BigInt(followers), engagement: 16n, nodeWork: false, ...extra })

test('check-day flags fake rows, inflated tiers, missing miners and bonus mismatches; one tier step is tolerated', () => {
  const mine = [row(1), row(2, 1000), row(3), row(4)]
  const paid = [row(1), row(2, 2000), row(4, 1000, { nodeWork: true }), row(9, 100000)]
  const problems = Object.fromEntries(compareDay(mine, paid).map(i => [Number(i.fid), i.problem]))
  assert.deepEqual(Object.keys(problems).map(Number).sort(), [3, 4, 9])
  assert.match(problems[9], /cannot prove/)
  assert.match(problems[3], /left out/)
  assert.match(problems[4], /node bonus/)
  // 1,000 vs 2,000 is one tier step: allowed. 1,000 vs 100,000 is not.
  assert.equal(compareDay([row(5, 1000)], [row(5, 100000)]).length, 1)
  // Engagement too: 16 vs 25 is one step, 16 vs 100 is inflated.
  assert.equal(compareDay([row(6)], [row(6, 1000, { engagement: 25n })]).length, 0)
  assert.match(compareDay([row(6)], [row(6, 1000, { engagement: 100n })])[0].problem, /engaged accounts/)
  // While a day is only partly published, unpublished miners are not reported as left out.
  assert.equal(compareDay(mine, [row(1)], false).length, 0)
})
