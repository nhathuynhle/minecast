import { error, json, requireFarcasterUser, supabase } from "../_lib/backend";

export const config = { runtime: "edge" };

export default async function handler(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const sessions = await supabase("rpc/settle_ended_sessions", { method: "POST", body: JSON.stringify({ p_fid: fid }) });
    const rows = await sessions.json();
    return json({ settled: rows.length });
  } catch (cause) { return error(cause); }
}
