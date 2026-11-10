import type { V4Config } from "./config"

export type V4LiveStats = { day: bigint; observedAt: number; activeMiners: bigint; cohortMiners: bigint; estimatedMiners: bigint; totalWeight: bigint }
function count(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw Error("Invalid live mining count.")
  return BigInt(value)
}
export function parseLiveStats(value: unknown, config: V4Config, day: bigint): V4LiveStats {
  const b = value as Record<string, unknown> | null
  if (!b || b.protocol !== "open-v4-quorum-1" || b.chainId !== config.chainId || typeof b.distributor !== "string"
    || b.distributor.toLowerCase() !== config.distributor.toLowerCase() || b.day !== Number(day)
    || b.scope !== "minecast-intake" || b.estimateBasis !== "follower-only" || b.authoritativeRewards !== false) throw Error("Live counts belong to another deployment or cohort.")
  const observedAt = typeof b.observed_at === "string" ? Date.parse(b.observed_at) : NaN
  if (!Number.isFinite(observedAt)) throw Error("Invalid live mining timestamp.")
  const result = { day, observedAt, activeMiners: count(b.active_miners), cohortMiners: count(b.cohort_miners),
    estimatedMiners: count(b.estimated_miners), totalWeight: count(b.total_weight) }
  if (result.estimatedMiners > result.cohortMiners || result.totalWeight < result.estimatedMiners
    || result.totalWeight > result.estimatedMiners * 100n) throw Error("Incomplete live mining weights.")
  return result
}

/** Informational full-session estimate, never a claim amount. Active miners do NOT divide a cohort pool. */
export function estimateV4Reward(pool: bigint, stats: V4LiveStats, minerWeight?: number | null): bigint | null {
  if (pool < 0n || !Number.isSafeInteger(minerWeight) || minerWeight! < 1 || minerWeight! > 100
    || stats.cohortMiners === 0n || stats.estimatedMiners !== stats.cohortMiners) return null
  const weight = BigInt(minerWeight!)
  if (stats.totalWeight < weight || stats.totalWeight === 0n) return null
  const proportion = pool * weight / stats.totalWeight
  return proportion < pool / 100n ? proportion : pool / 100n
}
