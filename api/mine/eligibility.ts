import { error, json, requireFarcasterUser, supabase } from "../_lib/backend";

export const config = { runtime: "edge" };

/** Preflight used before opening the Farcaster composer. The start endpoint repeats this check. */
export default async function handler(request: Request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const unclaimed = await supabase(`claim_allocations?fid=eq.${fid}&status=neq.claimed&select=id&limit=1`);
    return json({ eligible: (await unclaimed.json()).length === 0 });
  } catch (cause) { return error(cause); }
}
