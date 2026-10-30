import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Gem, Layers, Radio, Send, Users, X, Copy, Check, Share2, Wallet, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react"
import { bootFarcaster, composeOnFarcaster, farcasterAuthToken } from "@/lib/farcaster"
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
  formatMult,
  formatWhen,
  GENESIS_MS,
  halvingEta,
  INITIAL_SESSION_REWARD,
  INVITE_REFERRAL_PCT,
  INVITE_SPEED_BOOST,
  inviterSpeedBonus,
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
  speedMultiplier,
  supplyAtEraStart,
  TOKEN_SYMBOL,
} from "@/lib/tokenomics"
import { executeClaimOnBase, type ClaimStatus } from "@/lib/web3-claim"
import { TOKENCAST_CHAIN_ID, TOKENCAST_CONTRACT_ADDRESS, TOKENCAST_IS_DEPLOYED } from "@/lib/contract"
import { basescanUrl, readOnchainSnapshot, type OnchainSnapshot } from "@/lib/onchain"

type Tab = "mine" | "invite" | "network" | "token"

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
    body: "21 Billion hard cap. As more tokens are mined, session rewards halve like Bitcoin.",
  },
  {
    title: "Invite Squad",
    body: "Invite friends to mine faster. Earn 8% referral bonuses on every session they complete.",
  },
]

export default function App() {
  const [tab, setTab] = useState<Tab>("mine")
  const [now, setNow] = useState<number | null>(null)
  const [miner, setMiner] = useState<MinerState>(EMPTY_MINER)
  const [ready, setReady] = useState(false)
  const [composer, setComposer] = useState(false)
  const [notice, setNotice] = useState("")
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
    setMiner(stored)
    setReady(true)
    const tick = () => {
      const t = Date.now()
      setNow(t)
      setMiner((current) => {
        const completed = Boolean(current.session && t >= current.session.endsAt)
        const next = settle(current, t)
        if (completed) {
          void farcasterAuthToken()
            .then((token) => fetch("/api/mine/settle", { method: "POST", headers: { Authorization: `Bearer ${token}` } }))
            .catch(() => undefined)
        }
        return next === current ? current : next
      })
    }
    tick()
    const id = window.setInterval(tick, 1000)
    bootFarcaster().then((username) => {
      if (!username) return
      setMiner((current) => (current.handle ? current : { ...current, handle: cleanHandle(username) }))
      void farcasterAuthToken()
        .then((token) => fetch("/api/mine/settle", { method: "POST", headers: { Authorization: `Bearer ${token}` } }))
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

  function setHandle(value: string) {
    setMiner((current) => ({ ...current, handle: cleanHandle(value) }))
  }

  function setPayout(value: string) {
    const next = value.trim()
    setMiner((current) => ({ ...current, payout: next }))
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
          <p className="rounded-xl bg-[#8a63d2]/20 px-3 py-1.5 text-sm font-semibold text-[#a78bfa]">
            Base
          </p>
        </header>

        <div className="mt-5 grid items-start gap-4 lg:grid-cols-5">
          <div className={`${tab === "mine" ? "" : "hidden lg:block"} lg:col-span-2`}>
            <MineCard
              handle={miner.handle}
              onHandle={setHandle}
              era={now ? quote.era : 0}
              balance={shownBalance}
              live={mining}
              remain={remain}
              mining={mining}
              reward={mining && session ? session.reward : quote.reward}
              hourly={(mining && session ? session.reward : quote.reward) / 8}
              halvingRatio={halvingRatio(networkMined)}
              castText={mining && session ? session.text : ""}
              inviteCount={miner.invitedFriends.length}
              wasInvited={miner.invitedBy.length >= 2}
              onCast={() => {
                setNotice("")
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
            <div className={tab === "token" || tab === "invite" ? "hidden lg:block" : ""}>
              <NetworkPanel
                now={now}
                mined={networkMined}
                mining={mining}
                handle={miner.handle}
                castText={session?.text ?? ""}
                castAt={session?.startedAt ?? null}
              />
            </div>
            <div className={tab === "network" || tab === "invite" ? "hidden lg:block" : ""}>
              <TokenPanel
                balance={shownBalance}
                payout={miner.payout}
                onPayout={setPayout}
                era={quote.era}
                reward={quote.reward}
              />
            </div>
          </div>
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-800 bg-[#0b0f17]/95 backdrop-blur lg:hidden">
        <div className="mx-auto grid max-w-lg grid-cols-4">
          <NavButton active={tab === "mine"} onClick={() => setTab("mine")} label="Mine" icon={<Gem className="size-5" />} />
          <NavButton active={tab === "invite"} onClick={() => setTab("invite")} label="Squad" icon={<Users className="size-5" />} />
          <NavButton active={tab === "network"} onClick={() => setTab("network")} label="Network" icon={<Radio className="size-5" />} />
          <NavButton active={tab === "token"} onClick={() => setTab("token")} label="Token" icon={<Layers className="size-5" />} />
        </div>
      </nav>

      {composer ? (
        <Composer
          era={quote.era}
          reward={quote.reward}
          onClose={() => setComposer(false)}
          notice={notice}
          onNotice={setNotice}
          onPublish={async (text) => {
            const current = minerRef.current
            const handle = cleanHandle(current.handle)
            if (!validHandle(handle)) {
              setNotice("Username must be 2–16 characters, alphanumeric.")
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
            const serverResponse = await fetch("/api/mine/start", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${await farcasterAuthToken()}` },
              body: JSON.stringify({ castHash: posted.hash, walletAddress: wallet, username: handle, referrerHandle: current.invitedBy }),
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
  onHandle,
  era,
  balance,
  live,
  remain,
  mining,
  reward,
  hourly,
  halvingRatio: ratio,
  castText,
  inviteCount,
  wasInvited,
  onCast,
}: {
  handle: string
  onHandle: (value: string) => void
  era: number
  balance: number
  live: boolean
  remain: number
  mining: boolean
  reward: number
  hourly: number
  halvingRatio: number
  castText: string
  inviteCount: number
  wasInvited: boolean
  onCast: () => void
}) {
  const ring = mining ? remain / SESSION_MS : 1
  const mult = speedMultiplier(0, wasInvited, inviteCount)
  const hasBoost = mult > 1
  return (
    <section className="rounded-2xl border border-gray-800 bg-[#141b26] p-5">
      <div className="flex items-end justify-between gap-3">
        <label className="min-w-0 flex-1">
          <span className="text-sm text-gray-400">Miner</span>
          <span className="mt-1 flex h-12 items-center gap-1 rounded-xl border border-gray-700 bg-[#0b0f17] px-3">
            <span className="text-gray-400" aria-hidden>@</span>
            <input
              value={handle}
              onChange={(event) => onHandle(event.target.value)}
              placeholder="your-username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={16}
              aria-label="Farcaster Handle"
              className="h-full w-full bg-transparent text-base text-white outline-none placeholder:text-gray-500"
            />
          </span>
        </label>
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
          {hasBoost ? <span className="rounded-full bg-[#8a63d2]/20 px-2 py-0.5 text-xs font-semibold text-[#a78bfa]">⚡ {formatMult(mult)}</span> : null}
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
  const bonus = inviterSpeedBonus(friends.length)
  const hasHandle = validHandle(handle)

  const tierList = [
    { min: 3, bonus: "+10%", label: "3 Friends" },
    { min: 7, bonus: "+20%", label: "7 Friends" },
    { min: 15, bonus: "+30%", label: "15 Friends" },
  ]

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
                  text: `Use code ${code} or click the link to mine 20% faster!`,
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

      <h3 className="mt-6 font-semibold text-white">Squad Speed Multipliers</h3>
      <p className="mt-1 text-sm text-gray-400">
        Invited friends mine {Math.round(INVITE_SPEED_BOOST * 100)}% faster. You also unlock personal speed boosts:
      </p>
      <ul className="mt-3 grid gap-2">
        {tierList.map((tier) => {
          const reached = friends.length >= tier.min
          return (
            <li
              key={tier.min}
              className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 ${reached ? "bg-[#8a63d2]/20 border border-[#8a63d2]/40" : "bg-[#0b0f17]"}`}
            >
              <span className={`text-sm ${reached ? "font-semibold text-white" : "text-gray-400"}`}>
                {tier.label} {reached ? "✓" : ""}
              </span>
              <span className={`text-sm font-semibold ${reached ? "text-[#a78bfa]" : "text-gray-400"}`}>
                {tier.bonus} Mining Speed
              </span>
            </li>
          )
        })}
      </ul>
      {bonus > 0 ? (
        <p className="mt-2 text-sm font-semibold text-green-400">
          ⚡ You have a +{Math.round(bonus * 100)}% speed boost from {friends.length} friends!
        </p>
      ) : null}

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
          🤝 Invited by <span className="font-semibold text-white">@{invitedBy}</span> · +{Math.round(INVITE_SPEED_BOOST * 100)}% speed boost active
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
    if (typeof window !== "undefined" && (window as any).ethereum) {
      try {
        const accounts = await (window as any).ethereum.request({ method: "eth_requestAccounts" })
        if (accounts && accounts[0]) {
          onPayout(accounts[0])
        }
      } catch (err: any) {
        alert(err.message || "Could not connect wallet")
      }
    } else {
      alert("No Web3 wallet found. Please open inside Warpcast or a Web3 browser (MetaMask, Coinbase Wallet).")
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
        Proof of Cast on Base. No hardware rigs. One miner, one session, locked reward, zero pre-mine.
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
          Local mining balance: <span className="font-bold text-[#a78bfa]">{formatTokens(balance)}</span> {TOKEN_SYMBOL}
        </p>
        <p className="mt-1 text-xs text-gray-400">A server-verified claim ledger determines the withdrawable amount; the browser never chooses it.</p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={payout}
            onChange={(event) => onPayout(event.target.value)}
            placeholder="Base wallet address (0x...)"
            spellCheck={false}
            autoCapitalize="none"
            className="h-11 flex-1 rounded-xl border border-gray-700 bg-[#0b0f17] px-3 font-mono text-sm text-white outline-none placeholder:text-gray-500"
          />
          <button
            type="button"
            onClick={handleConnectWallet}
            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-gray-700 bg-[#0b0f17] px-3 text-sm font-semibold text-gray-200 transition hover:bg-gray-800"
          >
            <Wallet className="size-4" />
            Connect
          </button>
        </div>

        <button
          type="button"
          onClick={handleClaim}
          disabled={!TOKENCAST_IS_DEPLOYED || claimStatus === "requesting_voucher" || claimStatus === "sending_tx"}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] text-sm font-semibold text-white transition hover:bg-[#7c52c8] disabled:opacity-50"
        >
          {claimStatus === "requesting_voucher" || claimStatus === "sending_tx" ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Processing transaction on Base...
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
        Era 0 yields {formatTokens(INITIAL_SESSION_REWARD)} {TOKEN_SYMBOL} per 24 hours ({formatTokens(INITIAL_SESSION_REWARD / 24)}/hr). Claims are limited to one per Farcaster account every 24 hours.
        When total mined supply reaches 10.5 Billion (50%), session rewards cut in half. Subsequent checkpoints at 75%, 87.5%, identical to Bitcoin.
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
}: {
  era: number
  reward: number
  notice: string
  onNotice: (value: string) => void
  onClose: () => void
  onPublish: (text: string) => Promise<boolean>
}) {
  const titleId = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(
    `⛏️ Started a 24-hour mining session for $TOKENCAST on MineCast (Era ${era}). Cast to mine!`,
  )
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState("")
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

  const error = localError || notice
  const tooLong = text.trim().length > 1024

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
        <form
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
        </form>
      </div>
    </div>
  )
}
