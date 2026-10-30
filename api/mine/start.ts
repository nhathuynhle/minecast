import { error, json, readCurrentEra, requireFarcasterUser, requireWallet, supabase } from "../_lib/backend";

const SESSION_SECONDS = 24 * 60 * 60;
const BASE_REWARD_WEI = 8_000n * 10n ** 18n;

export const config = { runtime: "edge" };

export default async function handler(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const { castHash, walletAddress, username, referrerHandle } = await request.json();
    const wallet = requireWallet(walletAddress);
    if (typeof castHash !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(castHash)) throw new Error("A valid Farcaster cast hash is required.");

    const neynarKey = process.env.NEYNAR_API_KEY;
    if (!neynarKey) throw new Error("NEYNAR_API_KEY is not configured.");
    const castResponse = await fetch(`https://api.neynar.com/v2/farcaster/cast?identifier=${encodeURIComponent(castHash)}&type=hash`, {
      headers: { "x-api-key": neynarKey },
    });
    if (!castResponse.ok) throw new Error("Could not verify the Farcaster cast.");
    const cast = (await castResponse.json()).cast;
    if (!cast || Number(cast.author?.fid) !== fid) throw new Error("The cast does not belong to the authenticated Farcaster account.");

    const followerCount = Number(cast.author?.follower_count ?? cast.author?.followerCount ?? 0);

    const now = new Date();
    const endsAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
    const referralCode = `MC${fid.toString(36).toUpperCase()}`;
    const existingResponse = await supabase(`miners?fid=eq.${fid}&select=inviter_fid`);
    const [existing] = await existingResponse.json();
    let inviterFid: number | undefined;
    if (!existing?.inviter_fid && followerCount >= 100 && typeof referrerHandle === "string" && /^[a-z0-9][a-z0-9._]{0,15}$/i.test(referrerHandle)) {
      const inviterResponse = await supabase(`miners?username=ilike.${encodeURIComponent(referrerHandle.trim())}&select=fid&limit=1`);
      const [inviter] = await inviterResponse.json();
      if (inviter?.fid && Number(inviter.fid) !== fid) inviterFid = Number(inviter.fid);
    }
    await supabase("miners?on_conflict=fid", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ fid, username: typeof username === "string" ? username : null, wallet_address: wallet, referral_code: referralCode, ...(inviterFid ? { inviter_fid: inviterFid } : {}) }),
    });
    const active = await supabase(`mining_sessions?fid=eq.${fid}&settled_at=is.null&select=id`);
    if ((await active.json()).length) throw new Error("This miner already has an active session.");

    const era = await readCurrentEra();
    const rewardWei = BASE_REWARD_WEI >> BigInt(era);
    const created = await supabase("mining_sessions", {
      method: "POST",
      body: JSON.stringify({ fid, cast_hash: castHash.toLowerCase(), wallet_address: wallet, reward_wei: rewardWei.toString(), started_at: now.toISOString(), ends_at: endsAt.toISOString() }),
    });
    const [session] = await created.json();
    return json({ sessionId: session.id, endsAt: session.ends_at, rewardWei: rewardWei.toString(), era, referralQualified: Boolean(inviterFid) }, 201);
  } catch (cause) { return error(cause); }
}
