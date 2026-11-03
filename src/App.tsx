import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Gem, Layers, Radio, Send, Users, X, Copy, Check, Share2, Wallet, ExternalLink, Loader2, RefreshCw, ShieldCheck, Vote } from "lucide-react"
import { formatUnits } from "viem"
import { bootFarcaster, composeOnFarcaster, connectFarcasterWallet, farcasterFetch, type FarcasterIdentity } from "@/lib/farcaster"
import {
  accrued,
  cleanHandle,
  EMPTY_MINER,
  loadMiner,
  openSession,
  saveMiner,
  settle,
  validHandle,
  validPayout,
  addInvitedFriend,
  setInviter,
  type MinerState,
} from "@/lib/miner-store"
import {
  activeMiners,
  APP_NAME,
  formatAgo,
  formatBalance,
  formatClock,
  formatPct,
  formatSupply,
  formatTokens,
  formatWhen,
  GENESIS_MS,
  halvingEta,
  INITIAL_SESSION_REWARD,
  INVITE_REFERRAL_PCT,
  inviteUrl,
  generateInviteCode,
  ISSUANCE_SPEC,
  MAX_INVITE_FRIENDS,
  MAX_SUPPLY,
  networkFeed,
  rewardFor,
  SESSION_MS,
  SIM_DAILY_ERA0,
  SIM_MINERS,
  simulatedMined,
  sessionReward,
  supplyAtEraStart,
  TOKEN_SYMBOL,
} from "@/lib/tokenomics"
import { executeClaimOnBase, type ClaimStatus } from "@/lib/web3-claim"
import { TOKENCAST_CHAIN_ID, TOKENCAST_CONTRACT_ADDRESS, TOKENCAST_IS_DEPLOYED } from "@/lib/contract"
import { basescanUrl, readOnchainSnapshot, type OnchainSnapshot } from "@/lib/onchain"
import { DAO_IS_DEPLOYED, STAKING_IS_CONFIGURED, castDaoVote, readDaoProposals, readTotalStaked, type DaoProposal } from "@/lib/governance"

type Tab = "mine" | "invite" | "network" | "token" | "dao" | "admin"

type AdminDashboardData = {
  generatedAt: string
  metrics: {
    miners: number
    activeSessions: number
    settledSessions: number
    claimedAllocations: number
    availableWei: string
    voucherWei: string
    claimedWei: string
  }
  miners: Array<{ fid: number; username: string | null; wallet_address: string | null; follower_count: number; created_at: string }>
  sessions: Array<{ id: string; fid: number; wallet_address: string; reward_wei: string; reward_weight: string; started_at: string; ends_at: string; settled_at: string | null }>
  claims: Array<{ id: string; fid: number; wallet_address: string; amount_wei: string; status: string; created_at: string }>
}

const STEPS = [
  {
    title: "Cast to Start",
    body: "Post a cast to start a mining session. On Warpcast, it posts directly to your profile.",
  },
  {
    title: "24-Hour Session",
    body: "Tokens drip throughout the day. One verified cast starts one daily mining session.",
  },
  {
    title: "Halving Schedule",
    body: "21 Billion hard cap. Rewards halve every 272 days, so miner growth cannot accelerate halvings.",
  },
  {
    title: "Invite Squad",
    body: "Invite qualifying creators. Earn an 8% referral bonus without reducing their mining reward.",
  },
]

export default function App() {
  const [tab, setTab] = useState<Tab>("mine")
  const [now, setNow] = useState<number | null>(null)
  const [miner, setMiner] = useState<MinerState>(EMPTY_MINER)
  const [ready, setReady] = useState(false)
  const [composer, setComposer] = useState(false)
  const [notice, setNotice] = useState("")
  const [claimGate, setClaimGate] = useState<"checking" | "active" | "claim" | "cast" | "error">("checking")
  const [claimAmount, setClaimAmount] = useState("0")
  const [claimEndsAt, setClaimEndsAt] = useState<string | null>(null)
  const [gateBusy, setGateBusy] = useState(false)
  const [claimSucceeded, setClaimSucceeded] = useState(false)
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>("idle")
  const [farcasterIdentity, setFarcasterIdentity] = useState<FarcasterIdentity | null>(null)
  const minerRef = useRef(miner)
  minerRef.current = miner

  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const ref = params.get("ref")
    if (ref) {
      setMiner((current) => setInviter(current, ref))
      const url = new URL(window.location.href)
      url.searchParams.delete("ref")
      url.searchParams.delete("code")
      window.history.replaceState({}, "", url.pathname)
    }
  }, [])

  useEffect(() => {
    const stored = settle(loadMiner(), Date.now())
    // Local storage may keep balances/session UI, but never an identity.
    setMiner({ ...stored, handle: "" })
    setReady(true)
    const tick = () => {
      const t = Date.now()
      setNow(t)
      setMiner((current) => {
        const completed = Boolean(current.session && t >= current.session.endsAt)
        const next = settle(current, t)
        if (completed) {
          void farcasterFetch("/api/mine/settle", { method: "POST" })
            .catch(() => undefined)
        }
        return next === current ? current : next
      })
    }
    tick()
    const id = window.setInterval(tick, 1000)
    bootFarcaster().then((identity) => {
      if (!identity) return
      const username = cleanHandle(identity.username)
      if (!validHandle(username)) return
      setFarcasterIdentity({ ...identity, username })
      // Never preserve a browser-entered or cached identity. The SDK context is
      // the only source of truth for the signed-in miner shown in the UI.
      setMiner((current) => ({ ...current, handle: username }))
      void farcasterFetch("/api/mine/settle", { method: "POST" })
        .catch(() => undefined)
    })
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!ready) return
    saveMiner(miner)
  }, [miner, ready])

  const clock = now ?? GENESIS_MS
  const session = miner.session
  const mining = Boolean(session && now !== null && now < session.endsAt)
  const pending = session && now ? accrued(session, now) : 0
  const shownBalance = miner.balance + (mining ? pending : 0)
  const networkMined = Math.min(MAX_SUPPLY, simulatedMined(clock) + miner.balance + (mining ? pending : 0))
  const quote = rewardFor(networkMined)
  const remain = mining && session && now ? session.endsAt - now : SESSION_MS

  function setPayout(value: string) {
    const next = value.trim()
    setMiner((current) => ({ ...current, payout: next }))
  }

  async function refreshClaimGate() {
    setClaimGate("checking")
    try {
      const response = await farcasterFetch("/api/mine/eligibility")
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Unable to check your reward.")
      setClaimAmount(data.amountWei || "0")
      setClaimEndsAt(typeof data.endsAt === "string" ? data.endsAt : null)
      setClaimGate(data.eligible ? "cast" : data.reason === "active_session" ? "active" : "claim")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to check your reward.")
      setClaimGate("error")
    }
  }

  return (
    <div className="min-h-dvh bg-[#0b0f17] text-[#f3f4f6]">
      <div className="h-1 bg-[#8a63d2]" />
      <div className="mx-auto max-w-6xl px-4 pt-5 pb-28 lg:pt-8 lg:pb-12">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Mark />
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white">{APP_NAME}</h1>
              <p className="text-sm text-gray-400">Cast once. Mine for 24 hours.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setTab("dao")} className="flex h-10 items-center gap-2 rounded-xl border border-[#8a63d2]/40 px-3 text-sm font-semibold text-[#c4b5fd] hover:bg-[#8a63d2]/10">
              <Vote className="size-4" /> DAO
            </button>
            <p className="rounded-xl bg-[#8a63d2]/20 px-3 py-2 text-sm font-semibold text-[#a78bfa]">Base</p>
          </div>
        </header>

        <div className="mt-5 grid items-start gap-4 lg:grid-cols-5">
          <div className={`${tab === "mine" ? "" : "hidden lg:block"} lg:col-span-2`}>
            <MineCard
              handle={miner.handle}
              identityVerified={Boolean(farcasterIdentity)}
              era={now ? quote.era : 0}
              balance={shownBalance}
              live={mining}
              remain={remain}
              mining={mining}
              reward={mining && session ? session.reward : quote.reward}
              hourly={(mining && session ? session.reward : quote.reward) / 24}
              halvingRatio={halvingRatio(networkMined)}
              castText={mining && session ? session.text : ""}
              onCast={() => {
                setNotice("")
                setClaimSucceeded(false)
                setClaimStatus("idle")
                void refreshClaimGate()
                setComposer(true)
              }}
            />
            <ol className="mt-4 grid gap-2">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-3 rounded-2xl border border-gray-800 bg-[#141b26] px-3 py-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#8a63d2]/20 text-sm font-semibold text-[#a78bfa]">
                    {index + 1}
                  </span>
                  <span>
                    <span className="block font-semibold text-white">{step.title}</span>
                    <span className="mt-0.5 block text-sm text-gray-400">{step.body}</span>
                  </span>
                </li>
              ))}
            </ol>
            <YourCasts casts={miner.casts} now={now} />
          </div>

          <div className={`${tab === "mine" ? "hidden lg:grid" : "grid"} gap-4 lg:col-span-3`}>
            {tab === "invite" || tab === "mine" ? (
              <div className={tab === "mine" ? "hidden lg:block" : ""}>
                <InvitePanel
                  handle={miner.handle}
                  invitedBy={miner.invitedBy}
                  friends={miner.invitedFriends}
                  onAddFriend={(h) => setMiner((c) => addInvitedFriend(c, h))}
                  onSetInviter={(h) => setMiner((c) => setInviter(c, h))}
                  now={now}
                />
              </div>
            ) : null}
            <div className={tab === "token" || tab === "invite" || tab === "dao" ? "hidden lg:block" : ""}>
              <NetworkPanel
                now={now}
                mined={networkMined}
                mining={mining}
                handle={miner.handle}
                castText={session?.text ?? ""}
                castAt={session?.startedAt ?? null}
              />
            </div>
            <div className={tab === "network" || tab === "invite" || tab === "dao" ? "hidden lg:block" : ""}>
              <TokenPanel
                balance={shownBalance}
                payout={miner.payout}
                onPayout={setPayout}
                era={quote.era}
                reward={quote.reward}
              />
            </div>
            {tab === "dao" ? <DaoPanel /> : null}
          </div>
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-800 bg-[#0b0f17]/95 backdrop-blur lg:hidden">
        <div className="mx-auto grid max-w-lg grid-cols-5">
          <NavButton active={tab === "mine"} onClick={() => setTab("mine")} label="Mine" icon={<Gem className="size-5" />} />
          <NavButton active={tab === "invite"} onClick={() => setTab("invite")} label="Squad" icon={<Users className="size-5" />} />
          <NavButton active={tab === "network"} onClick={() => setTab("network")} label="Network" icon={<Radio className="size-5" />} />
          <NavButton active={tab === "token"} onClick={() => setTab("token")} label="Token" icon={<Layers className="size-5" />} />
          <NavButton active={tab === "dao"} onClick={() => setTab("dao")} label="DAO" icon={<Vote className="size-5" />} />
        </div>
      </nav>

      {composer ? (
        <Composer
          era={quote.era}
          reward={quote.reward}
          onClose={() => setComposer(false)}
          notice={notice}
          claimGate={claimGate}
          claimAmount={claimAmount}
          claimEndsAt={claimEndsAt}
          gateBusy={gateBusy}
          claimSucceeded={claimSucceeded}
          claimStatus={claimStatus}
          onRetry={() => void refreshClaimGate()}
          onClaim={async () => {
            setGateBusy(true)
            setNotice("")
            setClaimSucceeded(false)
            setClaimStatus("idle")
            setClaimGate("checking")
            try {
              const wallet = await connectFarcasterWallet(TOKENCAST_CHAIN_ID)
              setPayout(wallet)
              await executeClaimOnBase({ userAddress: wallet as `0x${string}`, onStatusChange: (status, message) => {
                setClaimStatus(status)
                if (status === "success") {
                  setClaimSucceeded(true)
                  setNotice("")
                } else if (message) setNotice(message)
              } })
              await refreshClaimGate()
            } catch (error) {
              const message = error instanceof Error ? error.message : "Claim failed. Please try again."
              // A prior Base transaction can already have consumed the voucher
              // while the browser retained an old claim button. Re-check the
              // server ledger instead of leaving a misleading, stale button.
              if (/No settled mining reward|Claim nonce is stale/i.test(message)) {
                await refreshClaimGate()
                setClaimSucceeded(true)
                setClaimStatus("success")
                setNotice("")
              } else {
                setClaimStatus("error")
                setNotice(message)
              }
            } finally { setGateBusy(false) }
          }}
          onNotice={setNotice}
          onPublish={async (text) => {
            const current = minerRef.current
            const handle = cleanHandle(farcasterIdentity?.username ?? "")
            if (!farcasterIdentity || !validHandle(handle)) {
              setNotice("Open MineCast inside Farcaster to verify your miner identity.")
              return false
            }
            const eligibility = await farcasterFetch("/api/mine/eligibility")
            const eligibilityData = await eligibility.json()
            if (!eligibility.ok || !eligibilityData.eligible) {
              setNotice(eligibilityData.error || "Claim your previous settled reward before posting another mining cast.")
              return false
            }
            const posted = await composeOnFarcaster(text)
            if (posted.status !== "posted" || !posted.hash) {
              setNotice("Composer was closed before posting. Session not started.")
              return false
            }
            const wallet = minerRef.current.payout
            if (!validPayout(wallet) || !wallet) {
              setNotice("Connect your Base wallet before starting a mining session.")
              return false
            }
            const serverResponse = await farcasterFetch("/api/mine/start", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ castHash: posted.hash, walletAddress: wallet, referrerHandle: current.invitedBy }),
            })
            if (!serverResponse.ok) {
              const data = await serverResponse.json().catch(() => ({}))
              setNotice(data.error || "The server could not verify this cast.")
              return false
            }
            const verified = await serverResponse.json()
            const verifiedReward = Number(BigInt(verified.rewardWei) / 10n ** 18n)
            const verifiedEndsAt = Date.parse(verified.endsAt)
            const verifiedEra = Number(verified.era)
            if (!Number.isFinite(verifiedReward) || verifiedReward <= 0 || !Number.isFinite(verifiedEndsAt) || !Number.isInteger(verifiedEra) || verifiedEra < 0) {
              setNotice("The server returned an invalid mining session.")
              return false
            }
            const t = Date.now()
            const settled = settle({ ...minerRef.current, handle }, t)
            const mined = Math.min(MAX_SUPPLY, simulatedMined(t) + settled.balance)
            const next = openSession(settled, t, text, handle, mined, verifiedReward, verifiedEra)
            if (!next) {
              setNotice("Max supply reached. No more tokens available to mine.")
              return false
            }
            setMiner({ ...next, session: next.session ? { ...next.session, endsAt: verifiedEndsAt } : null })
            setNow(t)
            setTab("mine")
            return true
          }}
        />
      ) : null}
    </div>
  )
}

function halvingRatio(mined: number): number {
  const era = rewardFor(mined).era
  const start = supplyAtEraStart(era)
  const end = supplyAtEraStart(era + 1)
  const span = end - start
  if (span <= 0) return 1
  return Math.min(1, Math.max(0, (mined - start) / span))
}

function Mark() {
  return (
    <img src="/tokencast-logo.png" alt="MineCast" width={44} height={44} className="size-11 shrink-0 rounded-lg object-cover" />
  )
}

function MineCard({
  handle,
  identityVerified,
  era,
  balance,
  live,
  remain,
  mining,
  reward,
  hourly,
  halvingRatio: ratio,
  castText,
  onCast,
}: {
  handle: string
  identityVerified: boolean
  era: number
  balance: number
  live: boolean
  remain: number
  mining: boolean
  reward: number
  hourly: number
  halvingRatio: number
  castText: string
  onCast: () => void
}) {
  const ring = mining ? remain / SESSION_MS : 1
  return (
    <section className="rounded-2xl border border-gray-800 bg-[#141b26] p-5">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="text-sm text-gray-400">Verified Miner</span>
          <span className="mt-1 flex h-12 items-center gap-1 rounded-xl border border-gray-700 bg-[#0b0f17] px-3">
            <span className="text-gray-400" aria-hidden>@</span>
            <span aria-label="Verified Farcaster Handle" className="min-w-0 flex-1 truncate text-base text-white">
              {handle || "connect-in-farcaster"}
            </span>
            <ShieldCheck className={`size-4 shrink-0 ${identityVerified ? "text-green-400" : "text-gray-600"}`} aria-label={identityVerified ? "Farcaster identity verified" : "Farcaster identity unavailable"} />
          </span>
        </div>
        <div className="pb-1 text-right">
          <p className="text-sm text-gray-400">Era</p>
          <p className="text-2xl font-semibold tabular-nums text-white">{era}</p>
        </div>
      </div>

      <div className="mt-6 flex flex-col items-center">
        <SessionRing progress={ring} label={formatClock(remain)} caption={mining ? "remaining" : "per session"} />
        <p className="mt-4 flex items-center gap-2 text-sm text-gray-400">
          {mining ? <span className="live-dot size-2 rounded-full bg-[#8a63d2]" aria-hidden /> : null}
          {mining ? "Mining Active" : "No Active Session"}
        </p>
        <p className="mt-1 text-4xl font-semibold tabular-nums tracking-tight text-[#a78bfa]">
          {formatBalance(balance, live)}
        </p>
        <p className="text-sm font-medium text-gray-400">{TOKEN_SYMBOL}</p>
        {castText ? <p className="mt-3 line-clamp-2 text-center text-sm text-gray-400">"{castText}"</p> : null}
      </div>

      {mining ? (
        <p className="mt-6 flex h-12 items-center justify-center rounded-xl bg-[#0b0f17] text-sm text-gray-400">
          Session in progress · Wait to recast
        </p>
      ) : (
        <button
          type="button"
          onClick={onCast}
          className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] text-base font-semibold text-white transition hover:bg-[#7c52c8]"
        >
          <Send className="size-4" />
          Cast to Mine
        </button>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-2">
        <Stat label="Reward" value={formatTokens(reward)} unit="per session" />
        <Stat label="Rate" value={formatTokens(hourly)} unit="per hour" />
        <Stat label="Progress" value={formatPct(ratio)} unit="to halving" />
      </dl>
    </section>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-xl bg-[#0b0f17] px-2 py-2 text-center">
      <dt className="text-sm text-gray-400">{label}</dt>
      <dd className="mt-1 font-semibold tabular-nums text-white">{value}</dd>
      <dd className="text-sm text-gray-400">{unit}</dd>
    </div>
  )
}

function SessionRing({ progress, label, caption }: { progress: number; label: string; caption: string }) {
  const r = 54
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.max(0, Math.min(1, progress)))
  return (
    <div className="relative grid size-40 place-items-center" aria-label={`${caption} ${label}`}>
      <svg viewBox="0 0 128 128" className="size-40">
        <circle cx="64" cy="64" r={r} fill="none" stroke="#1f2937" strokeWidth="8" />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke="#8a63d2"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="ring-arc"
          transform="rotate(-90 64 64)"
        />
      </svg>
      <div className="absolute text-center">
        <p className="text-xl font-semibold tabular-nums text-white">{label}</p>
        <p className="text-sm text-gray-400">{caption}</p>
      </div>
    </div>
  )
}

function InvitePanel({
  handle,
  invitedBy,
  friends,
  onAddFriend,
  onSetInviter,
  now,
}: {
  handle: string
  invitedBy: string
  friends: MinerState["invitedFriends"]
  onAddFriend: (handle: string) => void
  onSetInviter: (handle: string) => void
  now: number | null
}) {
  const [copied, setCopied] = useState(false)
  const [friendInput, setFriendInput] = useState("")
  const [inviterInput, setInviterInput] = useState("")
  const code = handle ? generateInviteCode(handle) : ""
  const link = handle ? inviteUrl(handle) : ""
  const hasHandle = validHandle(handle)

  return (
    <section className="rounded-2xl border border-gray-800 bg-[#141b26] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Invite Squad</h2>
          <p className="mt-1 text-sm text-gray-400">
            Invite friends to mine together. Earn {Math.round(INVITE_REFERRAL_PCT * 100)}% bonus from each of their sessions.
            Their Farcaster account must have at least 100 followers to qualify. Max {MAX_INVITE_FRIENDS} squad members.
          </p>
        </div>
        <span className="shrink-0 rounded-xl bg-[#8a63d2]/20 px-3 py-1.5 text-sm font-semibold text-[#a78bfa]">
          {friends.length}/{MAX_INVITE_FRIENDS}
        </span>
      </div>

      {hasHandle ? (
        <div className="mt-5">
          <p className="text-sm text-gray-400">Your Referral Code</p>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex h-12 flex-1 items-center rounded-xl border border-gray-700 bg-[#0b0f17] px-3">
              <span className="text-lg font-bold tracking-widest text-[#a78bfa]">{code}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(
                  () => { setCopied(true); window.setTimeout(() => setCopied(false), 2000) },
                  () => setCopied(false),
                )
              }}
              className="flex h-12 items-center gap-2 rounded-xl border border-gray-700 bg-[#0b0f17] px-4 text-sm font-semibold text-white transition hover:bg-gray-800"
            >
              {copied ? <Check className="size-4 text-green-400" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy Link"}
            </button>
          </div>
          <p className="mt-2 break-all text-xs text-gray-400">{link}</p>

          {"share" in navigator ? (
            <button
              type="button"
              onClick={() => {
                void navigator.share?.({
                  title: `Mine $TOKENCAST with me on MineCast!`,
                  text: `Use my code ${code} to join MineCast. Qualified referrals support the creator community.`,
                  url: link,
                })
              }}
              className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] text-base font-semibold text-white transition hover:bg-[#7c52c8]"
            >
              <Share2 className="size-4" />
              Share Invite Link
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 rounded-xl bg-[#0b0f17] px-3 py-3 text-sm text-gray-400">
          Enter your Farcaster username in the Mine tab to get your referral link.
        </p>
      )}

      <h3 className="mt-6 font-semibold text-white">Creator Reward Rules</h3>
      <p className="mt-1 text-sm text-gray-400">
        Referral never changes the invited miner's reward. Creator weight is verified from Farcaster followers when a session starts.
      </p>
      <p className="mt-3 rounded-xl bg-[#0b0f17] px-3 py-3 text-sm text-[#c4b5fd]">
        1k followers = 10× · 10k = 45× · 100k = 100×. No wallet can claim above the 100× onchain ceiling for one 24-hour window.
      </p>

      {!invitedBy ? (
        <div className="mt-6">
          <h3 className="font-semibold text-white">Who invited you?</h3>
          <p className="mt-1 text-sm text-gray-400">
            Enter a referrer handle. It is verified only when your Farcaster account has at least 100 followers.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              value={inviterInput}
              onChange={(e) => setInviterInput(e.target.value)}
              placeholder="@referrer-username"
              className="h-12 flex-1 rounded-xl border border-gray-700 bg-[#0b0f17] px-3 text-base text-white outline-none placeholder:text-gray-500"
            />
            <button
              type="button"
              onClick={() => {
                onSetInviter(inviterInput)
                setInviterInput("")
              }}
              disabled={!validHandle(cleanHandle(inviterInput))}
              className="h-12 rounded-xl bg-[#8a63d2] px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              Confirm
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-6 text-sm text-gray-400">
          🤝 Invited by <span className="font-semibold text-white">@{invitedBy}</span> · referral is recorded after eligibility verification
        </p>
      )}

      <h3 className="mt-6 font-semibold text-white">Invited Friends ({friends.length})</h3>
      {friends.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">No friends invited yet. Share your code above to build your squad!</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {friends.map((f) => (
            <li key={f.handle} className="flex items-center justify-between rounded-xl bg-[#0b0f17] px-3 py-2">
              <span className="text-sm font-semibold text-white">@{f.handle}</span>
              <span className="text-sm text-gray-400">{now ? formatAgo(now - f.joinedAt) : "new"}</span>
            </li>
          ))}
        </ul>
      )}

      {friends.length < MAX_INVITE_FRIENDS ? (
        <div className="mt-4">
          <p className="text-xs text-gray-400">Add friend manually (Preview Mode)</p>
          <div className="mt-2 flex gap-2">
            <input
              value={friendInput}
              onChange={(e) => setFriendInput(e.target.value)}
              placeholder="@friend-username"
              className="h-10 flex-1 rounded-xl border border-gray-700 bg-[#0b0f17] px-3 text-sm text-white outline-none placeholder:text-gray-500"
            />
            <button
              type="button"
              onClick={() => {
                onAddFriend(friendInput)
                setFriendInput("")
              }}
              disabled={!validHandle(cleanHandle(friendInput))}
              className="h-10 rounded-xl border border-gray-700 bg-[#0b0f17] px-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function YourCasts({ casts, now }: { casts: MinerState["casts"]; now: number | null }) {
  return (
    <section className="mt-4 rounded-2xl border border-gray-800 bg-[#141b26] p-4">
      <h2 className="font-semibold text-white">Mining Activity</h2>
      {casts.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">No sessions yet. Click 'Cast to Mine' to start your first session.</p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {casts.map((cast) => (
            <li key={cast.id} className="border-t border-gray-800 pt-3 first:border-t-0 first:pt-0">
              <p className="text-sm text-white">{cast.text}</p>
              <p className="mt-1 text-sm text-gray-400 tabular-nums">
                {now ? formatAgo(now - cast.at) : "just now"} · Era {cast.era} · {formatTokens(cast.reward)} {TOKEN_SYMBOL}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function NetworkPanel({
  now,
  mined,
  mining,
  handle,
  castText,
  castAt,
}: {
  now: number | null
  mined: number
  mining: boolean
  handle: string
  castText: string
  castAt: number | null
}) {
  const ratio = halvingRatio(mined)
  const era = rewardFor(mined).era
  const next = now ? halvingEta(mined, now) : null
  const remainTokens = Math.max(0, supplyAtEraStart(era + 1) - mined)
  const daily = SIM_DAILY_ERA0 / 2 ** era
  const miners = now ? activeMiners(now, mining) : SIM_MINERS
  const feed = now ? networkFeed(now) : []

  return (
    <section className="rounded-2xl border border-gray-800 bg-[#141b26] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Network State</h2>
          <p className="mt-1 text-sm text-gray-400">
            This is a client-side mining simulation. Only contract reads below represent Base state.
          </p>
        </div>
        <p className="shrink-0 text-right">
          <span className="block text-lg font-semibold tabular-nums text-white">{new Intl.NumberFormat("en-US").format(miners)}</span>
          <span className="text-sm text-gray-400">active miners</span>
        </p>
      </div>

      <p className="mt-5 text-sm text-gray-400">Mined Supply</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-white">{now ? formatSupply(mined) : "—"}</p>
      <p className="text-sm text-gray-400">of {formatSupply(MAX_SUPPLY)} {TOKEN_SYMBOL}</p>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#0b0f17]" aria-hidden>
        <div className="meter-fill h-full rounded-full bg-[#8a63d2]" style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="mt-2 text-sm text-gray-400 tabular-nums">
        {formatPct(ratio)} of Era {era}
        {now ? ` · ${formatSupply(remainTokens)} left until halving` : ""}
      </p>
      <p className="mt-1 text-sm text-gray-400">
        {next ? `Next Halving: ~${formatWhen(next)}` : "Halving targets passed"}
        {" · "}
        {formatSupply(daily)} / day in this Era
      </p>

      <h3 className="mt-6 font-semibold text-white">Reward Halving Curve</h3>
      <ul className="mt-3 grid gap-2">
        {[0, 1, 2, 3, 4, 5].map((index) => {
          const current = index === era
          return (
            <li
              key={index}
              className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 ${current ? "bg-[#8a63d2]/20 border border-[#8a63d2]/40" : "bg-[#0b0f17]"}`}
            >
              <span className={`text-sm ${current ? "font-semibold text-white" : "text-gray-400"}`}>
                Era {index}
                {current ? " · Active" : ""}
              </span>
              <span className="text-right text-sm tabular-nums">
                <span className="font-semibold text-white">{formatTokens(sessionReward(index))}</span>
                <span className="text-gray-400"> / session</span>
              </span>
            </li>
          )
        })}
      </ul>

      <h3 className="mt-6 font-semibold text-white">Live Network Feed</h3>
      <ul className="mt-3 grid gap-3">
        {mining && castText ? (
          <FeedRow handle={handle || "you"} text={castText} ago={now && castAt ? now - castAt : 0} you />
        ) : null}
        {feed.map((item) => (
          <FeedRow key={`${item.handle}-${item.ago}`} handle={item.handle} text={item.text} ago={item.ago} />
        ))}
      </ul>
    </section>
  )
}

function FeedRow({ handle, text, ago, you = false }: { handle: string; text: string; ago: number; you?: boolean }) {
  const initial = (handle[0] ?? "?").toUpperCase()
  return (
    <li className="flex gap-3">
      <span
        className={`grid size-10 shrink-0 place-items-center rounded-xl text-sm font-semibold ${you ? "bg-[#8a63d2]/20 text-[#a78bfa]" : "bg-gray-800 text-gray-300"}`}
        aria-hidden
      >
        {initial}
      </span>
      <span className="min-w-0">
        <span className="block text-sm">
          <span className="font-semibold text-white">@{handle || "user"}</span>
          <span className="text-gray-400"> · {you ? "you · " : ""}{formatAgo(ago)}</span>
        </span>
        <span className="mt-0.5 block text-sm text-gray-400">{text}</span>
      </span>
    </li>
  )
}

function TokenPanel({
  balance,
  payout,
  onPayout,
  era,
  reward,
}: {
  balance: number
  payout: string
  onPayout: (value: string) => void
  era: number
  reward: number
}) {
  const [copied, setCopied] = useState(false)
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>("idle")
  const [statusMsg, setStatusMsg] = useState("")
  const [txHash, setTxHash] = useState("")
  const [onchain, setOnchain] = useState<OnchainSnapshot | null>(null)
  const [onchainError, setOnchainError] = useState("")
  const [loadingOnchain, setLoadingOnchain] = useState(false)
  const [walletConnecting, setWalletConnecting] = useState(false)

  const payoutOk = validPayout(payout)
  const facts = [
    ["Symbol", TOKEN_SYMBOL],
    ["Network", `Base · ${TOKENCAST_CHAIN_ID}`],
    ["Standard", "ERC-20"],
    ["Decimals", "18"],
    ["Max Supply", "21 Billion"],
    ["Session", "24 Hours"],
    ["Current Era", onchain ? String(onchain.era) : `${era} (simulation)`],
    ["Base Reward", `${formatTokens(reward)} / session`],
  ]

  async function handleConnectWallet() {
    setWalletConnecting(true)
    setStatusMsg("")
    try {
      const account = await connectFarcasterWallet(TOKENCAST_CHAIN_ID)
      onPayout(account)
      setClaimStatus("idle")
      setStatusMsg(`Farcaster wallet connected: ${account.slice(0, 6)}...${account.slice(-4)}`)
    } catch (err: any) {
      setClaimStatus("error")
      setStatusMsg(err.message || "Could not connect the Farcaster wallet.")
    } finally {
      setWalletConnecting(false)
    }
  }

  async function refreshOnchain() {
    if (!TOKENCAST_IS_DEPLOYED) return
    setLoadingOnchain(true)
    setOnchainError("")
    try {
      setOnchain(await readOnchainSnapshot(payoutOk && payout ? payout as `0x${string}` : undefined))
    } catch (error: any) {
      setOnchainError(error.message || "Could not read Base contract state.")
    } finally {
      setLoadingOnchain(false)
    }
  }

  useEffect(() => {
    void refreshOnchain()
  }, [payout])

  async function handleClaim() {
    if (!payoutOk || !payout) {
      alert("Please connect or enter a valid Base wallet address first.")
      return
    }
    try {
      const hash = await executeClaimOnBase({
        userAddress: payout as `0x${string}`,
        onStatusChange: (status, msg) => {
          setClaimStatus(status)
          if (msg) setStatusMsg(msg)
        },
      })
      if (hash) {
        setTxHash(hash)
        void refreshOnchain()
      }
    } catch {
      // Handled in status callback
    }
  }

  return (
    <section className="rounded-2xl border border-gray-800 bg-[#141b26] p-5">
      <h2 className="flex items-center gap-3 text-lg font-semibold text-white"><img src="/tokencast-logo.png" alt="" width={36} height={36} className="size-9 shrink-0 rounded-lg" />$TOKENCAST on Base</h2>
      <p className="mt-2 text-sm text-gray-400">
        Proof of Cast on Base. One verified creator, one 24-hour session, zero pre-mine.
      </p>

      <div className={`mt-5 rounded-xl border p-4 ${TOKENCAST_IS_DEPLOYED ? "border-green-500/30 bg-green-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck className={`size-5 shrink-0 ${TOKENCAST_IS_DEPLOYED ? "text-green-400" : "text-amber-400"}`} />
            <div>
              <p className="font-semibold text-white">{TOKENCAST_IS_DEPLOYED ? "Base contract connected" : "Onchain claims not live"}</p>
              <p className="mt-0.5 text-sm text-gray-300">
                {TOKENCAST_IS_DEPLOYED
                  ? `Reading TokenCast directly from Base (${TOKENCAST_CHAIN_ID}).`
                  : "Mining balances in this preview are local only and cannot be withdrawn yet."}
              </p>
            </div>
          </div>
          {TOKENCAST_IS_DEPLOYED ? (
            <button type="button" onClick={() => void refreshOnchain()} title="Refresh Base contract state" className="grid size-9 shrink-0 place-items-center rounded-lg border border-green-400/30 text-green-300 hover:bg-green-500/10" aria-label="Refresh Base contract state">
              <RefreshCw className={`size-4 ${loadingOnchain ? "animate-spin" : ""}`} />
            </button>
          ) : null}
        </div>
        {TOKENCAST_IS_DEPLOYED ? (
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <a href={basescanUrl(`/address/${TOKENCAST_CONTRACT_ADDRESS}`)} target="_blank" rel="noreferrer" className="truncate text-green-300 underline hover:text-white">
              {TOKENCAST_CONTRACT_ADDRESS.slice(0, 6)}...{TOKENCAST_CONTRACT_ADDRESS.slice(-4)} <ExternalLink className="inline size-3" />
            </a>
            <span className="text-right text-gray-300">Minted: {onchain ? formatSupply(onchain.mintedSupply) : "..."}</span>
            {payoutOk && payout && onchain?.walletBalance !== null ? <span className="col-span-2 text-gray-300">Wallet balance: {formatTokens(onchain?.walletBalance ?? 0)} {TOKEN_SYMBOL}</span> : null}
          </div>
        ) : null}
        {onchainError ? <p className="mt-2 text-xs text-red-300">{onchainError}</p> : null}
      </div>

      {/* Web3 On-Chain Claim Box */}
      <div className="mt-5 rounded-2xl border border-[#8a63d2]/40 bg-[#8a63d2]/10 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wallet className="size-5 text-[#a78bfa]" />
            <span className="font-semibold text-white">Withdraw to Wallet</span>
          </div>
          <span className="rounded-lg bg-green-500/20 px-2 py-0.5 text-xs font-semibold text-green-400">
            Base Network
          </span>
        </div>

        <p className="mt-2 text-sm text-gray-300">
          Browser preview only: <span className="font-bold text-[#a78bfa]">{formatTokens(balance)}</span> {TOKEN_SYMBOL}
        </p>
        <p className="mt-1 text-xs text-gray-400">Withdrawable status comes from the server ledger and Base receipt, never this browser preview.</p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={payout}
            placeholder="Base wallet address (0x...)"
            spellCheck={false}
            autoCapitalize="none"
            readOnly
            aria-label="Connected Base wallet"
            className="h-11 flex-1 rounded-xl border border-gray-700 bg-[#0b0f17] px-3 font-mono text-sm text-white outline-none placeholder:text-gray-500"
          />
          <button
            type="button"
            onClick={handleConnectWallet}
            disabled={walletConnecting}
            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-gray-700 bg-[#0b0f17] px-3 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:opacity-50"
          >
            {walletConnecting ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
            {walletConnecting ? "Connecting..." : "Connect Farcaster wallet"}
          </button>
        </div>

        <button
          type="button"
          onClick={handleClaim}
          disabled={!TOKENCAST_IS_DEPLOYED || claimStatus === "signing_wallet_login" || claimStatus === "requesting_voucher" || claimStatus === "sending_tx"}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] text-sm font-semibold text-white transition hover:bg-[#7c52c8] disabled:opacity-50"
        >
          {claimStatus === "signing_wallet_login" || claimStatus === "requesting_voucher" || claimStatus === "sending_tx" ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {claimStatus === "signing_wallet_login" ? "Sign free wallet login..." : claimStatus === "requesting_voucher" ? "Preparing secure claim..." : "Processing transaction on Base..."}
            </>
          ) : (
            <>{TOKENCAST_IS_DEPLOYED ? "Claim verified allocation" : "Claims coming after deployment"}</>
          )}
        </button>

        {statusMsg ? (
          <p className={`mt-2 text-xs ${claimStatus === "error" ? "text-red-400" : claimStatus === "success" ? "text-green-400" : "text-[#a78bfa]"}`}>
            {statusMsg}
          </p>
        ) : null}

        {txHash ? (
          <a
            href={basescanUrl(`/tx/${txHash}`)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex items-center gap-1 text-xs text-[#a78bfa] underline hover:text-white"
          >
            View transaction on Basescan <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-gray-800 bg-gray-800">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-[#141b26] px-3 py-3">
            <dt className="text-sm text-gray-400">{label}</dt>
            <dd className="mt-1 font-semibold tabular-nums text-white">{value}</dd>
          </div>
        ))}
      </dl>

      <h3 className="mt-6 font-semibold text-white">Halving Dynamics</h3>
      <p className="mt-2 text-sm text-gray-400">
        Era 0 benchmark is {formatTokens(INITIAL_SESSION_REWARD)} {TOKEN_SYMBOL} per 24 hours at 1×. Creator weight reaches 100× at 100k verified followers, while an onchain 100× ceiling and one claim per 24 hours limit each wallet.
        Rewards halve every 272 days, independent of miner count. At the 100,000 daily-miner target, the schedule reaches roughly 99% planned issuance in five years; undistributed pool is reserved for community airdrops after the finalisation window.
      </p>

      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(ISSUANCE_SPEC).then(
            () => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            },
            () => setCopied(false),
          )
        }}
        className="mt-4 flex h-12 w-full items-center justify-center rounded-xl border border-gray-700 bg-[#0b0f17] text-sm font-semibold text-white transition hover:bg-gray-800"
      >
        {copied ? "Copied Spec" : "Copy Tokenomics Spec"}
      </button>
    </section>
  )
}

function DaoPanel() {
  const [totalStaked, setTotalStaked] = useState<string | null>(null)
  const [epoch, setEpoch] = useState<number | null>(null)
  const [proposals, setProposals] = useState<DaoProposal[]>([])
  const [loading, setLoading] = useState(false)
  const [votingId, setVotingId] = useState<bigint | null>(null)
  const [message, setMessage] = useState("")

  async function refresh() {
    if (!DAO_IS_DEPLOYED) return
    setLoading(true)
    setMessage("")
    try {
      const next = await readDaoProposals()
      setEpoch(next.epoch)
      setProposals(next.proposals)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read DAO proposals from Base.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh(); if (STAKING_IS_CONFIGURED) void readTotalStaked().then(setTotalStaked).catch(() => setTotalStaked(null)) }, [])

  async function vote(proposal: DaoProposal, support: boolean) {
    setVotingId(proposal.id)
    setMessage("")
    try {
      const hash = await castDaoVote(proposal.id, support)
      setMessage(`Vote confirmed on Base: ${hash.slice(0, 10)}…${hash.slice(-8)}`)
      await refresh()
    } catch (error: any) {
      if (error?.code !== 4001 && !/user rejected|user denied/i.test(String(error?.message ?? ""))) {
        setMessage(error?.message || "Vote could not be submitted.")
      }
    } finally {
      setVotingId(null)
    }
  }

  return (
    <section className="rounded-2xl border border-[#8a63d2]/40 bg-[#141b26] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-[#c4b5fd]"><Vote className="size-4" /> Community governance</p>
          <h2 className="mt-1 text-xl font-bold text-white">MineCast DAO</h2>
          <p className="mt-1 text-sm text-gray-400">Stake for 30 days, then activate voting power.</p>
        </div>
        <span className={`rounded-lg px-2 py-1 text-xs font-semibold ${DAO_IS_DEPLOYED ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-200"}`}>
          {DAO_IS_DEPLOYED ? "V3 live" : "V3 pending"}
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-[#8a63d2]/30 bg-[#0b0f17] p-4">
        <div className="flex items-center justify-between gap-3"><p className="font-semibold text-white">Stake</p><span className="text-xs text-gray-400">{STAKING_IS_CONFIGURED ? "Onchain" : "Coming soon"}</span></div>
        <p className="mt-3 text-sm text-gray-400">Total staked</p>
        <p className="mt-1 text-xl font-bold text-white">{totalStaked === null ? "—" : formatTokens(Number(totalStaked))} <span className="text-sm font-normal text-gray-400">{TOKEN_SYMBOL}</span></p>
        <button type="button" disabled className="mt-3 h-11 w-full rounded-xl bg-[#8a63d2] font-semibold text-white opacity-50">Stake · Coming soon</button>
        <p className="mt-2 text-xs text-gray-400">Staking transactions will be available after V3 integration.</p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-gray-800 bg-[#0b0f17] p-4">
          <p className="text-sm text-gray-400">Community airdrop</p>
            <p className="mt-1 font-semibold text-white">Odd months · 10% of prior miners’ total</p>
        </div>
        <div className="rounded-xl border border-gray-800 bg-[#0b0f17] p-4">
          <p className="text-sm text-gray-400">Treasury burn</p>
            <p className="mt-1 font-semibold text-white">Even months · 5% of prior miners’ total</p>
        </div>
      </div>

      {!DAO_IS_DEPLOYED ? (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="font-semibold text-amber-100">Voting opens after V3 deployment</p>
          <p className="mt-1 text-sm text-amber-100/80">Stake and vote will open after V3 deployment.</p>
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-sm text-gray-400">{epoch === null ? "Loading schedule…" : `UTC schedule · ${String(epoch).slice(0, 4)}-${String(epoch).slice(-2)}`}</p>
            <button type="button" onClick={() => void refresh()} disabled={loading} aria-busy={loading} className="flex h-10 items-center gap-2 rounded-xl border border-gray-700 px-3 text-sm font-semibold text-gray-200 disabled:opacity-60">
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>

          <div className="mt-3 grid gap-3">
            {proposals.length === 0 ? <p className="rounded-xl border border-gray-800 bg-[#0b0f17] p-4 text-sm text-gray-400">No current-month DAO vote. A finalized previous mining month is required before the fixed vote opens.</p> : null}
            {proposals.map((proposal) => (
              <article key={proposal.id.toString()} className="rounded-xl border border-gray-800 bg-[#0b0f17] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-white">{proposal.kind}</p>
                    <p className="mt-1 text-sm text-gray-400">Vote month {String(proposal.calendarMonth).slice(0, 4)}-{String(proposal.calendarMonth).slice(-2)} · mining basis {String(proposal.targetCalendarMonth).slice(0, 4)}-{String(proposal.targetCalendarMonth).slice(-2)} · {formatTokens(Number(proposal.amount))} {TOKEN_SYMBOL}</p>
                  </div>
                  <span className={`rounded-lg px-2 py-1 text-xs font-semibold ${proposal.active ? "bg-green-500/15 text-green-300" : "bg-gray-700 text-gray-300"}`}>{proposal.active ? "Voting open" : "Voting closed"}</span>
                </div>
                <p className="mt-3 text-xs text-gray-500">Yes {formatTokens(Number(proposal.yesVotes))} · No {formatTokens(Number(proposal.noVotes))} · the higher side wins; tie means no action · ends at Base block {proposal.deadlineBlock.toString()}</p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => void vote(proposal, true)} disabled={!proposal.active || votingId !== null || proposal.voted} className="h-11 rounded-xl bg-green-500/80 text-sm font-semibold text-white disabled:opacity-50">{votingId === proposal.id ? "Confirm in wallet…" : proposal.voted ? "Already voted" : "Vote Yes"}</button>
                  <button type="button" onClick={() => void vote(proposal, false)} disabled={!proposal.active || votingId !== null || proposal.voted} className="h-11 rounded-xl bg-red-500/80 text-sm font-semibold text-white disabled:opacity-50">Vote No</button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {message ? <p role="alert" className="mt-4 rounded-xl bg-[#8a63d2]/15 px-3 py-2 text-sm text-[#ddd6fe]">{message}</p> : null}
      <p className="mt-4 text-xs text-gray-500">One Yes/No vote per month · ties result in no action.</p>
    </section>
  )
}

function dashboardTokens(wei: string): string {
  try {
    return formatTokens(Number(formatUnits(BigInt(wei), 18)))
  } catch {
    return "—"
  }
}

function shortAddress(address: string | null): string {
  if (!address) return "—"
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function AdminDashboard() {
  const [data, setData] = useState<AdminDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState("")

  async function refresh() {
    setLoading(true)
    setErrorMessage("")
    try {
      const response = await farcasterFetch("/api/admin/overview")
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || "Could not load the admin dashboard.")
      setData(body as AdminDashboardData)
    } catch (cause) {
      setData(null)
      setErrorMessage(cause instanceof Error ? cause.message : "Could not load the admin dashboard.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  if (loading && !data) {
    return <section className="mt-5 grid min-h-64 place-items-center rounded-2xl border border-gray-800 bg-[#141b26] text-sm text-gray-400"><span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading private operations…</span></section>
  }

  if (errorMessage) {
    return (
      <section className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/10 p-5" role="alert">
        <h2 className="font-semibold text-red-200">Admin dashboard unavailable</h2>
        <p className="mt-1 text-sm text-red-200/80">{errorMessage}</p>
        <button type="button" onClick={() => void refresh()} className="mt-4 flex h-11 items-center gap-2 rounded-xl border border-red-400/40 px-4 text-sm font-semibold text-red-100"><RefreshCw className="size-4" /> Retry</button>
      </section>
    )
  }

  if (!data) return null
  const cards = [
    ["Miners", data.metrics.miners.toLocaleString(), "Verified Farcaster identities"],
    ["Mining live", data.metrics.activeSessions.toLocaleString(), "Sessions not yet settled"],
    ["Sessions settled", data.metrics.settledSessions.toLocaleString(), "Completed 24-hour sessions"],
    ["Claims completed", data.metrics.claimedAllocations.toLocaleString(), "Onchain withdrawal records"],
    ["Available to claim", `${dashboardTokens(data.metrics.availableWei)} ${TOKEN_SYMBOL}`, "Ledger allocation not yet claimed"],
    ["Voucher reserved", `${dashboardTokens(data.metrics.voucherWei)} ${TOKEN_SYMBOL}`, "Awaiting wallet transaction"],
    ["Claimed out", `${dashboardTokens(data.metrics.claimedWei)} ${TOKEN_SYMBOL}`, "Recorded completed withdrawals"],
  ]

  return (
    <section className="mt-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-[#8a63d2]/40 bg-[#141b26] p-5">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-[#c4b5fd]"><ShieldCheck className="size-4" /> Private operations dashboard</p>
          <h2 className="mt-1 text-xl font-bold text-white">MineCast inflow & outflow</h2>
          <p className="mt-1 text-sm text-gray-400">Server-verified miner, session, allocation and claim ledger. Updated {formatAgo(Date.now() - Date.parse(data.generatedAt))}.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} aria-busy={loading} className="flex h-11 items-center gap-2 rounded-xl bg-[#8a63d2] px-4 text-sm font-semibold text-white disabled:opacity-60"><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh</button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value, note]) => <div key={label} className="rounded-2xl border border-gray-800 bg-[#141b26] p-4"><p className="text-sm text-gray-400">{label}</p><p className="mt-2 truncate text-xl font-bold tabular-nums text-white">{value}</p><p className="mt-1 text-xs text-gray-500">{note}</p></div>)}
      </div>

      <AdminTable title="Latest miners" columns={["Miner", "Followers", "Payout wallet", "Joined"]}>
        {data.miners.map((miner) => <tr key={miner.fid} className="border-t border-gray-800"><td className="px-3 py-3 font-medium text-white">@{miner.username || `fid-${miner.fid}`} <span className="text-xs font-normal text-gray-500">#{miner.fid}</span></td><td className="px-3 py-3">{Number(miner.follower_count || 0).toLocaleString()}</td><td className="px-3 py-3 font-mono text-xs">{shortAddress(miner.wallet_address)}</td><td className="px-3 py-3">{formatWhen(Date.parse(miner.created_at))}</td></tr>)}
      </AdminTable>

      <AdminTable title="Mining sessions" columns={["FID", "Reward weight", "Estimated reward", "Window", "State"]}>
        {data.sessions.map((session) => <tr key={session.id} className="border-t border-gray-800"><td className="px-3 py-3 font-medium text-white">#{session.fid}</td><td className="px-3 py-3">{session.reward_weight}×</td><td className="px-3 py-3">{dashboardTokens(session.reward_wei)} {TOKEN_SYMBOL}</td><td className="px-3 py-3 text-xs">{formatWhen(Date.parse(session.started_at))}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${session.settled_at ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-200"}`}>{session.settled_at ? "Settled" : "Active"}</span></td></tr>)}
      </AdminTable>

      <AdminTable title="Token outflow / claims" columns={["FID", "Amount", "Wallet", "Status", "Created"]}>
        {data.claims.map((claim) => <tr key={claim.id} className="border-t border-gray-800"><td className="px-3 py-3 font-medium text-white">#{claim.fid}</td><td className="px-3 py-3">{dashboardTokens(claim.amount_wei)} {TOKEN_SYMBOL}</td><td className="px-3 py-3 font-mono text-xs">{shortAddress(claim.wallet_address)}</td><td className="px-3 py-3"><span className="rounded-full bg-[#8a63d2]/20 px-2 py-1 text-xs font-semibold text-[#c4b5fd]">{claim.status.replace(/_/g, " ")}</span></td><td className="px-3 py-3 text-xs">{formatWhen(Date.parse(claim.created_at))}</td></tr>)}
      </AdminTable>
    </section>
  )
}

function AdminTable({ title, columns, children }: { title: string; columns: string[]; children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-gray-800 bg-[#141b26]"><h3 className="border-b border-gray-800 px-4 py-4 font-semibold text-white">{title}</h3><div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm text-gray-300"><thead className="bg-[#0b0f17] text-xs uppercase tracking-wide text-gray-500"><tr>{columns.map((column) => <th key={column} className="px-3 py-3 font-medium">{column}</th>)}</tr></thead><tbody>{children}</tbody></table></div></section>
}

function NavButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex h-16 flex-col items-center justify-center gap-1 text-sm font-semibold transition ${active ? "text-[#a78bfa]" : "text-gray-400"}`}
    >
      {icon}
      {label}
    </button>
  )
}

function Composer({
  era,
  reward,
  notice,
  onNotice,
  onClose,
  onPublish,
  claimGate, claimAmount, claimEndsAt, gateBusy, claimSucceeded, claimStatus, onClaim, onRetry,
}: {
  era: number
  reward: number
  notice: string
  onNotice: (value: string) => void
  onClose: () => void
  onPublish: (text: string) => Promise<boolean>
  claimGate: "checking" | "active" | "claim" | "cast" | "error"
  claimAmount: string
  claimEndsAt: string | null
  gateBusy: boolean
  claimSucceeded: boolean
  claimStatus: ClaimStatus
  onClaim: () => Promise<void>
  onRetry: () => void
}) {
  const titleId = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(
    `⛏️ Started a 24-hour mining session for $TOKENCAST on MineCast (Era ${era}). Cast to mine!`,
  )
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState("")
  const [activeClock, setActiveClock] = useState(() => Date.now())
  const busyRef = useRef(false)
  const closeRef = useRef(onClose)
  busyRef.current = busy
  closeRef.current = onClose

  useEffect(() => {
    field.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) closeRef.current()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (claimGate !== "active" || !claimEndsAt) return
    setActiveClock(Date.now())
    const interval = window.setInterval(() => setActiveClock(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [claimGate, claimEndsAt])

  const error = localError || (claimStatus === "error" || claimGate === "error" ? notice : "")
  const claimInProgress = gateBusy && claimStatus !== "error"
  const tooLong = text.trim().length > 1024
  const activeEndsAt = claimEndsAt ? Date.parse(claimEndsAt) : Number.NaN
  const activeRemaining = Number.isFinite(activeEndsAt) ? Math.max(0, activeEndsAt - activeClock) : 0

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/80 p-3 sm:items-center"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-2xl border border-gray-800 bg-[#141b26] p-4 text-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">Start Mining Session</h2>
            <p className="mt-1 text-sm text-gray-400">
              Locks {formatTokens(reward)} {TOKEN_SYMBOL} reward for 24 hours.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="grid size-11 place-items-center rounded-xl text-gray-400 hover:text-white"
          >
            <X className="size-5" />
          </button>
        </div>
        {claimGate !== "cast" ? <div className="mt-4 space-y-3">
          {claimGate === "active" ? <div className="rounded-xl border border-[#8a63d2]/40 bg-[#8a63d2]/10 p-4 text-center">
            <p className="text-sm text-gray-300">Server-verified mining session active</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-[#c4b5fd]">{formatClock(activeRemaining)}</p>
            <p className="mt-1 text-sm text-gray-400">remaining until your reward can be claimed</p>
          </div> : <p className="text-sm text-gray-300">{claimGate === "checking" ? "Checking your mining reward…" : claimGate === "claim" ? `Claim your verified reward before your next cast: ${formatTokens(Number(BigInt(claimAmount)) / 1e18)} ${TOKEN_SYMBOL}` : "Could not check your reward."}</p>}
          {notice && !error ? <p className={`rounded-xl px-3 py-2 text-sm ${claimStatus === "success" ? "bg-green-500/15 text-green-300" : "bg-[#8a63d2]/15 text-[#ddd6fe]"}`}>{notice}</p> : null}
          {error ? <p className="rounded-xl bg-red-500/20 px-3 py-2 text-sm text-red-300">{error}</p> : null}
          {claimGate === "claim" ? <button type="button" disabled={gateBusy} onClick={() => void onClaim()} className="h-12 w-full rounded-xl bg-[#8a63d2] font-semibold disabled:opacity-50">{claimInProgress ? claimStatus === "signing_wallet_login" ? "Sign in wallet…" : claimStatus === "sending_tx" ? "Confirming on Base…" : "Preparing secure claim…" : "Claim reward"}</button> : null}
          {claimGate === "active" ? <button type="button" onClick={onRetry} className="h-12 w-full rounded-xl border border-[#8a63d2]/60 font-semibold text-[#c4b5fd]">Refresh reward status</button> : null}
          {claimGate === "error" ? <button type="button" onClick={onRetry} className="h-12 w-full rounded-xl bg-[#8a63d2] font-semibold">Retry</button> : null}
        </div> : <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault()
            const body = text.trim()
            if (!body) {
              setLocalError("Cast text cannot be empty.")
              return
            }
            if (body.length > 1024) {
              setLocalError("Cast text exceeds 1024 characters.")
              return
            }
            setLocalError("")
            onNotice("")
            setBusy(true)
            void onPublish(body).then((ok) => {
              setBusy(false)
              if (ok) onClose()
            })
          }}
        >
          <textarea
            ref={field}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            maxLength={1100}
            aria-label="Cast Content"
            className="w-full resize-none rounded-xl border border-gray-700 bg-[#0b0f17] px-3 py-3 text-base leading-normal text-white outline-none focus:border-[#8a63d2]"
          />
          <p className="mt-2 text-right text-sm text-gray-400 tabular-nums">{text.trim().length}/1024</p>
          {claimSucceeded ? <p className="mt-2 rounded-xl bg-green-500/15 px-3 py-2 text-sm text-green-300">Reward confirmed on Base. You can start your next mining session.</p> : null}
          {error ? <p className="mt-2 rounded-xl bg-red-500/20 px-3 py-2 text-sm text-red-300">{error}</p> : null}
          <p className="mt-3 text-sm text-gray-400">
            In Warpcast, this opens the native composer. Mining begins only after your cast is published.
          </p>
          <button
            type="submit"
            disabled={busy || tooLong}
            className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] text-base font-semibold text-white transition hover:bg-[#7c52c8] disabled:opacity-50"
          >
            <Send className="size-4" />
            {busy ? "Posting cast…" : "Post Cast & Mine for 24h"}
          </button>
        </form>}
      </div>
    </div>
  )
}
