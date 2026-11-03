import { error, json, readEmissionSchedule, reconcileClaimedAllocations, requireFarcasterUser, supabase } from "../_lib/backend";

export const config = { runtime: "edge" };

/** Preflight used before opening the Farcaster composer. The start endpoint repeats this check. */
export default async function handler(request: Request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const schedule = await readEmissionSchedule();
    await supabase("rpc/settle_ended_sessions", { method: "POST", body: JSON.stringify({ p_fid: fid, p_launch_time: schedule.launchTime, p_halving_seconds: schedule.halvingSeconds, p_base_daily_wei: schedule.baseDailyWei }) });
    await reconcileClaimedAllocations(fid);
    const unclaimed = await supabase(`claim_allocations?fid=eq.${fid}&status=neq.claimed&select=amount_wei,status`);
    const allocations = await unclaimed.json();
    const amountWei = allocations.reduce((sum: bigint, row: { amount_wei: string }) => sum + BigInt(row.amount_wei), 0n);
    return json({ eligible: allocations.length === 0, amountWei: amountWei.toString() });
  } catch (cause) { return error(cause); }
}
