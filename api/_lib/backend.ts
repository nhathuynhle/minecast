import { createPublicClient, fallback, getAddress, http, isAddress, verifyMessage, zeroAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FARCASTER_DOMAIN = "minecast-beta.vercel.app";
const FARCASTER_AUTH_ORIGIN = "https://auth.farcaster.xyz";
const FARCASTER_JWKS = createRemoteJWKSet(
  new URL(`${FARCASTER_AUTH_ORIGIN}/.well-known/jwks.json`),
);

export function createBaseClient(chainId: number) {
  const chain = chainId === baseSepolia.id ? baseSepolia : base;
  const configuredRpc = process.env.BASE_RPC_URL?.trim();
  const officialRpc = chain.id === baseSepolia.id ? "https://sepolia.base.org" : "https://mainnet.base.org";
  const publicNodeRpc = chain.id === baseSepolia.id
    ? "https://base-sepolia-rpc.publicnode.com"
    : "https://base-rpc.publicnode.com";
  // The official Base public URL can challenge serverless calls with Cloudflare
  // (HTTP 403). A custom paid RPC remains first; otherwise PublicNode is first.
  const customRpc = configuredRpc && configuredRpc.replace(/\/$/, "") !== officialRpc ? configuredRpc : undefined;
  const rpcUrls = [...new Set([customRpc, publicNodeRpc, officialRpc].filter(Boolean))] as string[];

  return createPublicClient({
    chain,
    transport: fallback(
      rpcUrls.map((url) => http(url, { retryCount: 2, retryDelay: 400, timeout: 10_000 })),
      { retryCount: 1, retryDelay: 400 },
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
  if (!response.ok) {
    const raw = await response.text();
    let message = `Database request failed (${response.status}).`;
    try {
      const payload = JSON.parse(raw) as { message?: unknown };
      if (typeof payload.message === "string" && payload.message.trim()) message = payload.message;
    } catch {
      // Keep the safe generic message instead of exposing an HTML/JSON response.
    }
    throw new Error(message);
  }
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

const OPS_SESSION_MS = 8 * 60 * 60 * 1000;
const OPS_CHALLENGE_MS = 5 * 60 * 1000;

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function opsHmac(value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(required(SUPABASE_KEY, "SUPABASE_SERVICE_ROLE_KEY")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function validOpsHmac(value: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(required(SUPABASE_KEY, "SUPABASE_SERVICE_ROLE_KEY")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, base64UrlBytes(signature), new TextEncoder().encode(value));
}

export function requireMineCastAdminWallet(value: string): `0x${string}` {
  if (!isAddress(value)) throw new Error("A valid admin wallet is required.");
  const wallet = getAddress(value);
  const configured = process.env.MINECAST_ADMIN_WALLETS ?? "0x40537Ce355e3440d9d9855667Aa7546AB17Ce252";
  const allowed = configured
    .split(",")
    .map((address) => address.trim())
    .filter((address): address is `0x${string}` => isAddress(address))
    .map((address) => getAddress(address));
  if (!allowed.some((address) => address.toLowerCase() === wallet.toLowerCase())) {
    throw new Error("Admin wallet access is required.");
  }
  return wallet;
}

export async function createOpsChallenge(value: string) {
  const wallet = requireMineCastAdminWallet(value);
  const expiresAt = Date.now() + OPS_CHALLENGE_MS;
  const nonce = base64Url(await opsHmac(`challenge:${wallet.toLowerCase()}:${expiresAt}`));
  const message = `MineCast Operations Login\nWallet: ${wallet}\nExpires: ${expiresAt}\nNonce: ${nonce}`;
  return { wallet, expiresAt, nonce, message };
}

export async function issueOpsSession(input: { wallet: string; expiresAt: number; nonce: string; signature: `0x${string}` }): Promise<string> {
  const wallet = requireMineCastAdminWallet(input.wallet);
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < Date.now() || input.expiresAt > Date.now() + OPS_CHALLENGE_MS) {
    throw new Error("Admin login challenge has expired.");
  }
  const validNonce = await validOpsHmac(`challenge:${wallet.toLowerCase()}:${input.expiresAt}`, input.nonce);
  if (!validNonce) throw new Error("Invalid admin login challenge.");
  const message = `MineCast Operations Login\nWallet: ${wallet}\nExpires: ${input.expiresAt}\nNonce: ${input.nonce}`;
  if (!(await verifyMessage({ address: wallet, message, signature: input.signature }))) {
    throw new Error("Admin wallet signature could not be verified.");
  }
  const payload = base64Url(JSON.stringify({ wallet, exp: Date.now() + OPS_SESSION_MS }));
  return `${payload}.${base64Url(await opsHmac(`session:${payload}`))}`;
}

export async function requireOpsSession(request: Request): Promise<`0x${string}`> {
  const token = request.headers.get("x-minecast-admin-token");
  if (!token) throw new Error("Admin session is required.");
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !(await validOpsHmac(`session:${payload}`, signature))) throw new Error("Invalid admin session.");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(payload))) as { wallet?: string; exp?: number };
    if (!parsed.wallet || typeof parsed.exp !== "number" || !Number.isSafeInteger(parsed.exp) || parsed.exp < Date.now()) throw new Error("expired");
    return requireMineCastAdminWallet(parsed.wallet);
  } catch {
    throw new Error("Admin session has expired.");
  }
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
  if (/admin (access|wallet|session|login|signature)|invalid admin/i.test(message)) return json({ error: message }, 403);
  const status = /required|invalid|expired|does not belong|authenticate|verified.*wallet/i.test(message) ? 401
    : /already has|already linked|No settled|Daily claim|Claim your previous/i.test(message) ? 409
    : 500;
  return json({ error: message }, status);
}
