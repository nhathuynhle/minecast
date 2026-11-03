import { error, json, requireFarcasterUser, settleEndedMineSessions } from "../_lib/backend";

export const config = { runtime: "edge" };

export default async function handler(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const rows = await settleEndedMineSessions(fid);
    return json({ settled: rows.length });
  } catch (cause) { return error(cause); }
}
