export const DAY = 86400n
export type V4Session = { id: string; fid: number; wallet_address: string; cast_hash: string; day: number; started_at: string; ends_at: string;
  follower_count?: number | null; estimated_weight?: number | null; follower_observed_at?: string | null }
export type MiningDay = {
  day: bigint; digest: string; allocated: bigint; published: bigint; leafCount: bigint; totalWeight: bigint;
  certifiedAt: bigint; claimEnd: bigint; contested: boolean; fid: bigint; amount: bigint; claimed: boolean;
  pool: bigint; end: bigint; reviewPeriod: bigint; resultWindow: bigint; workWindow: bigint
}
export type MiningPhase = "mining" | "waiting" | "publishing" | "review" | "activate" | "claimable" | "claimed" | "expired" | "excluded" | "contested" | "missed"
export function miningPhase(d: MiningDay, timestamp: bigint, session?: V4Session): MiningPhase {
  if (d.claimed) return "claimed"
  if (d.claimEnd > 0n) {
    if (timestamp >= d.claimEnd) return "expired"
    return d.amount > 0n ? "claimable" : "excluded"
  }
  if (d.contested) return "contested"
  if (timestamp >= d.end + d.resultWindow) return "missed"
  if (session && timestamp < BigInt(Math.floor(Date.parse(session.ends_at) / 1000))) return "mining"
  if (d.certifiedAt === 0n) return "waiting"
  if (d.published < d.leafCount) return "publishing"
  return timestamp < d.certifiedAt + d.reviewPeriod ? "review" : "activate"
}
export function phaseDeadline(d: MiningDay, phase: MiningPhase, session?: V4Session) {
  if (phase === "mining" && session) return BigInt(Math.floor(Date.parse(session.ends_at) / 1000))
  if (phase === "review") return d.certifiedAt + d.reviewPeriod
  if (phase === "claimable") return d.claimEnd
  return 0n
}
export function monthAt(timestamp: bigint): bigint {
  const d = new Date(Number(timestamp) * 1000)
  return BigInt(d.getUTCFullYear() * 100 + d.getUTCMonth() + 1)
}
export function previousMonth(month: bigint): bigint { return month % 100n === 1n ? (month / 100n - 1n) * 100n + 12n : month - 1n }
export function monthStart(month: bigint): bigint { return BigInt(Date.UTC(Number(month / 100n), Number(month % 100n) - 1, 1) / 1000) }
export function validMonth(value: string): boolean { return /^\d{6}$/.test(value) && Number(value.slice(4)) >= 1 && Number(value.slice(4)) <= 12 }
export function tokens(value: bigint, decimals = 2): string {
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "")
  return whole.toLocaleString("en-US") + (fraction ? `.${fraction}` : "")
}
export function countdown(deadline: bigint, now: bigint): string {
  const seconds = deadline > now ? deadline - now : 0n
  return [seconds / 3600n, seconds / 60n % 60n, seconds % 60n].map(x => x.toString().padStart(2, "0")).join(":")
}
