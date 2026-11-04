import { error, json, requireFarcasterUser, supabase } from "../_lib/backend";

export const config = { runtime: "edge" };

export default async function handler(request: Request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const response = await supabase(`mining_sessions?fid=eq.${fid}&settled_at=is.null&ends_at=gt.${encodeURIComponent(new Date().toISOString())}&select=started_at,ends_at,reward_wei&order=started_at.desc&limit=1`);
    const [session] = await response.json();
    return json({ session: session ?? null });
  } catch (cause) { return error(cause); }
}
