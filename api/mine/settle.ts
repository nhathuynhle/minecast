import { error, json, readEmissionSchedule, requireFarcasterUser, supabase } from "../_lib/backend";

export const config = { runtime: "edge" };

export default async function handler(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const schedule = await readEmissionSchedule();
    const sessions = await supabase("rpc/settle_ended_sessions", {
      method: "POST",
      body: JSON.stringify({
        p_fid: fid,
        p_launch_time: schedule.launchTime,
        p_halving_seconds: schedule.halvingSeconds,
        p_base_daily_wei: schedule.baseDailyWei,
      }),
    });
    const rows = await sessions.json();
    return json({ settled: rows.length });
  } catch (cause) { return error(cause); }
}
