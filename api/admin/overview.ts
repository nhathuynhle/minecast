import { error, json, requireFarcasterUser, requireMineCastAdmin, requireOpsSession, supabase } from "../_lib/backend";

export const config = { runtime: "edge" };

type Allocation = { amount_wei: string; status: string };
type SessionTrend = { started_at: string; reward_wei: string; settled_at: string | null };
type ClaimTrend = { created_at: string; amount_wei: string; status: string };

function countFrom(response: Response): number {
  const total = response.headers.get("content-range")?.split("/")[1];
  return total && /^\d+$/.test(total) ? Number(total) : 0;
}

function sumWei(rows: Allocation[], status: string): string {
  return rows
    .filter((row) => row.status === status)
    .reduce((total, row) => total + BigInt(row.amount_wei ?? "0"), 0n)
    .toString();
}

function dayKey(value: string): string {
  return value.slice(0, 10);
}

function buildTrend(sessions: SessionTrend[], claims: ClaimTrend[]) {
  const days = new Map<string, { sessions: number; settledSessions: number; rewardWei: bigint; claims: number; claimedWei: bigint }>();
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    days.set(date.toISOString().slice(0, 10), { sessions: 0, settledSessions: 0, rewardWei: 0n, claims: 0, claimedWei: 0n });
  }
  for (const session of sessions) {
    const bucket = days.get(dayKey(session.started_at));
    if (!bucket) continue;
    bucket.sessions += 1;
    if (session.settled_at) bucket.settledSessions += 1;
    bucket.rewardWei += BigInt(session.reward_wei ?? "0");
  }
  for (const claim of claims) {
    const bucket = days.get(dayKey(claim.created_at));
    if (!bucket || claim.status !== "claimed") continue;
    bucket.claims += 1;
    bucket.claimedWei += BigInt(claim.amount_wei ?? "0");
  }
  return [...days].map(([date, bucket]) => ({
    date,
    sessions: bucket.sessions,
    settledSessions: bucket.settledSessions,
    rewardWei: bucket.rewardWei.toString(),
    claims: bucket.claims,
    claimedWei: bucket.claimedWei.toString(),
  }));
}

export default async function handler(request: Request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    if (request.headers.get("x-minecast-admin-token")) {
      await requireOpsSession(request);
    } else {
      const fid = await requireFarcasterUser(request);
      requireMineCastAdmin(fid);
    }

    const [minerCountResponse, activeCountResponse, completedCountResponse, claimedCountResponse, minersResponse, sessionsResponse, claimsResponse, allocationsResponse, trendSessionsResponse, trendClaimsResponse] = await Promise.all([
      supabase("miners?select=fid", { method: "HEAD", headers: { Prefer: "count=exact" } }),
      supabase("mining_sessions?settled_at=is.null&select=id", { method: "HEAD", headers: { Prefer: "count=exact" } }),
      supabase("mining_sessions?settled_at=not.is.null&select=id", { method: "HEAD", headers: { Prefer: "count=exact" } }),
      supabase("claim_allocations?status=eq.claimed&select=id", { method: "HEAD", headers: { Prefer: "count=exact" } }),
      supabase("miners?select=fid,username,wallet_address,follower_count,created_at&order=created_at.desc&limit=12"),
      supabase("mining_sessions?select=id,fid,wallet_address,reward_wei,reward_weight,started_at,ends_at,settled_at&order=started_at.desc&limit=12"),
      supabase("claim_allocations?select=id,fid,wallet_address,amount_wei,status,created_at&order=created_at.desc&limit=12"),
      supabase("claim_allocations?select=amount_wei,status&limit=5000"),
      supabase("mining_sessions?select=started_at,reward_wei,settled_at&started_at=gte.${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}&order=started_at.asc&limit=5000"),
      supabase("claim_allocations?select=created_at,amount_wei,status&created_at=gte.${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}&order=created_at.asc&limit=5000"),
    ]);

    const [miners, sessions, claims, allocations, trendSessions, trendClaims] = await Promise.all([
      minersResponse.json(),
      sessionsResponse.json(),
      claimsResponse.json(),
      allocationsResponse.json() as Promise<Allocation[]>,
      trendSessionsResponse.json() as Promise<SessionTrend[]>,
      trendClaimsResponse.json() as Promise<ClaimTrend[]>,
    ]);

    return json({
      generatedAt: new Date().toISOString(),
      metrics: {
        miners: countFrom(minerCountResponse),
        activeSessions: countFrom(activeCountResponse),
        settledSessions: countFrom(completedCountResponse),
        claimedAllocations: countFrom(claimedCountResponse),
        availableWei: sumWei(allocations, "available"),
        voucherWei: sumWei(allocations, "voucher_issued"),
        claimedWei: sumWei(allocations, "claimed"),
      },
      miners,
      sessions,
      claims,
      trend: buildTrend(trendSessions, trendClaims),
    });
  } catch (cause) {
    return error(cause);
  }
}
