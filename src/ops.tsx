import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { createWalletClient, custom, formatUnits, getAddress } from "viem";
import { Activity, ArrowDownToLine, BarChart3, Database, Loader2, LockKeyhole, Pickaxe, RefreshCw, ShieldCheck, Users, Wallet, WalletCards } from "lucide-react";
import "./index.css";

type Eip1193Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

type Dashboard = {
  generatedAt: string;
  metrics: { miners: number; activeSessions: number; settledSessions: number; claimedAllocations: number; availableWei: string; voucherWei: string; claimedWei: string };
  miners: Array<{ fid: number; username: string | null; wallet_address: string | null; follower_count: number; created_at: string }>;
  sessions: Array<{ id: string; fid: number; reward_wei: string; reward_weight: string; started_at: string; ends_at: string; settled_at: string | null }>;
  claims: Array<{ id: string; fid: number; wallet_address: string; amount_wei: string; status: string; created_at: string }>;
  trend: Array<{ date: string; sessions: number; settledSessions: number; rewardWei: string; claims: number; claimedWei: string }>;
};

declare global { interface Window { ethereum?: Eip1193Provider } }

const SESSION_KEY = "minecast.ops.session";

function tokens(wei: string): string {
  try { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(formatUnits(BigInt(wei), 18))); }
  catch { return "—"; }
}

function compact(address: string | null): string { return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"; }
function date(value: string): string { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function shortDate(value: string): string { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)); }

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(SESSION_KEY) ?? "");
  const [wallet, setWallet] = useState("");
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [section, setSection] = useState<"overview" | "activity" | "treasury">("overview");

  async function load(sessionToken = token) {
    if (!sessionToken) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/overview", { headers: { "x-minecast-admin-token": sessionToken } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load operations data.");
      setData(body as Dashboard);
      setNotice("");
    } catch (cause) {
      sessionStorage.removeItem(SESSION_KEY);
      setToken("");
      setData(null);
      setNotice(cause instanceof Error ? cause.message : "Could not load operations data.");
    } finally { setBusy(false); }
  }

  useEffect(() => { if (token) void load(token); }, []);

  async function signIn() {
    const provider = window.ethereum;
    if (!provider) { setNotice("Open this page in a browser with your admin wallet, such as MetaMask or Coinbase Wallet."); return; }
    setBusy(true);
    setNotice("");
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
      const account = accounts[0];
      if (!account) throw new Error("No wallet account was selected.");
      const normalized = getAddress(account);
      const challengeResponse = await fetch(`/api/admin/challenge?wallet=${encodeURIComponent(normalized)}`);
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok) throw new Error(challenge.error || "Could not start admin authentication.");
      const walletClient = createWalletClient({ transport: custom(provider as any) });
      const signature = await walletClient.signMessage({ account: normalized, message: challenge.message });
      const authResponse = await fetch("/api/admin/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet: normalized, expiresAt: challenge.expiresAt, nonce: challenge.nonce, signature }) });
      const auth = await authResponse.json();
      if (!authResponse.ok) throw new Error(auth.error || "Admin signature was rejected.");
      sessionStorage.setItem(SESSION_KEY, auth.token);
      setWallet(normalized);
      setToken(auth.token);
      await load(auth.token);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Admin sign-in failed.";
      if (!/user rejected|user denied|rejected the request/i.test(message)) setNotice(message);
    } finally { setBusy(false); }
  }

  function signOut() { sessionStorage.removeItem(SESSION_KEY); setToken(""); setData(null); setWallet(""); setNotice(""); }

  if (!token || !data) return <Login busy={busy} notice={notice} onSignIn={() => void signIn()} />;

  const cards = [
    ["Miners in", data.metrics.miners.toLocaleString(), "Verified identities"],
    ["Mining live", data.metrics.activeSessions.toLocaleString(), "Unsettled sessions"],
    ["Sessions settled", data.metrics.settledSessions.toLocaleString(), "24h cycles completed"],
    ["Claimed out", data.metrics.claimedAllocations.toLocaleString(), "Onchain withdrawals"],
    ["Available", `${tokens(data.metrics.availableWei)} TOKENCAST`, "Awaiting a claim"],
    ["Voucher locked", `${tokens(data.metrics.voucherWei)} TOKENCAST`, "Awaiting wallet tx"],
    ["Token outflow", `${tokens(data.metrics.claimedWei)} TOKENCAST`, "Completed claims"],
  ];
  const navigation = [
    ["overview", "Overview", BarChart3],
    ["activity", "Mining activity", Activity],
    ["treasury", "Treasury", WalletCards],
  ] as const;
  return <main className="min-h-dvh bg-[#0b0f17] text-[#f3f4f6]"><div className="mx-auto flex min-h-dvh max-w-[1440px]">
    <aside className="hidden w-60 shrink-0 border-r border-gray-800 bg-[#101620] p-5 md:block"><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-[#8a63d2] font-black">⛏</div><div><p className="font-bold">MineCast Ops</p><p className="text-xs text-gray-500">Private command center</p></div></div><nav className="mt-10 space-y-1">{navigation.map(([id, label, Icon]) => <button key={id} onClick={() => setSection(id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition ${section === id ? "bg-[#8a63d2]/20 text-[#d8c7ff]" : "text-gray-400 hover:bg-white/5 hover:text-white"}`}><Icon className="size-4" />{label}</button>)}</nav><div className="mt-10 rounded-2xl border border-[#8a63d2]/20 bg-[#8a63d2]/10 p-4"><p className="text-xs font-semibold text-[#d8c7ff]">PORTAL ROADMAP</p><p className="mt-2 text-xs leading-5 text-gray-400">Prepared for airdrops, analytics, exports and new operator apps without changing the public Mini App.</p></div></aside>
    <div className="min-w-0 flex-1 px-4 py-5 sm:px-7 sm:py-8"><header className="flex flex-wrap items-center justify-between gap-4"><div><p className="flex items-center gap-2 text-sm font-semibold text-[#c4b5fd]"><ShieldCheck className="size-4" /> Private operations</p><h1 className="mt-1 text-2xl font-bold">{section === "overview" ? "Protocol overview" : section === "activity" ? "Mining activity" : "Treasury & claims"}</h1><p className="mt-1 text-sm text-gray-400">Live ledger data, not browser-provided values.</p></div><div className="flex items-center gap-2"><button onClick={() => void load()} disabled={busy} className="flex h-11 items-center gap-2 rounded-xl bg-[#8a63d2] px-4 text-sm font-semibold disabled:opacity-60"><RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> Refresh</button><button onClick={signOut} className="h-11 rounded-xl border border-gray-700 px-4 text-sm font-semibold">Sign out</button></div></header>
      <div className="mt-5 flex gap-2 overflow-x-auto md:hidden">{navigation.map(([id, label, Icon]) => <button key={id} onClick={() => setSection(id)} className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold ${section === id ? "bg-[#8a63d2] text-white" : "border border-gray-700 text-gray-400"}`}><Icon className="size-4" />{label}</button>)}</div>
      {section === "overview" ? <Overview cards={cards} trend={data.trend} /> : null}
      {section === "activity" ? <ActivityView miners={data.miners} sessions={data.sessions} /> : null}
      {section === "treasury" ? <TreasuryView claims={data.claims} available={data.metrics.availableWei} voucher={data.metrics.voucherWei} claimed={data.metrics.claimedWei} /> : null}
      <p className="py-6 text-center text-xs text-gray-600">Authenticated admin wallet: {compact(wallet)} · data generated {date(data.generatedAt)}</p>
    </div>
  </div></main>;
}

function Login({ busy, notice, onSignIn }: { busy: boolean; notice: string; onSignIn: () => void }) { return <main className="grid min-h-dvh place-items-center bg-[#0b0f17] p-4 text-[#f3f4f6]"><section className="w-full max-w-md rounded-3xl border border-[#8a63d2]/40 bg-[#141b26] p-7 shadow-2xl"><div className="grid size-12 place-items-center rounded-2xl bg-[#8a63d2]/20 text-[#c4b5fd]"><LockKeyhole className="size-6" /></div><p className="mt-5 text-sm font-semibold text-[#c4b5fd]">PRIVATE OPERATIONS PORTAL</p><h1 className="mt-1 text-2xl font-bold">MineCast Treasury Console</h1><p className="mt-3 text-sm leading-6 text-gray-400">A standalone operator portal for analytics, treasury and future MineCast tools. Sign a time-limited login message with the authorized desktop wallet; this never creates an onchain transaction or spends gas.</p>{notice ? <p className="mt-4 rounded-xl bg-red-500/10 px-3 py-3 text-sm text-red-200" role="alert">{notice}</p> : null}<button onClick={onSignIn} disabled={busy} aria-busy={busy} className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#8a63d2] font-semibold text-white disabled:opacity-60">{busy ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}{busy ? "Connecting…" : "Connect admin wallet"}</button><p className="mt-4 text-center text-xs text-gray-600">MineCast operations · restricted access</p></section></main>; }

function Overview({ cards, trend }: { cards: string[][]; trend: Dashboard["trend"] }) {
  const sessions = useMemo(() => trend.map((row) => row.sessions), [trend]);
  return <><div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, note]) => <article key={label} className="rounded-2xl border border-gray-800 bg-[#141b26] p-4"><p className="text-sm text-gray-400">{label}</p><p className="mt-2 truncate text-xl font-bold tabular-nums">{value}</p><p className="mt-1 text-xs text-gray-500">{note}</p></article>)}</div><section className="mt-5 rounded-2xl border border-gray-800 bg-[#141b26] p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">New sessions · 30 days</h2><p className="mt-1 text-xs text-gray-500">Daily sessions entering the verified mining ledger.</p></div><Pickaxe className="size-5 text-[#c4b5fd]" /></div><LineChart values={sessions} labels={trend.map((row) => row.date)} /></section><section className="mt-5 grid gap-5 xl:grid-cols-2"><TrendTable title="Mining distribution" rows={trend.slice().reverse().slice(0, 8).map((row) => [shortDate(row.date), row.sessions.toString(), row.settledSessions.toString(), `${tokens(row.rewardWei)} TOKENCAST`])} headers={["Day", "Started", "Settled", "Reward allocated"]} /><TrendTable title="Onchain claim activity" rows={trend.slice().reverse().slice(0, 8).map((row) => [shortDate(row.date), row.claims.toString(), `${tokens(row.claimedWei)} TOKENCAST`])} headers={["Day", "Claims", "Claimed out"]} /></section></>;
}

function ActivityView({ miners, sessions }: Pick<Dashboard, "miners" | "sessions">) { return <div className="mt-6 space-y-5"><Table title="Latest verified miners" headers={["Miner", "Followers", "Payout wallet", "Joined"]}>{miners.map((row) => <tr key={row.fid}><td>@{row.username || `fid-${row.fid}`} <span className="text-xs text-gray-500">#{row.fid}</span></td><td>{Number(row.follower_count || 0).toLocaleString()}</td><td className="font-mono text-xs">{compact(row.wallet_address)}</td><td>{date(row.created_at)}</td></tr>)}</Table><Table title="Mining sessions" headers={["FID", "Weight", "Estimated reward", "Started", "State"]}>{sessions.map((row) => <tr key={row.id}><td>#{row.fid}</td><td>{row.reward_weight}×</td><td>{tokens(row.reward_wei)} TOKENCAST</td><td>{date(row.started_at)}</td><td><span className={`rounded-full px-2 py-1 text-xs font-semibold ${row.settled_at ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-200"}`}>{row.settled_at ? "Settled" : "Active"}</span></td></tr>)}</Table></div>; }

function TreasuryView({ claims, available, voucher, claimed }: Pick<Dashboard, "claims"> & { available: string; voucher: string; claimed: string }) { return <div className="mt-6 space-y-5"><div className="grid gap-3 sm:grid-cols-3">{[["Available", available, Users], ["Voucher locked", voucher, Database], ["Claimed out", claimed, ArrowDownToLine]].map(([label, value, Icon]) => { const StatIcon = Icon as typeof Users; return <article key={label as string} className="rounded-2xl border border-gray-800 bg-[#141b26] p-5"><StatIcon className="size-5 text-[#c4b5fd]" /><p className="mt-4 text-sm text-gray-400">{label as string}</p><p className="mt-1 text-xl font-bold">{tokens(value as string)} TOKENCAST</p></article>; })}</div><Table title="TOKENCAST outflow" headers={["FID", "Amount", "Wallet", "Status", "Created"]}>{claims.map((row) => <tr key={row.id}><td>#{row.fid}</td><td>{tokens(row.amount_wei)} TOKENCAST</td><td className="font-mono text-xs">{compact(row.wallet_address)}</td><td className="capitalize">{row.status.replace(/_/g, " ")}</td><td>{date(row.created_at)}</td></tr>)}</Table></div>; }

function LineChart({ values, labels }: { values: number[]; labels: string[] }) { const max = Math.max(...values, 1); const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${90 - (value / max) * 75}`).join(" "); return <div className="mt-5"><svg viewBox="0 0 100 100" role="img" aria-label="Daily mining sessions chart" className="h-48 w-full overflow-visible"><line x1="0" x2="100" y1="90" y2="90" stroke="#334155" strokeWidth="0.5" /><line x1="0" x2="100" y1="52" y2="52" stroke="#1f2937" strokeWidth="0.5" strokeDasharray="2 2" /><polyline points={points} fill="none" stroke="#a78bfa" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" /></svg><div className="flex justify-between text-xs text-gray-500"><span>{shortDate(labels[0] || new Date().toISOString().slice(0, 10))}</span><span>Peak: {max.toLocaleString()} sessions</span><span>{shortDate(labels.at(-1) || new Date().toISOString().slice(0, 10))}</span></div></div>; }

function TrendTable({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) { return <section className="overflow-hidden rounded-2xl border border-gray-800 bg-[#141b26]"><h2 className="border-b border-gray-800 px-5 py-4 font-semibold">{title}</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm text-gray-300"><thead className="bg-[#0b0f17] text-xs uppercase tracking-wide text-gray-500"><tr>{headers.map((header) => <th key={header} className="px-4 py-3 font-medium">{header}</th>)}</tr></thead><tbody className="[&_tr]:border-t [&_tr]:border-gray-800 [&_td]:px-4 [&_td]:py-3">{rows.map((row) => <tr key={row.join("-")}>{row.map((value, index) => <td key={`${value}-${index}`}>{value}</td>)}</tr>)}</tbody></table></div></section>; }

function Table({ title, headers, children }: { title: string; headers: string[]; children: ReactNode }) { return <section className="overflow-hidden rounded-2xl border border-gray-800 bg-[#141b26]"><h2 className="border-b border-gray-800 px-5 py-4 font-semibold">{title}</h2><div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm text-gray-300"><thead className="bg-[#0b0f17] text-xs uppercase tracking-wide text-gray-500"><tr>{headers.map((header) => <th key={header} className="px-4 py-3 font-medium">{header}</th>)}</tr></thead><tbody className="[&_tr]:border-t [&_tr]:border-gray-800 [&_td]:px-4 [&_td]:py-3">{children}</tbody></table></div></section>; }

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
