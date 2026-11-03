import { error, json, reconcileClaimedAllocations, requireFarcasterUser, settleEndedMineSessions, supabase } from "../_lib/backend";

export const config = { runtime: "edge" };

/** Preflight used before opening the Farcaster composer. The start endpoint repeats this check. */
export default async function handler(request: Request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    await settleEndedMineSessions(fid);
    await reconcileClaimedAllocations(fid);
    const activeResponse = await supabase(
      `mining_sessions?fid=eq.${fid}&settled_at=is.null&ends_at=gt.${encodeURIComponent(new Date().toISOString())}&select=ends_at&order=ends_at.asc&limit=1`,
    );
    const [active] = await activeResponse.json() as Array<{ ends_at?: string }>;
    if (active?.ends_at) {
      return json({ eligible: false, reason: "active_session", endsAt: active.ends_at, amountWei: "0" });
    }
    const unclaimed = await supabase(`claim_allocations?fid=eq.${fid}&status=neq.claimed&select=amount_wei,status`);
    const allocations = await unclaimed.json();
    const amountWei = allocations.reduce((sum: bigint, row: { amount_wei: string }) => sum + BigInt(row.amount_wei), 0n);
    return json({ eligible: allocations.length === 0, reason: allocations.length ? "claim_required" : "ready", amountWei: amountWei.toString() });
  } catch (cause) { return error(cause); }
}
