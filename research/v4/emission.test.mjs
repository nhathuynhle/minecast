import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SUPPLY, BASE_DAILY_EMISSION, dailyEmissionForDay, releasedSupplyAfterDays } from './emission.mjs'
import { buildSnapshot } from './snapshot.mjs'

test('105M first day, 0.5% daily decay, no old halving boundary', () => {
  assert.equal(BASE_DAILY_EMISSION, 105_000_000n * 10n ** 18n)
  assert.equal(dailyEmissionForDay(0), BASE_DAILY_EMISSION)
  assert.equal(dailyEmissionForDay(1), 104_475_000n * 10n ** 18n)
  assert.equal(dailyEmissionForDay(2), 103_952_625n * 10n ** 18n)
  const difference = dailyEmissionForDay(271) * 199n / 200n - dailyEmissionForDay(272)
  assert.ok(difference >= -1n && difference <= 1n)
})

test('fixed-point budgets agree with an independent exact rational model within one wei', () => {
  for (const day of [0n, 1n, 29n, 59n, 137n, 138n, 271n, 272n, 364n, 729n, 918n, 1824n, 3650n, 12000n]) {
    const numerator = 199n ** day, denominator = 200n ** day
    const exactDaily = BASE_DAILY_EMISSION * numerator / denominator
    const daily = dailyEmissionForDay(day)
    assert.ok(daily <= exactDaily && exactDaily - daily <= 1n, 'daily rounding at ' + day)
    const exactReleased = MAX_SUPPLY - (MAX_SUPPLY * numerator + denominator - 1n) / denominator
    const released = releasedSupplyAfterDays(day)
    assert.ok(released >= exactReleased && released - exactReleased <= 1n, 'calendar rounding at ' + day)
  }
})

test('all daily budgets through the tail fit the calendar and 21B lifetime ceilings', () => {
  let total = 0n, previousDaily = BASE_DAILY_EMISSION, previousReleased = 0n
  for (let day = 0; day < 20000; day++) {
    const daily = dailyEmissionForDay(day)
    const released = releasedSupplyAfterDays(day + 1)
    total += daily
    assert.ok(daily <= previousDaily, 'daily increase at ' + day)
    assert.ok(released >= previousReleased && released <= MAX_SUPPLY, 'calendar ceiling at ' + day)
    assert.ok(total <= released, 'daily budgets exceed calendar at ' + day)
    previousDaily = daily
    previousReleased = released
  }
  assert.equal(previousDaily, 0n)
  assert.ok(MAX_SUPPLY - total < 20000n, 'only sub-token rounding dust remains')
  assert.equal(dailyEmissionForDay((1n << 256n) - 1n), 0n)
  assert.equal(releasedSupplyAfterDays((1n << 256n) - 1n), MAX_SUPPLY)
})

test('99% is reached at 919 completed days; invalid day inputs are rejected', () => {
  assert.ok(releasedSupplyAfterDays(918) < MAX_SUPPLY * 99n / 100n)
  assert.ok(releasedSupplyAfterDays(919) >= MAX_SUPPLY * 99n / 100n)
  assert.equal(releasedSupplyAfterDays(0), 0n)
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', 'wrong', null, 1n << 256n]) {
    assert.throws(() => dailyEmissionForDay(value))
    assert.throws(() => releasedSupplyAfterDays(value))
  }
})

test('snapshots use the correct day budget and keep the 1% cap even for node operators', () => {
  const wallet = '0x0000000000000000000000000000000000000001'
  const input = { chainId: 31337, distributor: wallet, miners: [{ fid: 1, wallet, followers: 2000 }] }
  for (const day of [0, 1, 272]) {
    const poolWei = dailyEmissionForDay(day)
    for (const verified of [new Map(), new Map([[1, wallet]])]) {
      const result = buildSnapshot({ ...input, day, poolWei }, verified)
      assert.equal(BigInt(result.allocated), poolWei / 100n)
      assert.equal(BigInt(result.claims[0].amount), poolWei / 100n)
    }
  }
  assert.throws(() => buildSnapshot({ ...input, day: 1, poolWei: BASE_DAILY_EMISSION }), /emission schedule/)
  assert.throws(() => buildSnapshot({ ...input, day: 0, poolWei: MAX_SUPPLY / 2n / 272n }), /emission schedule/)
})
