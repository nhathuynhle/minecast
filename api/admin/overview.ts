import { error, json, requireFarcasterUser, requireMineCastAdmin, requireOpsSession, supabase } from "../_lib/backend";

export const config = { runtime: "edge" };

type Allocation = { amount_wei: string; status: string };

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

export default async function handler(request: Request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    if (request.headers.get("x-minecast-admin-token")) {
      await requireOpsSession(request);
    } else {
      const fid = await requireFarcasterUser(request);
      requireMineCastAdmin(fid);
    }

    const [minerCountResponse, activeCountResponse, completedCountResponse, claimedCountResponse, minersResponse, sessionsResponse, claimsResponse, allocationsResponse] = await Promise.all([
      supabase("miners?select=fid", { method: "HEAD", headers: { Prefer: "count=exact" } }),
      supabase("mining_sessions?settled_at=is.null&select=id", { method: "HEAD", headers: { Prefer: "count=exact" } }),
      supabase("mining_sessions?settled_at=not.is.null&select=id", { method: "HEAD", headers: { Prefer: "count=exact" } }),
      supabase("claim_allocations?status=eq.claimed&select=id", { method: "HEAD", headers: { Prefer: "count=exact" } }),
      supabase("miners?select=fid,username,wallet_address,follower_count,created_at&order=created_at.desc&limit=12"),
      supabase("mining_sessions?select=id,fid,wallet_address,reward_wei,reward_weight,started_at,ends_at,settled_at&order=started_at.desc&limit=12"),
      supabase("claim_allocations?select=id,fid,wallet_address,amount_wei,status,created_at&order=created_at.desc&limit=12"),
      supabase("claim_allocations?select=amount_wei,status&limit=5000"),
    ]);

    const [miners, sessions, claims, allocations] = await Promise.all([
      minersResponse.json(),
      sessionsResponse.json(),
      claimsResponse.json(),
      allocationsResponse.json() as Promise<Allocation[]>,
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
    });
  } catch (cause) {
    return error(cause);
  }
}
