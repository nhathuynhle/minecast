import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SUPPLY, DEV_PREMINE, MINING_BUDGET, FIRST_DAY_POOL,
  MIN_VALIDATOR_BOND, validatorCertificateSupport,
  miningPoolForDay, miningCeilingAfterDays, lifetimeCeilingAfterDays } from './bootstrap-model.mjs'
import { certificateSupport } from './quorum-model.mjs'

const UNIT = 10n ** 18n

test('2.1M dev premine is 0.01% inside 21B; zero completed days unlock no mining', () => {
  assert.equal(DEV_PREMINE, 2_100_000n * UNIT)
  assert.equal(DEV_PREMINE * 10000n, MAX_SUPPLY)
  assert.equal(MINING_BUDGET, 20_997_900_000n * UNIT)
  assert.equal(DEV_PREMINE + MINING_BUDGET, MAX_SUPPLY)
  assert.equal(miningCeilingAfterDays(0), 0n)
  assert.equal(lifetimeCeilingAfterDays(0), DEV_PREMINE)
})

test('mining starts at 104,989,500 and retains 99.5% each day', () => {
  assert.equal(FIRST_DAY_POOL, 104_989_500n * UNIT)
  assert.equal(miningPoolForDay(0), FIRST_DAY_POOL)
  assert.equal(miningPoolForDay(1), 104_464_552n * UNIT + UNIT / 2n)
  assert.equal(miningPoolForDay(2), 103_942_229n * UNIT + 7375n * UNIT / 10000n)
  assert.equal(miningPoolForDay(0) / 100n, 1_049_895n * UNIT)
})

test('budgets agree with independent rational arithmetic within one wei', () => {
  for (const day of [0n, 1n, 29n, 137n, 271n, 364n, 918n, 3650n, 12000n]) {
    const numerator = 199n ** day, denominator = 200n ** day
    const exactDaily = FIRST_DAY_POOL * numerator / denominator
    const exactCeiling = MINING_BUDGET - (MINING_BUDGET * numerator + denominator - 1n) / denominator
    assert.ok(miningPoolForDay(day) <= exactDaily)
    assert.ok(exactDaily - miningPoolForDay(day) <= 1n)
    assert.ok(miningCeilingAfterDays(day) >= exactCeiling)
    assert.ok(miningCeilingAfterDays(day) - exactCeiling <= 1n)
  }
})

test('premine plus all daily budgets cannot exceed lifetime cap', () => {
  let miningSum = 0n, previous = FIRST_DAY_POOL
  for (let day = 0; day < 20000; day++) {
    const pool = miningPoolForDay(day)
    assert.ok(pool <= previous)
    miningSum += pool
    assert.ok(miningSum <= miningCeilingAfterDays(day + 1))
    assert.ok(DEV_PREMINE + miningSum <= lifetimeCeilingAfterDays(day + 1))
    assert.ok(lifetimeCeilingAfterDays(day + 1) <= MAX_SUPPLY)
    previous = pool
  }
  assert.equal(previous, 0n)
  assert.ok(MINING_BUDGET - miningSum < 20000n)
  assert.equal(lifetimeCeilingAfterDays((1n << 256n) - 1n), MAX_SUPPLY)
})

test('fractional, unsafe, negative and out-of-uint256 days are rejected', () => {
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', null, 'x', 1n << 256n]) {
    assert.throws(() => miningPoolForDay(invalid))
    assert.throws(() => lifetimeCeilingAfterDays(invalid))
  }
})

test('AMM liquidity is not validator voting power', () => {
  // Only actual active bonds enter the snapshot. Pool balances are not stakes.
  const amount = 10_000_000n * UNIT
  const active = ['a', 'b', 'c'].map(id => ({ id, stake: amount }))
  const result = certificateSupport(active, ['a', 'b'])
  assert.equal(result.totalStake, 30_000_000n * UNIT)
  assert.equal(result.quorumReached, false) // Exactly 2/3 is not strictly more.
  assert.equal(certificateSupport(active, ['a', 'b', 'c']).quorumReached, true)
  assert.throws(() => certificateSupport(active, ['liquidityPool']), /Unknown/)
})

test('a sole dev operator holds 100% active weight, conditional on the explicit network minimum', () => {
  const result = validatorCertificateSupport([{ id: 'dev', stake: MIN_VALIDATOR_BOND }], ['dev'], MIN_VALIDATOR_BOND)
  assert.equal(result.quorumReached, true)
  assert.equal(result.signedStake, result.totalStake)
  assert.equal(DEV_PREMINE - MIN_VALIDATOR_BOND, 1_100_000n * UNIT)
  // This 1M network threshold is only a fixture. It remains unchosen for deployment.
})

test('validator admission rejects one wei below 1M but accepts the exact boundary', () => {
  assert.equal(MIN_VALIDATOR_BOND, 1_000_000n * UNIT)
  assert.throws(() => validatorCertificateSupport([{ id: 'a', stake: MIN_VALIDATOR_BOND - 1n }], ['a'], MIN_VALIDATOR_BOND), /at least 1,000,000/)
  assert.equal(validatorCertificateSupport([{ id: 'a', stake: MIN_VALIDATOR_BOND }], ['a'], MIN_VALIDATOR_BOND).quorumReached, true)
  const larger = MIN_VALIDATOR_BOND + 1n
  assert.equal(validatorCertificateSupport([{ id: 'a', stake: larger }], ['a'], MIN_VALIDATOR_BOND).signedStake, larger)
})

test('an individual minimum does not silently choose the network-wide minimum', () => {
  const snapshot = [{ id: 'a', stake: MIN_VALIDATOR_BOND }]
  assert.throws(() => validatorCertificateSupport(snapshot, ['a']), /explicit network minimum/)
  assert.throws(() => validatorCertificateSupport(snapshot, ['a'], 1n), /explicit network minimum/)
  const networkMinimumFixture = MIN_VALIDATOR_BOND * 10n
  assert.equal(validatorCertificateSupport(snapshot, ['a'], networkMinimumFixture).quorumReached, false)
})

test('210 hypothetical equal-size validators require 141 signatures', () => {
  // Arbitrary funded snapshot, not a promise that the initial pool can fund 210 nodes.
  const count = 210
  const totalBond = BigInt(count) * MIN_VALIDATOR_BOND
  const snapshot = Array.from({ length: count }, (_, i) => ({ id: String(i), stake: MIN_VALIDATOR_BOND }))
  const result = validatorCertificateSupport(snapshot, snapshot.slice(0, 140).map(x => x.id), totalBond)
  assert.equal(result.totalStake, totalBond)
  assert.equal(result.quorumReached, false)
  assert.equal(validatorCertificateSupport(snapshot, snapshot.slice(0, 141).map(x => x.id), totalBond).quorumReached, true)
})

test('splitting 1M into subminimum validator positions does not bypass admission', () => {
  const snapshot = [{ id: 'a', stake: MIN_VALIDATOR_BOND / 2n }, { id: 'b', stake: MIN_VALIDATOR_BOND / 2n }]
  assert.throws(() => validatorCertificateSupport(snapshot, ['a', 'b'], MIN_VALIDATOR_BOND), /at least 1,000,000/)
})
