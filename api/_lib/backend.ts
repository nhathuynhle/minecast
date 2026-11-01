import { createPublicClient, fallback, http, isAddress, zeroAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FARCASTER_DOMAIN = "minecast-beta.vercel.app";
const FARCASTER_AUTH_ORIGIN = "https://auth.farcaster.xyz";
const FARCASTER_JWKS = createRemoteJWKSet(
  new URL(`${FARCASTER_AUTH_ORIGIN}/.well-known/jwks.json`),
);

function createBaseClient(chainId: number) {
  const chain = chainId === baseSepolia.id ? baseSepolia : base;
  const configuredRpc = process.env.BASE_RPC_URL?.trim();
  const publicRpcs = chain.id === baseSepolia.id
    ? ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]
    : ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
  const rpcUrls = [...new Set([configuredRpc, ...publicRpcs].filter(Boolean))] as string[];

  return createPublicClient({
    chain,
    transport: fallback(
      rpcUrls.map((url) => http(url, { retryCount: 2, retryDelay: 400, timeout: 10_000 })),
      { rank: true, retryCount: 1, retryDelay: 400 },
    ),
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export async function supabase(path: string, init: RequestInit = {}) {
  const key = required(SUPABASE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${required(SUPABASE_URL, "SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Supabase request failed: ${await response.text()}`);
  return response;
}

export async function requireFarcasterUser(request: Request): Promise<number> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Farcaster authentication is required.");

  try {
    // Validate signature, issuer, expiration and this Mini App's domain against
    // Farcaster's public JWKS without exposing the token to another service.
    const { payload } = await jwtVerify(token, FARCASTER_JWKS, {
      issuer: FARCASTER_AUTH_ORIGIN,
      audience: FARCASTER_DOMAIN,
    });
    const fid = Number(payload.sub);
    if (!Number.isSafeInteger(fid) || fid < 1) throw new Error("Invalid Farcaster FID.");
    return fid;
  } catch {
    throw new Error("Farcaster authentication token is invalid, expired, or belongs to another domain.");
  }
}

export function requireMineCastAdmin(fid: number): void {
  // Keep the app owner's FID as a safe default for the current deployment, but
  // allow multiple operators to be configured without a code release.
  const configured = process.env.MINECAST_ADMIN_FIDS ?? "3356898";
  const adminFids = configured
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (!adminFids.includes(fid)) throw new Error("Admin access is required.");
}

export function requireWallet(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value)) throw new Error("A valid Base wallet address is required.");
  return value as `0x${string}`;
}

export async function reserveClaimAllocation(fid: number, walletAddress: string, nonce: string): Promise<string> {
  const response = await supabase("rpc/reserve_claim", {
    method: "POST",
    body: JSON.stringify({ p_fid: fid, p_wallet: walletAddress, p_nonce: nonce }),
  });
  const [allocation] = await response.json();
  if (!allocation?.amount_wei || BigInt(allocation.amount_wei) <= 0n) throw new Error("No settled mining reward is available to claim.");
  return String(allocation.amount_wei);
}

export async function readCurrentEra(): Promise<number> {
  const contract = process.env.TOKENCAST_CONTRACT_ADDRESS as `0x${string}`;
  const chainId = Number(process.env.TOKENCAST_CHAIN_ID ?? 8453);
  if (!isAddress(contract) || contract === zeroAddress || (chainId !== base.id && chainId !== baseSepolia.id)) {
    throw new Error("TokenCast contract is not configured.");
  }
  const client = createBaseClient(chainId);
  const era = await client.readContract({
    address: contract,
    abi: [{ type: "function", name: "currentEra", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
    functionName: "currentEra",
  });
  return Number(era);
}

export async function readEmissionSchedule(): Promise<{ launchTime: string; halvingSeconds: string; baseDailyWei: string }> {
  const contract = process.env.TOKENCAST_CONTRACT_ADDRESS as `0x${string}`;
  const chainId = Number(process.env.TOKENCAST_CHAIN_ID ?? 8453);
  if (!isAddress(contract) || contract === zeroAddress || (chainId !== base.id && chainId !== baseSepolia.id)) {
    throw new Error("TokenCast contract is not configured.");
  }
  const client = createBaseClient(chainId);
  const abi = [
    { type: "function", name: "launchTime", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { type: "function", name: "HALVING_PERIOD", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { type: "function", name: "BASE_DAILY_EMISSION", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  ] as const;
  const [launchTime, halvingSeconds, baseDailyWei] = await Promise.all([
    client.readContract({ address: contract, abi, functionName: "launchTime" }),
    client.readContract({ address: contract, abi, functionName: "HALVING_PERIOD" }),
    client.readContract({ address: contract, abi, functionName: "BASE_DAILY_EMISSION" }),
  ]);
  return { launchTime: launchTime.toString(), halvingSeconds: halvingSeconds.toString(), baseDailyWei: baseDailyWei.toString() };
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export function error(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  if (/cloudflare|<!doctype|http request failed|timed? out|fetch failed|\b50[0234]\b/i.test(message)) {
    return json({ error: "Base RPC is temporarily unavailable. Please try again." }, 503);
  }
  if (/admin access/i.test(message)) return json({ error: message }, 403);
  const status = /required|invalid|expired|does not belong|authenticate|verified.*wallet/i.test(message) ? 401
    : /already has|already linked|No settled|Daily claim|Claim your previous/i.test(message) ? 409
    : 500;
  return json({ error: message }, status);
}
