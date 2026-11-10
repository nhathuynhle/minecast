// Open Node research budget: 2.1M dev premine (0.01%), optional liquidity later.
// Matches TokenCastOpenV4. Not wired to legacy TokenCastV4, snapshot.mjs or the live app.
import { pathToFileURL } from 'node:url'
import { formatUnits } from 'viem'
import { certificateSupport } from './quorum-model.mjs'

export const MAX_SUPPLY = 21_000_000_000n * 10n ** 18n
export const DEV_PREMINE = 2_100_000n * 10n ** 18n
export const MINING_BUDGET = MAX_SUPPLY - DEV_PREMINE
export const FIRST_DAY_POOL = MINING_BUDGET * 50n / 10_000n
export const MIN_VALIDATOR_BOND = 1_000_000n * 10n ** 18n
const PRECISION = 10n ** 36n
const RETENTION = PRECISION * 995n / 1000n
const MAX_DAY = (1n << 256n) - 1n

function dayCount(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('Invalid day')
  if (typeof value !== 'number' && typeof value !== 'bigint'
      && !(typeof value === 'string' && /^\d+$/.test(value))) throw new TypeError('Invalid day')
  const day = BigInt(value)
  if (day < 0n || day > MAX_DAY) throw new RangeError('Invalid day')
  return day
}

function factor(value) {
  let day = dayCount(value), result = PRECISION, base = RETENTION
  while (day !== 0n) {
    if ((day & 1n) !== 0n) result = result * base / PRECISION
    day >>= 1n
    if (day !== 0n) base = base * base / PRECISION
  }
  return result
}

export function miningPoolForDay(day) {
  return FIRST_DAY_POOL * factor(day) / PRECISION
}

export function miningCeilingAfterDays(days) {
  const remainingScaled = MINING_BUDGET * factor(days)
  return MINING_BUDGET - (remainingScaled + PRECISION - 1n) / PRECISION
}

// Includes the ONE-TIME dev premine, whether held, staked, sold, pooled, or burned.
// This is a maximum lifetime issuance allowance, not actual totalSupply/balance.
export function lifetimeCeilingAfterDays(days) {
  return DEV_PREMINE + miningCeilingAfterDays(days)
}

// Snapshot admission model only. The caller supplies already active, funded positions.
// The generic model keeps the minimum explicit. Open V4 Quorum fixes it at 1M.
// Do not reconstruct a past snapshot from current balances after withdrawal/slashing.
export function validatorCertificateSupport(snapshot, signerIds, minimumTotalBond) {
  if (typeof minimumTotalBond !== 'bigint' || minimumTotalBond < MIN_VALIDATOR_BOND) {
    throw new Error('An explicit network minimum at least as large as one validator bond is required')
  }
  if (!Array.isArray(snapshot)) throw new TypeError('Invalid snapshot')
  for (const entry of snapshot) {
    if (!entry || typeof entry.stake !== 'bigint' || entry.stake < MIN_VALIDATOR_BOND) {
      throw new Error('Validator bond must be at least 1,000,000 TOKENCAST')
    }
  }
  return certificateSupport(snapshot, signerIds, minimumTotalBond)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  const rows = (args.length ? args : [1, 2, 3, 30, 365, 919]).map(value => {
    const day = dayCount(value)
    if (day === 0n) throw new RangeError('CLI day numbers start at 1')
    const pool = miningPoolForDay(day - 1n)
    return { day: day.toString(), poolTokens: formatUnits(pool, 18),
      maxMinerTokens: formatUnits(pool / 100n, 18),
      miningBudgetUnlocked: formatUnits(miningCeilingAfterDays(day), 18),
      lifetimeBudgetIncludingPremine: formatUnits(lifetimeCeilingAfterDays(day), 18) }
  })
  console.log(JSON.stringify({ researchOnly: true,
    devPremineTokens: formatUnits(DEV_PREMINE, 18),
    initialLiquidityRequired: false,
    liquidityNetwork: 'Base',
    liquidityPairAsset: 'ETH',
    initialEthAmount: null, // Optional future liquidity is not funded or priced by this model.
    minimumValidatorBondTokens: formatUnits(MIN_VALIDATOR_BOND, 18),
    miningBudgetTokens: formatUnits(MINING_BUDGET, 18), days: rows }, null, 2))
}
