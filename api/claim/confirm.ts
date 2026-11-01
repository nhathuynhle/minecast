import { createPublicClient, getAddress, http, isAddress, parseEventLogs, zeroAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { error, json, requireFarcasterUser, requireWallet, supabase } from "../_lib/backend";

const claimedEventAbi = [{
  type: "event",
  name: "Claimed",
  anonymous: false,
  inputs: [
    { name: "user", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "newTotalClaimed", type: "uint256", indexed: false },
  ],
}] as const;

export const config = { runtime: "edge" };

/** Marks a voucher allocation claimed only after the Base receipt proves it. */
export default async function handler(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const { userAddress, nonce, transactionHash } = await request.json();
    const wallet = requireWallet(userAddress);
    if (nonce === undefined || typeof transactionHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) {
      throw new Error("A transaction hash and claim nonce are required.");
    }

    const contract = process.env.TOKENCAST_CONTRACT_ADDRESS as `0x${string}`;
    const chainId = Number(process.env.TOKENCAST_CHAIN_ID ?? 8453);
    if (!isAddress(contract) || contract === zeroAddress || (chainId !== base.id && chainId !== baseSepolia.id)) {
      throw new Error("TokenCast contract is not configured.");
    }
    const client = createPublicClient({
      chain: chainId === baseSepolia.id ? baseSepolia : base,
      transport: http(process.env.BASE_RPC_URL),
    });
    const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
    if (receipt.status !== "success" || !receipt.to || getAddress(receipt.to) !== getAddress(contract)) {
      throw new Error("Claim transaction was not confirmed by TokenCast.");
    }

    const allocationResponse = await supabase(
      `claim_allocations?fid=eq.${fid}&wallet_address=ilike.${encodeURIComponent(wallet)}&claim_nonce=eq.${encodeURIComponent(String(nonce))}&status=eq.voucher_issued&select=amount_wei`,
    );
    const allocations = await allocationResponse.json() as Array<{ amount_wei: string }>;
    const expectedAmount = allocations.reduce((sum, allocation) => sum + BigInt(allocation.amount_wei), 0n);
    if (expectedAmount <= 0n) throw new Error("No issued allocation matches this voucher.");

    const logs = parseEventLogs({ abi: claimedEventAbi, logs: receipt.logs, eventName: "Claimed", strict: false });
    const claim = logs.find((log) =>
      log.args.user && getAddress(log.args.user) === getAddress(wallet) && log.args.amount === expectedAmount,
    );
    if (!claim) throw new Error("Claim transaction amount does not match the issued allocation.");

    await supabase(
      `claim_allocations?fid=eq.${fid}&wallet_address=ilike.${encodeURIComponent(wallet)}&claim_nonce=eq.${encodeURIComponent(String(nonce))}&status=eq.voucher_issued`,
      { method: "PATCH", body: JSON.stringify({ status: "claimed" }) },
    );
    return json({ confirmed: true, transactionHash });
  } catch (cause) { return error(cause); }
}
