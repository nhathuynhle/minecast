import { error, json, readCurrentEra, reconcileClaimedAllocations, requireFarcasterUser, requireWallet, settleEndedMineSessions, supabase } from "../_lib/backend";

const SESSION_SECONDS = 24 * 60 * 60;
// UI estimate. The actual settlement divides the fixed daily budget across
// every verified mining session in the UTC cohort.
const BASE_REWARD_WEI = 386_029_411_764_705_882_352n;

function followerWeight(followers: number): bigint {
  if (followers >= 100_000) return 100n;
  if (followers >= 50_000) return 82n;
  if (followers >= 25_000) return 65n;
  if (followers >= 10_000) return 45n;
  if (followers >= 5_000) return 28n;
  if (followers >= 2_000) return 16n;
  if (followers >= 1_000) return 10n;
  if (followers >= 500) return 4n;
  if (followers >= 10) return 2n;
  return 1n;
}

export const config = { runtime: "edge" };

export default async function handler(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const { castHash, walletAddress, referrerHandle } = await request.json();
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

    const canonicalUsername = typeof cast.author?.username === "string"
      ? cast.author.username.replace(/^@+/, "").toLowerCase()
      : "";
    if (!/^[a-z0-9](?:[a-z0-9._]{0,14}[a-z0-9])?$/.test(canonicalUsername)) {
      throw new Error("Neynar did not return a valid username for the authenticated Farcaster account.");
    }

    const followerCount = Number(cast.author?.follower_count ?? cast.author?.followerCount ?? 0);
    const rewardWeight = followerWeight(followerCount);
    const verifiedWallets = (cast.author?.verified_addresses?.eth_addresses ?? []) as string[];
    if (!verifiedWallets.some((address) => address.toLowerCase() === wallet.toLowerCase())) {
      throw new Error("Use an Ethereum wallet verified on your Farcaster profile as the payout wallet.");
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
    const referralCode = `MC${fid.toString(36).toUpperCase()}`;
    // A server session, not the browser timer, is authoritative. Settle any
    // finished session before checking whether this miner can start another.
    await settleEndedMineSessions(fid);
    // Base is authoritative. Recover automatically if the wallet transaction
    // was mined but the browser never reached the confirmation callback.
    await reconcileClaimedAllocations(fid, wallet);
    const existingResponse = await supabase(`miners?fid=eq.${fid}&select=inviter_fid,wallet_address`);
    const [existing] = await existingResponse.json();
    const unclaimedResponse = await supabase(`claim_allocations?fid=eq.${fid}&status=neq.claimed&select=id&limit=1`);
    if ((await unclaimedResponse.json()).length) {
      throw new Error("Claim your previous settled reward before starting another mining session.");
    }
    const walletOwnerResponse = await supabase(`miners?wallet_address=ilike.${encodeURIComponent(wallet)}&select=fid&limit=1`);
    const [walletOwner] = await walletOwnerResponse.json();
    if (walletOwner?.fid && Number(walletOwner.fid) !== fid) throw new Error("This verified payout wallet is already linked to another MineCast miner.");
    let inviterFid: number | undefined;
    if (!existing?.inviter_fid && followerCount >= 100 && typeof referrerHandle === "string" && /^[a-z0-9][a-z0-9._]{0,15}$/i.test(referrerHandle)) {
      // Resolve the handle through Neynar first. Never let a browser value or a
      // stale/spoofed database username decide which FID receives referrals.
      const referrerResponse = await fetch(
        `https://api.neynar.com/v2/farcaster/user/by_username?username=${encodeURIComponent(referrerHandle.trim().replace(/^@+/, ""))}`,
        { headers: { "x-api-key": neynarKey } },
      );
      if (referrerResponse.ok) {
        const referrerUser = (await referrerResponse.json()).user;
        const verifiedReferrerFid = Number(referrerUser?.fid);
        if (Number.isSafeInteger(verifiedReferrerFid) && verifiedReferrerFid > 0 && verifiedReferrerFid !== fid) {
          const inviterResponse = await supabase(`miners?fid=eq.${verifiedReferrerFid}&select=fid&limit=1`);
          const [inviter] = await inviterResponse.json();
          if (Number(inviter?.fid) === verifiedReferrerFid) inviterFid = verifiedReferrerFid;
        }
      }
    }
    await supabase("miners?on_conflict=fid", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ fid, username: canonicalUsername, wallet_address: wallet, follower_count: followerCount, referral_code: referralCode, ...(inviterFid ? { inviter_fid: inviterFid } : {}) }),
    });
    const active = await supabase(`mining_sessions?fid=eq.${fid}&settled_at=is.null&select=id,ends_at&order=ends_at.asc&limit=1`);
    const [activeSession] = await active.json() as Array<{ id: string; ends_at: string }>;
    if (activeSession) {
      throw new Error(`Your active mining session ends at ${new Date(activeSession.ends_at).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}.`);
    }

    const era = await readCurrentEra();
    const rewardWei = (BASE_REWARD_WEI >> BigInt(era)) * rewardWeight;
    const estimatedRewardWei = rewardWei;
    const created = await supabase("mining_sessions", {
      method: "POST",
      body: JSON.stringify({ fid, cast_hash: castHash.toLowerCase(), wallet_address: wallet, reward_wei: estimatedRewardWei.toString(), reward_weight: rewardWeight.toString(), emission_day: now.toISOString().slice(0, 10), started_at: now.toISOString(), ends_at: endsAt.toISOString() }),
    });
    const [session] = await created.json();
    return json({ sessionId: session.id, endsAt: session.ends_at, rewardWei: estimatedRewardWei.toString(), era, referralQualified: Boolean(inviterFid) }, 201);
  } catch (cause) { return error(cause); }
}
