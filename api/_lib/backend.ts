import { createPublicClient, http, isAddress, zeroAddress } from "viem";
import { base, baseSepolia } from "viem/chains";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FARCASTER_AUDIENCE = process.env.FARCASTER_AUTH_AUDIENCE;

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

  const response = await fetch("https://auth.farcaster.xyz/verify-jwt", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Farcaster authentication token is invalid or expired.");
  const payload = await response.json();
  const audience = payload.aud ?? payload.payload?.aud;
  const fid = Number(payload.fid ?? payload.sub ?? payload.payload?.fid ?? payload.payload?.sub);
  if (audience !== required(FARCASTER_AUDIENCE, "FARCASTER_AUTH_AUDIENCE") || !Number.isSafeInteger(fid) || fid < 1) {
    throw new Error("Farcaster authentication token does not belong to this app.");
  }
  return fid;
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
  const client = createPublicClient({ chain: chainId === baseSepolia.id ? baseSepolia : base, transport: http(process.env.BASE_RPC_URL) });
  const era = await client.readContract({
    address: contract,
    abi: [{ type: "function", name: "currentEra", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
    functionName: "currentEra",
  });
  return Number(era);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export function error(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  const status = /required|invalid|expired|does not belong|authenticate/i.test(message) ? 401
    : /already has|No settled|Daily claim/i.test(message) ? 409
    : 500;
  return json({ error: message }, status);
}
