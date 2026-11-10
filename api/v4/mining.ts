import { json, requireFarcasterUser, requireWallet, supabase } from "../_lib/backend"
import { CastLookupError, lookupMiningCast, requireRecentCast } from "../_lib/mining-cast"
import { serverV4Config, gateV4, scopeV4, sessionsV4, sessionColumns, identityV4 } from "../_lib/v4"

export const config = { runtime: "edge" }
const respond = (body: unknown, status = 200) => {
  const response = json(body, status)
  response.headers.set("Cache-Control", "no-store")
  return response
}
export default async function handler(request: Request) {
  try {
    const deployment = serverV4Config()
    const url = new URL(request.url)
    if (request.method === "GET" && url.searchParams.get("action") === "stats") {
      const day = url.searchParams.get("day") ?? ""
      if (!/^\d{1,8}$/.test(day)) return respond({ error: "Invalid mining day." }, 400)
      const result = await supabase("rpc/get_v4_mining_stats", { method: "POST", body: JSON.stringify({
        p_chain_id: deployment.chainId, p_distributor: deployment.distributor.toLowerCase(), p_day: Number(day),
      }) })
      const [stats] = await result.json()
      if (!stats) throw Error("get_v4_mining_stats unavailable")
      const response = respond({ ...identityV4(deployment), day: Number(day), scope: "minecast-intake",
        estimateBasis: "follower-only", authoritativeRewards: false, ...stats })
      // This response contains only public aggregate data, never a user's auth/session.
      response.headers.set("Cache-Control", "public, max-age=0, s-maxage=10")
      return response
    }
    // Public, bounded, paginated observations. Nodes MUST independently verify every entry.
    if (request.method === "GET" && url.searchParams.get("action") === "cohort") {
      const day = url.searchParams.get("day") ?? "", offset = url.searchParams.get("offset") ?? "0"
      if (!/^\d{1,8}$/.test(day) || !/^\d{1,8}$/.test(offset)) return respond({ error: "Invalid cohort page." }, 400)
      const result = await supabase(`v4_mining_sessions?${scopeV4(deployment)}&day=eq.${Number(day)}&select=${sessionColumns}&order=fid.asc&limit=100&offset=${Number(offset)}`)
      const entries = await result.json()
      return respond({ ...identityV4(deployment), day: Number(day), entries, nextOffset: entries.length === 100 ? Number(offset) + 100 : null, authoritativeRewards: false })
    }
    if (request.method !== "GET" && request.method !== "POST") return respond({ error: "Method not allowed" }, 405)
    const fid = await requireFarcasterUser(request)
    const sessions = await sessionsV4(deployment, fid)
    if (request.method === "GET") {
      const gate = await gateV4(deployment, sessions)
      return respond({ ...identityV4(deployment), fid, sessions, eligible: gate.eligible, reason: gate.reason })
    }
    let input: Record<string, unknown>
    try {
      const body = await request.json()
      if (!body || typeof body !== "object" || Array.isArray(body)) throw Error()
      input = body
    } catch { return respond({ error: "Invalid mining session request." }, 400) }
    if (input.chainId !== deployment.chainId || typeof input.distributor !== "string" || input.distributor.toLowerCase() !== deployment.distributor.toLowerCase()) return respond({ error: "App and session server use different V4 deployments." }, 409)
    let wallet: `0x${string}`
    try { wallet = requireWallet(input.walletAddress) } catch { return respond({ error: "Connect a valid Ethereum wallet." }, 400) }
    const key = process.env.NEYNAR_API_KEY
    if (!key) return respond({ error: "Farcaster verification is not configured." }, 503)
    const cast = await lookupMiningCast(input.castHash ?? input.castUrl, key)
    if (Number(cast.author?.fid) !== fid) return respond({ error: "The cast does not belong to your Farcaster account." }, 403)
    if (!(cast.author.verified_addresses?.eth_addresses ?? []).some(a => a.toLowerCase() === wallet.toLowerCase())) return respond({ error: "Connect an Ethereum wallet verified on your Farcaster profile." }, 403)
    const prior = sessions.find(s => s.cast_hash === cast.hash.toLowerCase())
    if (prior) {
      if (prior.wallet_address.toLowerCase() !== wallet.toLowerCase()) return respond({ error: "This cast already uses another payout wallet." }, 409)
      return respond({ ...identityV4(deployment), session: prior, resumed: true })
    }
    const gate = await gateV4(deployment, sessions)
    if (!gate.eligible) return respond({ error: gate.reason }, 409)
    requireRecentCast(cast, Number(gate.network.timestamp) * 1000)
    // The server chooses time and cohort from Base, never a browser reward/day/timer.
    const followers = cast.author.follower_count ?? cast.author.followerCount
    const result = await supabase("rpc/start_v4_mining_session_with_estimate", { method: "POST", body: JSON.stringify({
      p_chain_id: deployment.chainId, p_distributor: deployment.distributor.toLowerCase(), p_fid: fid,
      p_wallet: wallet.toLowerCase(), p_cast_hash: cast.hash.toLowerCase(), p_day: Number(gate.network.day),
      p_started_at: new Date(Number(gate.network.timestamp) * 1000).toISOString(),
      p_follower_count: Number.isSafeInteger(followers) && followers! >= 0 ? followers : null,
    }) })
    const row = await result.json()
    return respond({ ...identityV4(deployment), session: Array.isArray(row) ? row[0] : row }, 201)
  } catch (error) {
    if (error instanceof CastLookupError) return respond({ error: error.message }, error.status)
    const message = error instanceof Error ? error.message : "Session verification unavailable."
    if (/authenticat|token is invalid/i.test(message)) return respond({ error: message }, 401)
    if (/active session|already|wallet is linked|23505/i.test(message)) return respond({ error: "A session already exists or this payout wallet is linked to another miner. Refresh your session before retrying." }, 409)
    if (/v4_mining_sessions|start_v4_mining_session|get_v4_mining_stats|schema cache|does not exist/i.test(message)) return respond({ error: "V4 session storage needs its latest migrations. Claims and DAO remain available directly onchain." }, 503)
    return respond({ error: "V4 session verification is temporarily unavailable. Retry this cast in a moment." }, 503)
  }
}
