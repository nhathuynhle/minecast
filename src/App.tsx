import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Gem, Layers, Radio, Send, Users, X, Copy, Check, Share2 } from "lucide-react"
import { bootFarcaster, composeOnFarcaster } from "@/lib/farcaster"
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
  CHAIN_ID,
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

type Tab = "mine" | "invite" | "network" | "token"

const STEPS = [
  {
    title: "Cast",
    body: "Một cast mở đúng một phiên. Trong Warpcast, cast được đăng thật.",
  },
  {
    title: "8 giờ",
    body: "Token nhỏ giọt suốt phiên. Đóng app vẫn tính. Hết giờ thì dừng.",
  },
  {
    title: "Halving",
    body: "Tổng cung 21 tỷ. Càng đào nhiều, thưởng mỗi phiên càng giảm một nửa.",
  },
  {
    title: "Mời bạn",
    body: "Mời bạn bè để đào nhanh hơn. Bạn nhận 8% thưởng từ mỗi phiên của người bạn mời.",
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
        const next = settle(current, t)
        return next === current ? current : next
      })
    }
    tick()
    const id = window.setInterval(tick, 1000)
    bootFarcaster().then((username) => {
      if (!username) return
      setMiner((current) => (current.handle ? current : { ...current, handle: cleanHandle(username) }))
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
              <p className="text-sm text-gray-400">Cast một lần. Đào đúng 8 tiếng.</p>
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
          <NavButton active={tab === "mine"} onClick={() => setTab("mine")} label="Đào" icon={<Gem className="size-5" />} />
          <NavButton active={tab === "invite"} onClick={() => setTab("invite")} label="Mời" icon={<Users className="size-5" />} />
          <NavButton active={tab === "network"} onClick={() => setTab("network")} label="Mạng" icon={<Radio className="size-5" />} />
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
              setNotice("Tên cần 2–16 ký tự, bắt đầu và kết thúc bằng chữ hoặc số.")
              return false
            }
            const posted = await composeOnFarcaster(text)
            if (posted === "cancelled") {
              setNotice("Bạn đóng composer trước khi đăng. Phiên chưa mở.")
              return false
            }
            const t = Date.now()
            const settled = settle({ ...minerRef.current, handle }, t)
            const mined = Math.min(MAX_SUPPLY, simulatedMined(t) + settled.balance)
            const next = openSession(settled, t, text, handle, mined)
            if (!next) {
              setNotice("Đã chạm tổng cung. Không còn token để đào.")
              return false
            }
            setMiner(next)
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
    <span className="grid size-11 place-items-center rounded-xl bg-[#8a63d2] text-white">
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
        <path
          fill="currentColor"
          d="M12 2.2 20.2 7v10L12 21.8 3.8 17V7L12 2.2Zm0 2.6L6.2 8.1v7.8L12 19.2l5.8-3.3V8.1L12 4.8Z"
        />
        <circle cx="12" cy="12" r="2.1" fill="currentColor" />
      </svg>
    </span>
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
          <span className="text-sm text-gray-400">Thợ đào</span>
          <span className="mt-1 flex h-12 items-center gap-1 rounded-xl border border-gray-700 bg-[#0b0f17] px-3">
            <span className="text-gray-400" aria-hidden>@</span>
            <input
              value={handle}
              onChange={(event) => onHandle(event.target.value)}
              placeholder="ten-cua-ban"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={16}
              aria-label="Tên Farcaster"
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
        <SessionRing progress={ring} label={formatClock(remain)} caption={mining ? "còn lại" : "mỗi phiên"} />
        <p className="mt-4 flex items-center gap-2 text-sm text-gray-400">
          {mining ? <span className="live-dot size-2 rounded-full bg-[#8a63d2]" aria-hidden /> : null}
          {mining ? "Đang nhỏ giọt" : "Chưa có phiên"}
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
          Hết phiên mới cast được
        </p>
      ) : (
        <button
          type="button"
          onClick={onCast}
          className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] text-base font-semibold text-white transition hover:bg-[#7c52c8]"
        >
          <Send className="size-4" />
          Cast để đào
        </button>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-2">
        <Stat label="Thưởng" value={formatTokens(reward)} unit="mỗi phiên" />
        <Stat label="Tốc độ" value={formatTokens(hourly)} unit="mỗi giờ" />
        <Stat label="Mốc" value={formatPct(ratio)} unit="tới halving" />
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
    { min: 3, bonus: "+10%", label: "3 bạn" },
    { min: 7, bonus: "+20%", label: "7 bạn" },
    { min: 15, bonus: "+30%", label: "15 bạn" },
  ]

  return (
    <section className="rounded-2xl border border-gray-800 bg-[#141b26] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Mời bạn bè</h2>
          <p className="mt-1 text-sm text-gray-400">
            Mời bạn đào cùng. Bạn nhận {Math.round(INVITE_REFERRAL_PCT * 100)}% thưởng từ mỗi phiên của họ.
            Tối đa {MAX_INVITE_FRIENDS} người.
          </p>
        </div>
        <span className="shrink-0 rounded-xl bg-[#8a63d2]/20 px-3 py-1.5 text-sm font-semibold text-[#a78bfa]">
          {friends.length}/{MAX_INVITE_FRIENDS}
        </span>
      </div>

      {hasHandle ? (
        <div className="mt-5">
          <p className="text-sm text-gray-400">Mã mời của bạn</p>
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
              {copied ? "Đã chép" : "Chép link"}
            </button>
          </div>
          <p className="mt-2 break-all text-xs text-gray-400">{link}</p>

          {"share" in navigator ? (
            <button
              type="button"
              onClick={() => {
                void navigator.share?.({
                  title: `Đào $TOKENCAST cùng tao trên MineCast!`,
                  text: `Dùng mã ${code} hoặc link dưới để đào nhanh hơn 20%!`,
                  url: link,
                })
              }}
              className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] text-base font-semibold text-white transition hover:bg-[#7c52c8]"
            >
              <Share2 className="size-4" />
              Chia sẻ link mời
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 rounded-xl bg-[#0b0f17] px-3 py-3 text-sm text-gray-400">
          Nhập tên Farcaster ở tab Đào để lấy mã mời.
        </p>
      )}

      <h3 className="mt-6 font-semibold text-white">Bonus tốc độ từ bạn bè</h3>
      <p className="mt-1 text-sm text-gray-400">
        Mời càng nhiều bạn, tốc độ đào của bạn càng nhanh. Bạn bè được mời đào nhanh hơn {Math.round(INVITE_SPEED_BOOST * 100)}%.
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
                {tier.bonus} tốc độ đào
              </span>
            </li>
          )
        })}
      </ul>
      {bonus > 0 ? (
        <p className="mt-2 text-sm font-semibold text-green-400">
          ⚡ Bạn đang có +{Math.round(bonus * 100)}% tốc độ từ {friends.length} bạn bè!
        </p>
      ) : null}

      {!invitedBy ? (
        <div className="mt-6">
          <h3 className="font-semibold text-white">Ai mời bạn?</h3>
          <p className="mt-1 text-sm text-gray-400">
            Nhập tên người mời để nhận +{Math.round(INVITE_SPEED_BOOST * 100)}% tốc độ đào vĩnh viễn. Chỉ nhập được 1 lần.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              value={inviterInput}
              onChange={(e) => setInviterInput(e.target.value)}
              placeholder="@ten-nguoi-moi"
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
              Xác nhận
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-6 text-sm text-gray-400">
          🤝 Được mời bởi <span className="font-semibold text-white">@{invitedBy}</span> · +{Math.round(INVITE_SPEED_BOOST * 100)}% tốc độ
        </p>
      )}

      <h3 className="mt-6 font-semibold text-white">Bạn bè đã mời ({friends.length})</h3>
      {friends.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">Chưa mời ai. Chia sẻ link phía trên để bắt đầu!</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {friends.map((f) => (
            <li key={f.handle} className="flex items-center justify-between rounded-xl bg-[#0b0f17] px-3 py-2">
              <span className="text-sm font-semibold text-white">@{f.handle}</span>
              <span className="text-sm text-gray-400">{now ? formatAgo(now - f.joinedAt) : "mới"}</span>
            </li>
          ))}
        </ul>
      )}

      {friends.length < MAX_INVITE_FRIENDS ? (
        <div className="mt-4">
          <p className="text-xs text-gray-400">Thêm bạn thủ công (bản xem trước)</p>
          <div className="mt-2 flex gap-2">
            <input
              value={friendInput}
              onChange={(e) => setFriendInput(e.target.value)}
              placeholder="@ten-ban"
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
              Thêm
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
      <h2 className="font-semibold text-white">Nhật ký của bạn</h2>
      {casts.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">Chưa có cast. Phiên đầu tiên bắt đầu từ nút phía trên.</p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {casts.map((cast) => (
            <li key={cast.id} className="border-t border-gray-800 pt-3 first:border-t-0 first:pt-0">
              <p className="text-sm text-white">{cast.text}</p>
              <p className="mt-1 text-sm text-gray-400 tabular-nums">
                {now ? formatAgo(now - cast.at) : "vừa ghi"} · era {cast.era} · {formatTokens(cast.reward)} {TOKEN_SYMBOL}
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
          <h2 className="text-lg font-semibold text-white">Mạng đào</h2>
          <p className="mt-1 text-sm text-gray-400">
            {SIM_MINERS} thợ mô phỏng giữ nhịp halving. Sổ của bạn lưu trên máy này.
          </p>
        </div>
        <p className="shrink-0 text-right">
          <span className="block text-lg font-semibold tabular-nums text-white">{new Intl.NumberFormat("vi-VN").format(miners)}</span>
          <span className="text-sm text-gray-400">đang trong phiên</span>
        </p>
      </div>

      <p className="mt-5 text-sm text-gray-400">Cung đã đào</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-white">{now ? formatSupply(mined) : "—"}</p>
      <p className="text-sm text-gray-400">trên {formatSupply(MAX_SUPPLY)} {TOKEN_SYMBOL}</p>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#0b0f17]" aria-hidden>
        <div className="meter-fill h-full rounded-full bg-[#8a63d2]" style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="mt-2 text-sm text-gray-400 tabular-nums">
        {formatPct(ratio)} của era {era}
        {now ? ` · còn ${formatSupply(remainTokens)} tới halving` : ""}
      </p>
      <p className="mt-1 text-sm text-gray-400">
        {next ? `Halving kế, ước tính ${formatWhen(next)}` : "Đã qua các mốc halving"}
        {" · "}
        {formatSupply(daily)} / ngày ở era này
      </p>

      <h3 className="mt-6 font-semibold text-white">Lịch thưởng</h3>
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
                {current ? " · hiện tại" : ""}
              </span>
              <span className="text-right text-sm tabular-nums">
                <span className="font-semibold text-white">{formatTokens(sessionReward(index))}</span>
                <span className="text-gray-400"> / phiên</span>
              </span>
            </li>
          )
        })}
      </ul>

      <h3 className="mt-6 font-semibold text-white">Cast gần đây</h3>
      <ul className="mt-3 grid gap-3">
        {mining && castText ? (
          <FeedRow handle={handle || "ban"} text={castText} ago={now && castAt ? now - castAt : 0} you />
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
          <span className="font-semibold text-white">@{handle || "ban"}</span>
          <span className="text-gray-400"> · {you ? "bạn · " : ""}{formatAgo(ago)}</span>
        </span>
        <span className="mt-0.5 block text-sm text-gray-400">{text}</span>
      </span>
    </li>
  )
}

function TokenPanel({
  payout,
  onPayout,
  era,
  reward,
}: {
  payout: string
  onPayout: (value: string) => void
  era: number
  reward: number
}) {
  const [copied, setCopied] = useState(false)
  const payoutOk = validPayout(payout)
  const facts = [
    ["Ký hiệu", TOKEN_SYMBOL],
    ["Chuỗi", `Base · ${CHAIN_ID}`],
    ["Chuẩn", "ERC-20"],
    ["Thập phân", "18"],
    ["Tổng cung", "21 tỷ"],
    ["Phiên", "8 giờ"],
    ["Era hiện tại", String(era)],
    ["Thưởng lúc này", `${formatTokens(reward)} / phiên`],
  ]

  return (
    <section className="rounded-2xl border border-gray-800 bg-[#141b26] p-5">
      <h2 className="text-lg font-semibold text-white">$TOKENCAST trên Base</h2>
      <p className="mt-2 text-sm text-gray-400">
        Proof of Cast. Không đào bằng máy. Mỗi người một phiên, thưởng khóa lúc cast, và không có đúc thêm.
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-gray-800 bg-gray-800">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-[#141b26] px-3 py-3">
            <dt className="text-sm text-gray-400">{label}</dt>
            <dd className="mt-1 font-semibold tabular-nums text-white">{value}</dd>
          </div>
        ))}
      </dl>

      <h3 className="mt-6 font-semibold text-white">Cách thưởng giảm</h3>
      <p className="mt-2 text-sm text-gray-400">
        Era 0 trả {formatTokens(INITIAL_SESSION_REWARD)} {TOKEN_SYMBOL} cho 8 giờ, tức {formatTokens(INITIAL_SESSION_REWARD / 8)} token mỗi giờ.
        Khi cung chạm 10.5 tỷ (50%), thưởng còn một nửa. Mốc sau là 75%, rồi 87.5%, giống Bitcoin.
        Tổng các era cộng lại khít 21 tỷ.
      </p>
      <p className="mt-2 text-sm text-gray-400">
        Hợp đồng chưa nằm trên Base. Thông số trên là bản khóa để phát hành. Sổ trong app này là số dư phiên của bạn,
        chưa phải token trong ví.
      </p>

      <label className="mt-5 block">
        <span className="text-sm text-gray-400">Địa chỉ nhận trên Base, khi claim mở</span>
        <input
          value={payout}
          onChange={(event) => onPayout(event.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoCapitalize="none"
          aria-label="Địa chỉ ví Base"
          className="mt-1 h-12 w-full rounded-xl border border-gray-700 bg-[#0b0f17] px-3 font-sans text-base text-white outline-none placeholder:text-gray-500"
        />
      </label>
      <p className="mt-2 text-sm text-gray-400">
        {payout.length === 0 ? "Để trống cũng đào được." : payoutOk ? "Địa chỉ hợp lệ. Chỉ lưu trên máy bạn." : "Cần đúng 42 ký tự, bắt đầu bằng 0x."}
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
        {copied ? "Đã chép thông số" : "Chép thông số phát hành"}
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
    `⛏️ Mở phiên đào $TOKENCAST trên MineCast. 8 tiếng, era ${era}. Càng đào càng hiếm.`,
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
            <h2 id={titleId} className="text-lg font-semibold">Cast mở phiên</h2>
            <p className="mt-1 text-sm text-gray-400">
              Phiên này khóa {formatTokens(reward)} {TOKEN_SYMBOL} trong 8 giờ.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Đóng"
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
              setLocalError("Cast trống thì chưa mở được phiên.")
              return
            }
            if (body.length > 1024) {
              setLocalError("Cast dài quá 1024 ký tự.")
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
            aria-label="Nội dung cast"
            className="w-full resize-none rounded-xl border border-gray-700 bg-[#0b0f17] px-3 py-3 text-base leading-normal text-white outline-none focus:border-[#8a63d2]"
          />
          <p className="mt-2 text-right text-sm text-gray-400 tabular-nums">{text.trim().length}/1024</p>
          {error ? <p className="mt-2 rounded-xl bg-red-500/20 px-3 py-2 text-sm text-red-300">{error}</p> : null}
          <p className="mt-3 text-sm text-gray-400">
            Trong Warpcast, nút này mở composer thật và chỉ đào khi bạn đăng. Ở bản xem trước, cast ghi vào nhật ký
            rồi phiên 8 giờ bắt đầu.
          </p>
          <button
            type="submit"
            disabled={busy || tooLong}
            className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] text-base font-semibold text-white transition hover:bg-[#7c52c8] disabled:opacity-50"
          >
            <Send className="size-4" />
            {busy ? "Đang đăng cast…" : "Đăng cast và đào 8 giờ"}
          </button>
        </form>
      </div>
    </div>
  )
}
