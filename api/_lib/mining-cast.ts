export type MiningCast = {
  hash: string;
  text?: string;
  timestamp?: string;
  author: {
    fid: number;
    username?: string;
    follower_count?: number;
    followerCount?: number;
    verified_addresses?: { eth_addresses?: string[] };
  };
};

export class CastLookupError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// Never fetch a user-supplied URL directly. Neynar resolves allowed cast links
// to a canonical hash, which is then covered by the database's unique index.
export function castIdentifier(value: unknown): { identifier: string; type: "hash" | "url" } {
  if (typeof value === "string") {
    const identifier = value.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(identifier)) return { identifier: identifier.toLowerCase(), type: "hash" };
    try {
      const url = new URL(identifier);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
          ["farcaster.xyz", "www.farcaster.xyz", "warpcast.com", "www.warpcast.com"].includes(url.hostname) &&
          /^\/(?:[a-zA-Z0-9._-]+\/0x[a-fA-F0-9]{8,40}|~\/conversations\/0x[a-fA-F0-9]{40})\/?$/.test(url.pathname)) {
        return { identifier: `${url.origin}${url.pathname}`, type: "url" };
      }
    } catch { /* Invalid URL; return the same actionable validation error. */ }
  }
  throw new CastLookupError("Paste a Farcaster cast link or a full cast hash.", 400);
}

export async function lookupMiningCast(value: unknown, key: string): Promise<MiningCast> {
  const { identifier, type } = castIdentifier(value);
  const url = `https://api.neynar.com/v2/farcaster/cast?identifier=${encodeURIComponent(identifier)}&type=${type}`;
  // A newly published cast can reach the client before Neynar indexes it.
  // Retry only transient reads, with a bounded wait; never publish another cast.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(6000) });
    } catch {
      throw new CastLookupError("Cast verification is temporarily unavailable. Retry this cast; you do not need to post again.", 503);
    }
    if (response.ok) {
      const { cast } = await response.json() as { cast?: MiningCast };
      if (cast && /^0x[a-fA-F0-9]{40}$/.test(cast.hash)) {
        if (type === "hash" && cast.hash.toLowerCase() !== identifier) {
          throw new CastLookupError("Cast verification returned a different cast. Please retry.", 502);
        }
        return cast;
      }
    } else if (response.status !== 404 && response.status < 500 && response.status !== 429) {
      throw new CastLookupError("Could not verify this cast. Check its link and try again.", 400);
    }
    if (response.status === 429) {
      throw new CastLookupError("Cast verification is busy. Wait a moment, then retry this cast.", 503);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new CastLookupError("Your cast is not available for verification yet. Retry this cast in a moment; do not post again.", 503);
}

export function requireRecentCast(cast: MiningCast, now: number): void {
  const publishedAt = Date.parse(cast.timestamp ?? "");
  if (!Number.isFinite(publishedAt) || publishedAt < now - 24 * 60 * 60 * 1000 || publishedAt > now + 5 * 60 * 1000) {
    throw new CastLookupError("Use a new cast published within the last 24 hours to start mining.", 400);
  }
}
