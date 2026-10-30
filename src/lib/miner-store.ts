import { personalReward, SESSION_MS, rewardFor, MAX_INVITE_FRIENDS, INVITE_REFERRAL_PCT } from "@/lib/tokenomics"

const KEY = "minecast.v3"

export type CastRecord = {
  id: string
  text: string
  at: number
  reward: number
  era: number
}

export type MiningSession = {
  startedAt: number
  endsAt: number
  reward: number
  era: number
  text: string
}

export type InvitedFriend = {
  handle: string
  joinedAt: number
}

export type MinerState = {
  handle: string
  payout: string
  followers: number
  followersLocked: boolean
  invitedBy: string
  invitedFriends: InvitedFriend[]
  balance: number
  session: MiningSession | null
  casts: CastRecord[]
}

export const EMPTY_MINER: MinerState = {
  handle: "",
  payout: "",
  followers: 0,
  followersLocked: false,
  invitedBy: "",
  invitedFriends: [],
  balance: 0,
  session: null,
  casts: [],
}

function isSession(value: unknown): value is MiningSession {
  if (!value || typeof value !== "object") return false
  const s = value as MiningSession
  return (
    typeof s.startedAt === "number" &&
    typeof s.endsAt === "number" &&
    typeof s.reward === "number" &&
    typeof s.era === "number" &&
    typeof s.text === "string"
  )
}

function isCast(value: unknown): value is CastRecord {
  if (!value || typeof value !== "object") return false
  const c = value as CastRecord
  return (
    typeof c.id === "string" &&
    typeof c.text === "string" &&
    typeof c.at === "number" &&
    typeof c.reward === "number" &&
    typeof c.era === "number"
  )
}

function isFriend(value: unknown): value is InvitedFriend {
  if (!value || typeof value !== "object") return false
  const f = value as InvitedFriend
  return typeof f.handle === "string" && typeof f.joinedAt === "number"
}

export function cleanHandle(input: string): string {
  return input
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 16)
}

export function validHandle(handle: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._]{0,14}[a-z0-9])?$/.test(handle) && handle.length >= 2
}

export function validPayout(addr: string): boolean {
  return addr === "" || /^0x[a-fA-F0-9]{40}$/.test(addr)
}

export function clampFollowers(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(10_000_000, Math.floor(n))
}

export function loadMiner(): MinerState {
  if (typeof window === "undefined") return EMPTY_MINER
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return EMPTY_MINER
    const parsed = JSON.parse(raw) as Partial<MinerState>
    return {
      handle: typeof parsed.handle === "string" ? cleanHandle(parsed.handle) : "",
      payout: typeof parsed.payout === "string" ? parsed.payout : "",
      followers: clampFollowers(parsed.followers),
      followersLocked: parsed.followersLocked === true,
      invitedBy: typeof parsed.invitedBy === "string" ? cleanHandle(parsed.invitedBy) : "",
      invitedFriends: Array.isArray(parsed.invitedFriends)
        ? parsed.invitedFriends.filter(isFriend).slice(0, MAX_INVITE_FRIENDS)
        : [],
      balance: typeof parsed.balance === "number" && parsed.balance >= 0 ? parsed.balance : 0,
      session: isSession(parsed.session) ? parsed.session : null,
      casts: Array.isArray(parsed.casts) ? parsed.casts.filter(isCast).slice(0, 12) : [],
    }
  } catch {
    return EMPTY_MINER
  }
}

export function saveMiner(state: MinerState): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(KEY, JSON.stringify(state))
}

export function accrued(session: MiningSession, now: number): number {
  if (now <= session.startedAt) return 0
  const span = session.endsAt - session.startedAt
  if (span <= 0) return 0
  const elapsed = Math.min(now, session.endsAt) - session.startedAt
  return session.reward * (elapsed / span)
}

export function settle(state: MinerState, now: number): MinerState {
  const session = state.session
  if (!session || now < session.endsAt) return state
  return {
    ...state,
    balance: state.balance + session.reward,
    session: null,
  }
}

export function openSession(
  state: MinerState,
  now: number,
  text: string,
  handle: string,
  mined: number,
  verifiedReward?: number,
  verifiedEra?: number,
): MinerState | null {
  if (state.session && now < state.session.endsAt) return null

  const followers = state.followers
  const wasInvited = state.invitedBy.length >= 2
  const friendsInvited = state.invitedFriends.length

  const reward = verifiedReward ?? personalReward(mined, followers, wasInvited, friendsInvited)
  if (reward <= 0) return null

  const { era: calculatedEra } = rewardFor(mined)
  const era = verifiedEra ?? calculatedEra
  const session: MiningSession = {
    startedAt: now,
    endsAt: now + SESSION_MS,
    reward,
    era,
    text,
  }
  const cast: CastRecord = {
    id: `c${now.toString(36)}`,
    text,
    at: now,
    reward,
    era,
  }
  return {
    ...state,
    handle,
    session,
    casts: [cast, ...state.casts].slice(0, 12),
  }
}

export function addInvitedFriend(state: MinerState, friendHandle: string): MinerState {
  const clean = cleanHandle(friendHandle)
  if (!validHandle(clean)) return state
  if (clean === state.handle) return state
  if (state.invitedFriends.length >= MAX_INVITE_FRIENDS) return state
  if (state.invitedFriends.some(f => f.handle === clean)) return state
  return {
    ...state,
    invitedFriends: [
      ...state.invitedFriends,
      { handle: clean, joinedAt: Date.now() },
    ],
  }
}

export function setInviter(state: MinerState, inviterHandle: string): MinerState {
  if (state.invitedBy) return state
  const clean = cleanHandle(inviterHandle)
  if (!validHandle(clean)) return state
  if (clean === state.handle) return state
  return { ...state, invitedBy: clean }
}
