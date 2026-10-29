import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, isAddress, parseEther, zeroAddress } from "viem";
import { base, baseSepolia } from "viem/chains";

// Types cho Vercel Edge/Serverless function
export const config = {
  runtime: "edge",
};

export default async function handler(request: Request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json();
    const { userAddress, nonce, chainId = 8453 } = body;

    if (!isAddress(userAddress) || nonce === undefined) {
      return new Response(JSON.stringify({ error: "Missing required parameters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const contractAddress = process.env.TOKENCAST_CONTRACT_ADDRESS as `0x${string}`;
    const configuredChainId = Number(process.env.TOKENCAST_CHAIN_ID ?? 8453);
    const ledgerUrl = process.env.CLAIM_LEDGER_URL;
    if (
      (configuredChainId !== base.id && configuredChainId !== baseSepolia.id) ||
      !isAddress(contractAddress) ||
      contractAddress === zeroAddress ||
      Number(chainId) !== configuredChainId
    ) {
      return new Response(JSON.stringify({ error: "Claim contract is not configured for this network." }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    if (!ledgerUrl) {
      return new Response(JSON.stringify({ error: "Claim ledger is not configured. Local mining balances cannot be claimed on-chain." }), { status: 503, headers: { "Content-Type": "application/json" } });
    }

    const chain = configuredChainId === baseSepolia.id ? baseSepolia : base;
    const publicClient = createPublicClient({
      chain,
      transport: http(process.env.BASE_RPC_URL),
    });
    const onchainNonce = await publicClient.readContract({
      address: contractAddress,
      abi: [{
        type: "function",
        name: "userNonces",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
      }] as const,
      functionName: "userNonces",
      args: [userAddress],
    });
    if (onchainNonce !== BigInt(nonce)) {
      return new Response(JSON.stringify({ error: "Claim nonce is stale. Refresh and try again." }), { status: 409, headers: { "Content-Type": "application/json" } });
    }

    // The ledger, not the browser, decides how many tokens may be claimed.
    const ledgerResponse = await fetch(ledgerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.CLAIM_LEDGER_SECRET ? { Authorization: `Bearer ${process.env.CLAIM_LEDGER_SECRET}` } : {}),
      },
      body: JSON.stringify({ userAddress, nonce: String(onchainNonce), chainId: configuredChainId }),
    });
    const allocation = await ledgerResponse.json();
    if (!ledgerResponse.ok || !allocation.amount || String(allocation.nonce) !== String(nonce)) {
      return new Response(JSON.stringify({ error: allocation.error || "No verified claim allocation is available." }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    // Lấy Signer Private Key từ biến môi trường Vercel
    const serverPrivateKey = process.env.SIGNER_PRIVATE_KEY as `0x${string}`;
    if (!serverPrivateKey) {
      // Mock signature cho môi trường dev/chưa cấu hình env
      return new Response(
        JSON.stringify({
          error: "SIGNER_PRIVATE_KEY is not configured on Vercel environment variables yet.",
          mock: true,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const account = privateKeyToAccount(serverPrivateKey);

    const amountWei = parseEther(String(allocation.amount));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // Hết hạn sau 30 phút

    // Cấu trúc EIP-712 chuẩn khớp 100% với TokenCast.sol
    const domain = {
      name: "TokenCast",
      version: "1",
      chainId: configuredChainId,
      verifyingContract: contractAddress,
    };

    const types = {
      ClaimVoucher: [
        { name: "user", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const message = {
      user: userAddress as `0x${string}`,
      amount: amountWei,
      nonce: BigInt(nonce),
      deadline: deadline,
    };

    // Ký xác nhận
    const signature = await account.signTypedData({
      domain,
      types,
      primaryType: "ClaimVoucher",
      message,
    });

    // Tách r, s, v từ chữ ký 65 bytes
    const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
    const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
    const v = parseInt(signature.slice(130, 132), 16);

    return new Response(
      JSON.stringify({
        amountWei: amountWei.toString(),
        deadline: deadline.toString(),
        v,
        r,
        s,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
