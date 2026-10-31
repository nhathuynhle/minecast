// ─── MineCast — Tokenomics Engine ─────────────────────────────────────────
// Project : MineCast
// Token   : $TOKENCAST on Base (chainId 8453)
// Supply  : 21,000,000,000 (21 billion — hard cap)

export const APP_NAME    = "MineCast"
export const TOKEN_NAME  = "TokenCast"
export const TOKEN_SYMBOL = "TOKENCAST"
export const CHAIN_NAME  = "Base"
export const CHAIN_ID    = 8453
export const DECIMALS    = 18

// ── Core tokenomics ───────────────────────────────────────────────────────

export const MAX_SUPPLY             = 21_000_000_000  // 21 Billion
export const SESSION_MS             = 24 * 60 * 60 * 1000 // 24 hours
export const INITIAL_SESSION_REWARD = 386.029411      // Assumes the 100,000 daily-miner target in Era 0
export const MAX_ERA                = 32
export const GENESIS_MS             = Date.UTC(2026, 3, 22, 0, 0, 0)

// ── Simulated network ─────────────────────────────────────────────────────

export const SIM_MINERS        = 420
export const SESSIONS_PER_DAY  = 3
export const SIM_DAILY_ERA0    = SIM_MINERS * SESSIONS_PER_DAY * INITIAL_SESSION_REWARD

const DAY_MS = 86_400_000

// ── Invite system ─────────────────────────────────────────────────────────

export const INVITE_REFERRAL_PCT = 0.08  // 8% referral commission for inviter
export const MAX_INVITE_FRIENDS  = 20    // Up to 20 friends
export const MAX_FOLLOWER_MULTIPLIER = 100

// ── Era & halving ─────────────────────────────────────────────────────────

export function sessionReward(era: number): number {
  const e = Math.max(0, Math.min(MAX_ERA, Math.floor(era)))
  return INITIAL_SESSION_REWARD / 2 ** e
}

export function supplyAtEraStart(era: number): number {
  if (era <= 0) return 0
  const e = Math.min(era, MAX_ERA)
  return MAX_SUPPLY * (1 - 2 ** -e)
}

export function eraFromMined(mined: number): number {
  if (mined <= 0) return 0
  const ratio = Math.min(1 - 1e-15, mined / MAX_SUPPLY)
  const era = Math.floor(-Math.log2(1 - ratio))
  if (!Number.isFinite(era) || era < 0) return 0
  return Math.min(MAX_ERA, era)
}

export function rewardFor(mined: number): { era: number; reward: number } {
  const safe = Math.max(0, Math.min(MAX_SUPPLY, mined))
  const era = eraFromMined(safe)
  const room = Math.max(0, MAX_SUPPLY - safe)
  return { era, reward: Math.min(sessionReward(era), room) }
}

export function simulatedMined(now: number): number {
  let left = Math.max(0, now - GENESIS_MS)
  let mined = 0
  for (let era = 0; era < MAX_ERA && left > 0; era++) {
    const perMs = SIM_DAILY_ERA0 / 2 ** era / DAY_MS
    const eraSupply = MAX_SUPPLY / 2 ** (era + 1)
    if (perMs <= 0) break
    const eraMs = eraSupply / perMs
    if (left < eraMs) return Math.min(MAX_SUPPLY, mined + left * perMs)
    mined += eraSupply
    left -= eraMs
  }
  return Math.min(MAX_SUPPLY, mined)
}

export function followerMultiplier(followers: number): number {
  const n = Math.max(0, Math.floor(followers))
  if (n >= 100_000) return 100
  if (n >= 50_000)  return 82
  if (n >= 25_000)  return 65
  if (n >= 10_000)  return 45
  if (n >= 5_000)   return 28
  if (n >= 2_000)   return 16
  if (n >= 1_000)   return 10
  if (n >= 500)     return 4
  if (n >= 10)      return 2
  return 1
}

export function nextHalving(mined: number): { at: number; nextReward: number } | null {
  const era = eraFromMined(mined)
  if (era >= MAX_ERA) return null
  return { at: supplyAtEraStart(era + 1), nextReward: sessionReward(era + 1) }
}

export function halvingEta(mined: number, now: number): number | null {
  const nh = nextHalving(mined)
  if (!nh) return null
  const era = eraFromMined(mined)
  const daily = SIM_DAILY_ERA0 / 2 ** era
  if (daily <= 0) return null
  const remaining = nh.at - mined
  const daysLeft = remaining / daily
  return now + daysLeft * DAY_MS
}

export function activeMiners(now: number, youMining: boolean): number {
  const date = new Date(now)
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  const wave = Math.cos(((hour - 13) / 24) * Math.PI * 2)
  return Math.round(340 + wave * 90) + (youMining ? 1 : 0)
}

export type FeedItem = { handle: string; text: string; ago: number }

const PEOPLE = [
  "minhdao", "lan.base", "khoicast", "tramng", "fieldnote",
  "basenight", "oreo", "halving", "cayena", "somcast",
]

const LINES = [
  "Opened a $TOKENCAST session on MineCast. Eight hours, no rig.",
  "Cast posted. The session runs until the clock hits zero.",
  "More followers, faster drip. Keeping the streak.",
  "Supply is walking toward the next halving.",
  "Proof of Cast on Base. One cast, one session.",
  "Night session. Miss the cast and you miss eight hours.",
  "Reward locks the moment you cast.",
  "Invited 3 friends. Mining speed goes brrr 🚀",
]

function mix(n: number): number {
  let x = n | 0
  x = Math.imul(x ^ (x >>> 16), 2246822507)
  x = Math.imul(x ^ (x >>> 13), 3266489909)
  return (x ^ (x >>> 16)) >>> 0
}

export function networkFeed(now: number): FeedItem[] {
  const bucket = Math.floor(now / 120_000)
  const items = Array.from({ length: 5 }, (_, i) => {
    const h = mix(bucket * 17 + i * 97 + 3)
    return {
      handle: PEOPLE[(h + i * 3) % PEOPLE.length] ?? "miner",
      text: LINES[(h + i) % LINES.length] ?? LINES[0],
      ago: ((h % 150) + 1) * 60_000,
    }
  })
  items.sort((a, b) => a.ago - b.ago)
  return items
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0"
  const abs = Math.abs(value)
  const digits = abs === 0 ? 0
    : abs < 0.0001 ? 8
    : abs < 0.01 ? 6
    : abs < 1 ? 2
    : abs < 1000 ? 2
    : 0
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatBalance(value: number, live: boolean): string {
  if (!Number.isFinite(value)) return "0"
  if (live && value > 0 && value < 100_000) {
    const digits = value < 0.01 ? 6 : value < 1 ? 4 : value < 100 ? 2 : 0
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  }
  return formatTokens(value)
}

export function formatSupply(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) {
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n / 1_000_000_000)}B`
  }
  if (abs >= 1_000_000) {
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n / 1_000_000)}M`
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)
}

export function formatPct(ratio: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Math.max(0, ratio) * 100)}%`
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":")
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

export function formatMult(n: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)}×`
}

export function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(ms))
}

export function generateInviteCode(handle: string): string {
  if (!handle || handle.length < 2) return ""
  let hash = 0
  for (let i = 0; i < handle.length; i++) {
    hash = Math.imul(31, hash) + handle.charCodeAt(i)
    hash |= 0
  }
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let code = ""
  let h = Math.abs(hash)
  for (let i = 0; i < 6; i++) {
    code += chars[h % chars.length]
    h = Math.floor(h / chars.length) + (i + 1) * 7
  }
  return code
}

export function inviteUrl(handle: string, baseUrl: string = "https://minecast-beta.vercel.app"): string {
  const code = generateInviteCode(handle)
  if (!code) return baseUrl
  return `${baseUrl}?ref=${handle}&code=${code}`
}

export const ISSUANCE_SPEC = `MineCast — $TOKENCAST
Chain: Base (chainId 8453)
Standard: ERC-20, 18 decimals
Max supply: 21,000,000,000 (21 billion), hard cap, no extra mint
Issuance: Proof of Cast
Session: 24 hours after each cast. Cast again when it ends.
Base reward: 386.029411 TOKENCAST per daily session at the 100,000-miner target
Halving: reward halves every 272 days. This targets ~99% planned issuance in 5 years.
Followers: verified tiers are 1×, 2×, 4×, 10×, 16×, 28×, 45×, 65×, 82×, 100×. Daily pool is divided by weight.
Creator cap: no wallet can claim more than the 100× benchmark for one 24-hour claim window; this cap halves with each era.
Invite: inviter earns an additional 8% of each qualified friend's session from the shared daily pool. The friend's reward is never reduced. Max 20 friends.
Unused daily allocation: reserved for the public Airdrop Treasury, subject to the finalisation window documented by the onchain deployment.
`
