import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { getAddress, isAddress, parseUnits, type Address } from "viem"
import { base, baseSepolia } from "viem/chains"
import { Layers, Radio, Wallet, Vote, RefreshCw, ExternalLink, Check, Loader2, ArrowDownToLine, Send } from "lucide-react"
import { bootFarcaster, composeOnFarcaster, connectFarcasterWallet, ethereumProviderForChain, farcasterFetch, type FarcasterIdentity, type EthereumProvider } from "./lib/farcaster"
import { createV4Client } from "./lib/v4/client"
import { deploymentKey, parseV4Config, type V4Config } from "./lib/v4/config"
import { readV4Network, readV4Day, readV4Stake, readV4Dao, type V4Network, type V4Stake, type V4Dao } from "./lib/v4/read"
import { executeV4Action, confirmV4Transaction, friendlyV4Error, isRejection, type PendingV4Tx, type TxProgress, type V4Action } from "./lib/v4/transactions"
import { countdown, miningPhase, phaseDeadline, monthAt, monthStart, previousMonth, tokens, validMonth, DAY, type V4Session, type MiningDay, type MiningPhase } from "./lib/v4/state"
import { estimateV4Reward } from "./lib/v4/estimates"
import { useLiveStats } from "./lib/v4/use-live-stats"
import "./v4.css"

const configuration = parseV4Config(import.meta.env)
const labels: Record<MiningPhase, string> = {
  mining: "Mining in progress", waiting: "Waiting for daily report", publishing: "Publishing rewards", review: "Report under review",
  activate: "Ready to open claims", claimable: "Ready to claim", claimed: "Reward claimed", expired: "Claim window ended",
  excluded: "No allocation for this wallet", contested: "Report disputed", missed: "Daily report deadline passed",
}
const date = (seconds: bigint) => seconds > 0n ? new Date(Number(seconds) * 1000).toLocaleString() : "—"
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
function load<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(key) ?? "null") } catch { return null } }
function save(key: string, value: unknown) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)) } catch { /* Chain remains authoritative. */ } }
function FarcasterIcon() { return <svg viewBox="10 11 34 34" fill="currentColor" aria-hidden="true"><path d="M12 15h30v3.5h-4v3.5h4v19h-6l-2.4-12.5C32.8 24.2 30.3 22 27 22s-5.8 2.2-6.6 6.5L18 41h-6V22h4v-3.5h-4Z" /></svg> }
function Card({ title, children }: { title: string; children: ReactNode }) { return <section className="v4-card"><h2>{title}</h2>{children}</section> }
function Stat({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div> }
function Button({ children, onClick, disabled, secondary = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; secondary?: boolean }) {
  return <button type="button" className={secondary ? "v4-button secondary" : "v4-button"} onClick={onClick} disabled={disabled}>{children}</button>
}

export default function V4App() {
  // Tell the host we are ready even while deployment configuration is incomplete.
  useEffect(() => { void bootFarcaster() }, [])
  return configuration.config ? <ConnectedV4 config={configuration.config} /> : <div className="minecast-app v4-app"><div className="v4-shell">
    <Brand network="V4" /><Card title="V4 is getting ready"><p>{configuration.error}</p><p>Deployment addresses will be published before mining opens.</p></Card>
  </div></div>
}
function Brand({ network }: { network: string }) { return <header className="v4-brand"><div><img src="/tokencast-logo.png" alt="" /><h1>MineCast <small>V4</small></h1></div><span className="mc-network"><span className="v4-base" />{network}</span></header> }

function ConnectedV4({ config }: { config: V4Config }) {
  const chain = config.chainId === 84532 ? baseSepolia : base
  const [client] = useState(() => createV4Client(config, import.meta.env.VITE_V4_RPC_URL))
  const scope = `minecast:v4:${deploymentKey(config)}`
  const [tab, setTab] = useState("mine")
  const [identity, setIdentity] = useState<FarcasterIdentity | null>(null)
  const [account, setAccount] = useState<Address | undefined>(() => { const a = load<string>(`${scope}:account`); return a && isAddress(a) ? getAddress(a) : undefined })
  const [provider, setProvider] = useState<EthereumProvider | null>(null)
  const [network, setNetwork] = useState<V4Network | null>(null)
  const [dayData, setDayData] = useState<MiningDay | null>(null)
  const [stake, setStake] = useState<V4Stake | null>(null)
  const [dao, setDao] = useState<V4Dao | null>(null)
  const [sessions, setSessions] = useState<V4Session[]>([])
  const [eligible, setEligible] = useState(false)
  const [sessionMessage, setSessionMessage] = useState("")
  const [dayInput, setDayInput] = useState("")
  const [epochInput, setEpochInput] = useState("")
  const [monthInput, setMonthInput] = useState("")
  const [stakeAmount, setStakeAmount] = useState("")
  const [castLink, setCastLink] = useState("")
  const [castText, setCastText] = useState("Mining with the Farcaster community on MineCast. Join my next 24-hour session!")
  const [error, setError] = useState("")
  const [sessionError, setSessionError] = useState("")
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [tx, setTx] = useState<TxProgress>({ status: "idle", message: "" })
  const [pending, setPending] = useState<PendingV4Tx | null>(null)
  const [updated, setUpdated] = useState(0)
  const [clock, setClock] = useState(Date.now())
  const sequence = useRef(0), actionBusy = useRef(false)
  const accountRef = useRef(account)
  accountRef.current = account
  const sessionsRef = useRef<V4Session[]>([])
  const explorer = chain.blockExplorers.default.url
  const pendingKey = `${scope}:${account?.toLowerCase()}:tx`
  const castKey = `${scope}:${identity?.fid}:${account?.toLowerCase()}:cast`
  useEffect(() => { void bootFarcaster().then(setIdentity) }, [])
  useEffect(() => { sessionsRef.current = []; setSessions([]) }, [identity?.fid])
  useEffect(() => { const id = window.setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(id) }, [])
  useEffect(() => {
    save(`${scope}:account`, account ?? null)
    const stored = load<PendingV4Tx>(pendingKey)
    const valid = stored && /^0x[0-9a-f]{64}$/i.test(stored.hash) && typeof stored.account === "string" && stored.account.toLowerCase() === account?.toLowerCase()
      && isAddress(stored.to) && /^0x[0-9a-f]*$/i.test(stored.data) && typeof stored.label === "string"
    setPending(valid ? stored : null)
    setTx(valid ? { status: "pending", hash: stored.hash, message: "A previous transaction is awaiting confirmation. Check its status." } : { status: "idle", message: "" })
    setNetwork(null); setDayData(null); setStake(null); setDao(null); setUpdated(0)
    return () => { sequence.current++ }
  }, [account, pendingKey, scope])
  useEffect(() => { setCastLink(load<string>(castKey) ?? "") }, [castKey])
  useEffect(() => {
    const p = provider as EthereumProvider & { on?: (event: string, fn: (...args: any[]) => void) => void; removeListener?: (event: string, fn: (...args: any[]) => void) => void } | null
    const changed = (accounts: string[]) => { sequence.current++; setAccount(accounts[0] && isAddress(accounts[0]) ? getAddress(accounts[0]) : undefined) }
    const chainChanged = () => { setUpdated(0); setError("Wallet network changed. Connect again to confirm the network.") }
    p?.on?.("accountsChanged", changed); p?.on?.("chainChanged", chainChanged)
    return () => { p?.removeListener?.("accountsChanged", changed); p?.removeListener?.("chainChanged", chainChanged) }
  }, [provider])

  const refresh = useCallback(async () => {
    const current = ++sequence.current
    setRefreshing(true)
    try {
      if ((dayInput && !/^\d{1,8}$/.test(dayInput)) || (epochInput && !/^\d{1,8}$/.test(epochInput)) || (monthInput && !validMonth(monthInput))) throw Error("Enter a valid day/epoch number or UTC month in YYYYMM format.")
      const n = await readV4Network(client, config, account)
      const readAt = Date.now()
      let rows: V4Session[] = [], canCast = false, reason = "Open inside Farcaster to start a session.", intakeError = ""
      if (identity) {
        try {
          const response = await farcasterFetch("/api/v4/mining", { signal: AbortSignal.timeout(12000) })
          const body = await response.json()
          if (!response.ok) throw Error(body.error || "Session service unavailable.")
          if (body.protocol !== "open-v4-quorum-1" || body.chainId !== config.chainId || body.distributor?.toLowerCase() !== config.distributor.toLowerCase() || body.fid !== identity.fid) throw Error("Session server does not match this V4 deployment or identity.")
          rows = body.sessions.filter((s: V4Session) => Number.isSafeInteger(s.day) && s.day >= 0 && Number.isFinite(Date.parse(s.ends_at)))
          canCast = body.eligible === true; reason = body.reason
        } catch (e) { rows = sessionsRef.current; intakeError = friendlyV4Error(e); reason = "Session verification is temporarily unavailable." }
      }
      const selectedDay = /^\d{1,8}$/.test(dayInput) ? BigInt(dayInput) : rows.length ? BigInt(rows[0].day) : n.day
      const selectedEpoch = /^\d{1,8}$/.test(epochInput) ? BigInt(epochInput) : (n.timestamp > n.launch + 30n * DAY ? (n.timestamp - n.launch) / (30n * DAY) - 1n : 0n)
      const month = validMonth(monthInput) ? BigInt(monthInput) : monthAt(n.timestamp)
      const [d, st, gov] = await Promise.all([readV4Day(client, config, n, selectedDay, account), readV4Stake(client, config, n, selectedEpoch, account), readV4Dao(client, config, n, month, account)])
      if (current !== sequence.current) return
      sessionsRef.current = rows
      setNetwork(n); setDayData(d); setStake(st); setDao(gov); setSessions(rows); setEligible(canCast)
      setSessionMessage(reason); setSessionError(intakeError); setUpdated(readAt); setError("")
    } catch (e) { if (current === sequence.current) { setError(friendlyV4Error(e)); setUpdated(0); setEligible(false) } }
    finally { if (current === sequence.current) setRefreshing(false) }
  }, [client, config, account, identity, dayInput, epochInput, monthInput])
  useEffect(() => {
    void refresh()
    const visible = () => { if (document.visibilityState === "visible") void refresh() }
    const timer = window.setInterval(visible, 20000)
    window.addEventListener("focus", visible); window.addEventListener("pageshow", visible); document.addEventListener("visibilitychange", visible)
    return () => { clearInterval(timer); sequence.current++; window.removeEventListener("focus", visible); window.removeEventListener("pageshow", visible); document.removeEventListener("visibilitychange", visible) }
  }, [refresh])

  const timestamp = network ? network.timestamp + BigInt(updated ? Math.max(0, Math.floor((clock - updated) / 1000)) : 0) : 0n
  const session = sessions.find(s => BigInt(s.day) === dayData?.day)
  const phase = dayData ? miningPhase(dayData, timestamp, session) : null
  const live = useLiveStats(config, tab === "mine" ? dayData?.day : undefined)
  const statsFresh = live.receivedAt > 0 && clock - live.receivedAt < 45000 && !live.unavailable
  const estimate = statsFresh && live.data && dayData && !dayData.certifiedAt && !dayData.contested && ["mining", "waiting"].includes(phase ?? "")
    ? estimateV4Reward(dayData.pool, live.data, session?.estimated_weight) : null
  const deadline = dayData && phase ? phaseDeadline(dayData, phase, session) : 0n
  const fresh = updated > 0 && clock - updated < 45000 && !error
  const locked = busy || Boolean(pending) || !fresh || !account
  const remember = (value: PendingV4Tx | null) => { save(pendingKey, value); if (accountRef.current === account) setPending(value) }
  const updateTransaction = (value: TxProgress) => { if (accountRef.current === account) setTx(value) }

  async function connect() {
    if (actionBusy.current) return
    actionBusy.current = true; setBusy(true)
    try { setAccount(getAddress(await connectFarcasterWallet(config.chainId))); setProvider(await ethereumProviderForChain(config.chainId)); setError("") }
    catch (e) { if (!isRejection(e)) setError(friendlyV4Error(e)) }
    finally { actionBusy.current = false; setBusy(false) }
  }
  async function transact(action: V4Action) {
    if (locked || !account || actionBusy.current) return
    actionBusy.current = true; setBusy(true)
    try { await executeV4Action(client, config, account, action, updateTransaction, remember); if (accountRef.current === account) await refresh() }
    finally { actionBusy.current = false; setBusy(false) }
  }
  async function checkPending() {
    if (!pending || actionBusy.current) return
    actionBusy.current = true; setBusy(true)
    try { await confirmV4Transaction(client, pending, updateTransaction, remember); if (accountRef.current === account) await refresh() }
    finally { actionBusy.current = false; setBusy(false) }
  }
  async function amountAction(kind: "stake" | "withdraw") {
    try {
      if (!/^\d+(\.\d{1,18})?$/.test(stakeAmount.trim())) throw Error("Enter a token amount, using up to 18 decimal places.")
      const amount = parseUnits(stakeAmount.trim(), 18)
      if (amount <= 0n) throw Error("Enter an amount greater than zero.")
      await transact({ kind, amount })
    } catch (e) { setTx({ status: "error", message: friendlyV4Error(e) }) }
  }
  async function postCast(recover: boolean) {
    if (!identity || !account || actionBusy.current || locked) return
    actionBusy.current = true; setBusy(true); setSessionError("")
    try {
      let identifier = recover ? castLink.trim() : ""
      if (!identifier) {
        const gateResponse = await farcasterFetch("/api/v4/mining", { signal: AbortSignal.timeout(12000) })
        const gate = await gateResponse.json()
        if (gateResponse.ok && (gate.protocol !== "open-v4-quorum-1" || gate.chainId !== config.chainId || gate.distributor?.toLowerCase() !== config.distributor.toLowerCase() || gate.fid !== identity.fid)) throw Error("Session server does not match this V4 deployment or identity.")
        if (!gateResponse.ok || !gate.eligible) throw Error(gate.error || gate.reason || "A new session is not available yet.")
        const posted = await composeOnFarcaster(castText)
        if (!posted.hash) throw Error("If your cast was posted, paste its link below to verify it. You do not need to publish again.")
        identifier = posted.hash
      }
      setCastLink(identifier); save(castKey, identifier)
      const response = await farcasterFetch("/api/v4/mining", { method: "POST", signal: AbortSignal.timeout(25000), headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId: config.chainId, distributor: config.distributor, walletAddress: account,
          ...(/^0x[0-9a-f]{40}$/i.test(identifier) ? { castHash: identifier } : { castUrl: identifier }) }) })
      const body = await response.json()
      if (!response.ok) throw Error(body.error || "Could not register your cast. Retry this cast.")
      if (body.chainId !== config.chainId || body.distributor?.toLowerCase() !== config.distributor.toLowerCase() || body.session?.fid !== identity.fid) throw Error("Unexpected session response. Refresh to reconcile your session.")
      save(castKey, null); setCastLink(""); setDayInput(String(body.session.day)); await refresh()
    } catch (e) { await refresh(); setSessionError(friendlyV4Error(e)) }
    finally { actionBusy.current = false; setBusy(false) }
  }

  return <div className="minecast-app v4-app"><div className="v4-shell">
    <Brand network={chain.name} />
    <div className="v4-toolbar"><button type="button" className="v4-wallet" onClick={() => void connect()} disabled={busy || Boolean(pending)}><Wallet size={17} />{account ? short(account) : "Connect Farcaster wallet"}</button>
      <button type="button" className="v4-icon-button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh chain data"><RefreshCw size={18} className={refreshing ? "animate-spin" : ""} /></button></div>
    {error && <div role="alert" className="v4-message error">{error}<button onClick={() => void refresh()}>Retry</button></div>}
    {!network && !error && <p role="status" className="v4-muted">Reading V4 contracts…</p>}
    {tx.message && <div role="status" aria-live="polite" className={`v4-message ${tx.status === "error" ? "error" : ""}`}>
      {tx.status === "confirmed" ? <Check size={17} /> : busy && <Loader2 size={17} className="animate-spin" />}<span>{tx.message}</span>
      {tx.hash && <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">View transaction <ExternalLink size={13} /></a>}
      {pending && <button disabled={busy} onClick={() => void checkPending()}>Check confirmation</button>}
    </div>}
    {network && <main>
      {tab === "mine" && <>
        <Card title="Mining session"><div className="v4-row"><span className="v4-muted">{identity ? `@${identity.username}` : "Open in Farcaster to cast"}</span><span className="mc-era">Day {String(dayData?.day ?? network.day)}</span></div>
          {timestamp < network.launch ? <div className="v4-countdown"><FarcasterIcon /><strong>{countdown(network.launch, timestamp)}</strong><span>Until launch</span></div>
            : <div className="v4-countdown"><FarcasterIcon /><strong>{deadline ? countdown(deadline, timestamp) : phase === "claimed" ? "Claimed" : !session && !dayData?.certifiedAt ? "24:00:00" : "—"}</strong><span>{!session && !dayData?.certifiedAt ? "Session duration" : phase ? labels[phase] : "Choose a mining day"}</span></div>}
          {session && account && session.wallet_address.toLowerCase() !== account.toLowerCase() && <p className="v4-muted">This session pays {short(session.wallet_address)}. Connect that wallet to claim its reward.</p>}
          {phase === "claimable" && dayData && <><div className="v4-reward">{tokens(dayData.amount)} <small>TOKENCAST</small></div><Button disabled={locked} onClick={() => void transact({ kind: "claim", day: dayData.day })}><ArrowDownToLine size={18} />Claim reward</Button><p className="v4-muted">Claim by {date(dayData.claimEnd)}</p></>}
          {phase === "claimed" && dayData && <p className="v4-success">{tokens(dayData.amount)} TOKENCAST claimed onchain.</p>}
          {phase === "activate" && dayData && <><p>Report review is complete. Opening claims starts the 24-hour claim window for this cohort.</p><Button disabled={locked} onClick={() => void transact({ kind: "activateDay", day: dayData.day })}>Open claim window</Button></>}
          {phase === "publishing" && dayData && <p className="v4-muted">{String(dayData.published)} / {String(dayData.leafCount)} allocations published.</p>}
          {dayData && !dayData.certifiedAt && session && ["mining", "waiting"].includes(phase ?? "") && <div className="v4-estimate" aria-live="polite">
            <span className="v4-muted">Estimated session reward</span><strong>{estimate === null ? "—" : `≈ ${tokens(estimate)} TOKENCAST`}</strong>
            <p className="v4-muted">Follower-only estimate across MineCast sessions. Node boosts and final validation may change it. Not claimable yet.</p>
          </div>}
          {phase === "review" && <p className="v4-muted">Allocations are under review. Claims open after the report is activated.</p>}
          <dl className="v4-stats"><Stat label={`Pool · day ${String(dayData?.day ?? network.day)}`}>{tokens(dayData?.pool ?? network.pool, 0)}</Stat><Stat label="Max per miner">{tokens((dayData?.pool ?? network.pool) / 100n, 0)}</Stat></dl>
          <div className="v4-live" data-testid="live-mining-stats"><dl className="v4-stats"><Stat label="Active miners">{live.data ? live.data.activeMiners.toLocaleString("en-US") : "—"}</Stat><Stat label="Miners in this cohort">{live.data ? live.data.cohortMiners.toLocaleString("en-US") : "—"}</Stat></dl>
            <p className="v4-muted">{live.data ? `${statsFresh ? "Updated" : "Last known"} ${new Date(live.data.observedAt).toLocaleTimeString()}` : live.unavailable ? "Live counts unavailable" : "Loading live counts…"} · MineCast sessions only · refresh ~20s</p>
            {live.data && live.data.estimatedMiners < live.data.cohortMiners && <p className="v4-muted">Some follower observations are missing. Reward estimates will stay unavailable until the cohort data is complete.</p>}
          </div>
          <details><summary>My mining days</summary><label>Day number<input aria-label="Mining day" inputMode="numeric" value={dayInput} placeholder={String(dayData?.day ?? network.day)} onChange={e => setDayInput(e.target.value)} /></label>
            <div className="v4-chips">{sessions.slice(0, 12).map(s => <button key={s.id} type="button" onClick={() => setDayInput(String(s.day))}>Day {s.day}</button>)}</div>
            <p className="v4-muted">You can read or claim any known day directly from Base, even if the session server is offline.</p></details>
        </Card>
        <Card title="Cast to mine"><p className="v4-muted">{sessionMessage}</p>
          {sessionError && <p role="alert" className="v4-error">{sessionError}</p>}
          <label className="sr-only" htmlFor="v4-cast">Suggested cast</label><textarea id="v4-cast" value={castText} maxLength={1024} onChange={e => setCastText(e.target.value)} rows={3} />
          <p className="v4-muted">Edit the text or add images in Farcaster before posting.</p>
          <Button disabled={locked || !identity || !eligible || !!castLink} onClick={() => void postCast(false)}><Send size={17} />Post cast & start 24h</Button>
          <details open={!!castLink}><summary>Already posted? Verify your cast</summary><label>Cast link or hash<input value={castLink} onChange={e => { setCastLink(e.target.value); save(castKey, e.target.value) }} placeholder="https://farcaster.xyz/…" /></label>
            <Button disabled={locked || !identity || !castLink.trim()} secondary onClick={() => void postCast(true)}>Verify this cast</Button></details>
          <details><summary>When can I claim?</summary><p>Each cohort starts at the contract's launch time plus whole 24-hour days, not a fixed 06:00 UTC cutoff. Your starting cohort determines your pool.</p>
            {dayData && <p>Cohort closes {date(dayData.end)}. Reports can be submitted from {date(dayData.end + DAY + dayData.workWindow)}.</p>}
            <p>A session lasts 24 hours. Nodes then publish the daily report and complete a 48-hour review. Your claim window lasts 24 hours after the cohort is activated.</p>
            <p>Estimates refresh throughout every hour as cohort participation changes. Finished sessions remain in the cohort denominator. Other apps may submit more miners, so these app counts are not a network-wide reward guarantee.</p></details>
        </Card>
      </>}
      {tab === "network" && <>
        <Card title="Open network"><dl className="v4-stats"><Stat label="Active validator bond">{tokens(network.totalBond, 0)}</Stat><Stat label="Minimum network bond">1,000,000</Stat><Stat label="Certificate threshold">More than ⅔</Stat><Stat label="Current day">{String(network.day)}</Stat></dl>
          <p>Mining reports use signatures weighted by bonded TOKENCAST. A single operator can bootstrap the network; offline stake still counts toward the threshold.</p></Card>
        <Card title="Reward policy"><dl className="v4-stats"><Stat label="Daily pool decline">0.5%</Stat><Stat label="Per-miner cap">1% of daily pool</Stat><Stat label="Node multiplier">×5 · combined cap ×100</Stat><Stat label="Unallocated surplus">5% staking · 95% DAO</Stat></dl>
          <p className="v4-muted">Follower and node-work inputs are certified by the node quorum. The allocation formula is enforced onchain.</p></Card>
      </>}
      {tab === "token" && <>
        <Card title="TOKENCAST"><div className="v4-reward">{account ? tokens(network.balance) : "—"} <small>in your wallet</small></div>
          <dl className="v4-stats"><Stat label="Total supply">{tokens(network.totalSupply, 0)}</Stat><Stat label="Lifetime minted">{tokens(network.cumulativeMinted, 0)}</Stat><Stat label="Lifetime maximum">21,000,000,000</Stat><Stat label="Dev premine">2,100,000</Stat></dl>
          <p className="v4-muted">Burns reduce total supply and never restore the mint limit.</p><a href={`${explorer}/token/${config.token}${account ? `?a=${account}` : ""}`} target="_blank" rel="noreferrer">View token on explorer <ExternalLink size={14} /></a></Card>
        <Card title="V4 contracts"><div className="v4-addresses">{(["token", "distributor", "staking", "dao", "registry"] as const).map(key => <a key={key} href={`${explorer}/address/${config[key]}`} target="_blank" rel="noreferrer"><span>{key}</span><code>{short(config[key])}</code><ExternalLink size={14} /></a>)}</div><p className="v4-muted">{chain.name} · verified component links · block {String(network.blockNumber)}</p></Card>
      </>}
      {tab === "dao" && <>
        <Card title="Stake"><dl className="v4-stats"><Stat label="Total staked">{tokens(network.totalStaked)}</Stat><Stat label="Your stake">{tokens(stake?.balance ?? 0n)}</Stat><Stat label="Voting power activated">{tokens(stake?.activePower ?? 0n)}</Stat><Stat label="Staking reward pool">{tokens(network.rewardLiability)}</Stat></dl>
          <label>Amount (TOKENCAST)<input inputMode="decimal" placeholder="0.00" value={stakeAmount} onChange={e => setStakeAmount(e.target.value)} /></label>
          <div className="v4-actions"><Button disabled={locked || !stakeAmount} onClick={() => void amountAction("stake")}>Stake</Button><Button disabled={locked || !stakeAmount || !stake || timestamp < stake.lockedUntil} secondary onClick={() => void amountAction("withdraw")}>Withdraw</Button></div>
          <p className="v4-muted">Every top-up locks your entire stake for another 30 days.</p>
          {stake && stake.balance > 0n && <p className="v4-muted">{timestamp < stake.lockedUntil ? `Locked until ${date(stake.lockedUntil)}` : "Your stake is unlocked."}</p>}
          <Button secondary disabled={locked || !stake || stake.balance === 0n || stake.activePower === stake.balance || timestamp < stake.lockedUntil} onClick={() => void transact({ kind: "activatePower" })}>Activate voting power</Button>
          <details><summary>Staking rewards</summary><label>Reward epoch<input inputMode="numeric" value={epochInput} placeholder={String(stake?.epoch ?? 0)} onChange={e => setEpochInput(e.target.value)} /></label>
            <p>Available: {tokens(stake?.claimable ?? 0n)} TOKENCAST</p><Button disabled={locked || !stake || stake.claimable === 0n} onClick={() => stake && void transact({ kind: "claimStake", epoch: stake.epoch })}>Claim staking reward</Button>
            <p className="v4-muted">Rewards use stake just before each fixed 30-day epoch. Claims last 90 days after finalization.</p>
            {stake && <Button secondary disabled={locked || timestamp < network.launch + (stake.nextEpoch + 1n) * 30n * DAY} onClick={() => void transact({ kind: "finalizeEpoch", epoch: stake.nextEpoch })}>Prepare epoch {String(stake.nextEpoch)} rewards</Button>}
            {stake?.canSweep && <Button secondary disabled={locked} onClick={() => void transact({ kind: "sweepEpoch", epoch: stake.epoch })}>Roll expired rewards forward</Button>}
            <Button secondary disabled={locked} onClick={() => void transact({ kind: "revokeApproval" })}>Remove staking approval</Button></details>
        </Card>
        <Card title="Community vote"><label>Month (UTC · YYYYMM)<input inputMode="numeric" value={monthInput} placeholder={String(dao?.month ?? monthAt(timestamp))} onChange={e => setMonthInput(e.target.value)} /></label>
          <div className="v4-chips">{[monthAt(timestamp), previousMonth(monthAt(timestamp)), previousMonth(previousMonth(monthAt(timestamp)))].map(m => <button key={String(m)} onClick={() => setMonthInput(String(m))}>{String(m)}</button>)}</div>
          {dao && <><div className="v4-row"><h3>{dao.airdrop ? "Miner airdrop" : "Treasury burn"}</h3><span className="mc-era">{dao.settled ? "Settled" : dao.voteEnd === 0n ? "Not opened" : timestamp < dao.voteEnd ? "Voting open" : "Voting closed"}</span></div>
            <dl className="v4-stats"><Stat label="Yes">{tokens(dao.yes, 0)}</Stat><Stat label="No">{tokens(dao.no, 0)}</Stat><Stat label="Your snapshot power">{tokens(dao.power, 0)}</Stat><Stat label="Round budget">{tokens(dao.budget, 0)}</Stat></dl>
            <div className="v4-actions"><Button disabled={locked || dao.voted || dao.power === 0n || timestamp >= dao.voteEnd} onClick={() => void transact({ kind: "vote", month: dao.month, yes: true })}>{dao.voted ? "Vote recorded" : "Yes"}</Button><Button secondary disabled={locked || dao.voted || dao.power === 0n || timestamp >= dao.voteEnd} onClick={() => void transact({ kind: "vote", month: dao.month, yes: false })}>No</Button></div>
            {dao.voteEnd > 0n && <p className="v4-muted">Voting ends {date(dao.voteEnd)}. Yes must exceed No; a passing result waits another 72 hours.</p>}
            {dao.claimable > 0n && <Button disabled={locked} onClick={() => void transact({ kind: "claimAirdrop", month: dao.month })}>Claim {tokens(dao.claimable)} airdrop</Button>}
            {dao.canSettle && <Button secondary disabled={locked} onClick={() => void transact({ kind: "settleVote", month: dao.month })}>Execute vote result</Button>}
            {dao.canFinalizeMonth && <Button secondary disabled={locked} onClick={() => void transact({ kind: "finalizeMonth", timestamp: monthStart(dao.month) })}>Close prior mining month</Button>}
            {dao.canOpen && <Button secondary disabled={locked} onClick={() => void transact({ kind: "openVote" })}>Open this month's vote</Button>}
            <details><summary>Voting schedule & treasury</summary><p>Odd months: miner airdrop. Even months: burn. A round can open after the prior month closes, normally from the 11th through the 21st UTC. Stake for 30 days and activate your power before the round opens.</p>
              <dl className="v4-stats"><Stat label="Treasury balance">{tokens(network.treasuryBalance)}</Stat><Stat label="Reserved for votes">{tokens(network.reserved)}</Stat></dl>
              {dao.claimEnd > 0n && <p className="v4-muted">Airdrop claims end {date(dao.claimEnd)}.</p>}
              {dao.claimEnd > 0n && timestamp >= dao.claimEnd && dao.remaining > 0n && <Button secondary disabled={locked} onClick={() => void transact({ kind: "releaseAirdrop", month: dao.month })}>Release expired airdrop reserve</Button>}</details>
          </>}
        </Card>
      </>}
    </main>}
    <nav className="v4-nav" aria-label="Main navigation">{[["mine", "Mine", FarcasterIcon], ["network", "Network", Radio], ["token", "Token", Layers], ["dao", "DAO", Vote]].map(([key, label, Icon]) => {
      const Glyph = Icon as typeof FarcasterIcon
      return <button key={String(key)} type="button" aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(String(key)); window.scrollTo(0, 0) }}><Glyph /><span>{String(label)}</span></button>
    })}</nav>
  </div></div>
}
