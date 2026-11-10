// Integer-accurate companion to TokenCastV4. Day 0 is the first mining day.
import { pathToFileURL } from 'node:url'
import { formatUnits } from 'viem'

export const MAX_SUPPLY = 21_000_000_000n * 10n ** 18n
export const DAILY_DECAY_BPS = 50n
export const BASE_DAILY_EMISSION = MAX_SUPPLY * DAILY_DECAY_BPS / 10_000n
const PRECISION = 10n ** 36n
const RETENTION = PRECISION * (10_000n - DAILY_DECAY_BPS) / 10_000n
const MAX_DAY = (1n << 256n) - 1n

function dayCount(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('Invalid day')
  if (typeof value !== 'number' && typeof value !== 'bigint'
    && !(typeof value === 'string' && /^\d+$/.test(value))) throw new TypeError('Invalid day')
  const day = BigInt(value)
  if (day < 0n || day > MAX_DAY) throw new RangeError('Invalid day')
  return day
}

function decayFactor(value) {
  let day = dayCount(value), factor = PRECISION, base = RETENTION
  while (day !== 0n) {
    if ((day & 1n) !== 0n) factor = factor * base / PRECISION
    day >>= 1n
    if (day !== 0n) base = base * base / PRECISION
  }
  return factor
}

export function dailyEmissionForDay(day) {
  return BASE_DAILY_EMISSION * decayFactor(day) / PRECISION
}

export function releasedSupplyAfterDays(days) {
  const remainingScaled = MAX_SUPPLY * decayFactor(days)
  return MAX_SUPPLY - (remainingScaled + PRECISION - 1n) / PRECISION
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  const days = args.length ? args : [1, 2, 30, 60, 365, 730, 919]
  const rows = days.map(value => {
    const day = dayCount(value)
    if (day === 0n) throw new RangeError('CLI day numbers start at 1')
    const pool = dailyEmissionForDay(day - 1n)
    return { day: day.toString(), poolTokens: formatUnits(pool, 18),
      maxMinerTokens: formatUnits(pool / 100n, 18),
      calendarBudgetTokens: formatUnits(releasedSupplyAfterDays(day), 18) }
  })
  console.log(JSON.stringify(rows, null, 2))
}
