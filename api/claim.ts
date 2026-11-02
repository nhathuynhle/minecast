import { privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress, zeroAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createBaseClient, error, requireFarcasterUser, reserveClaimAllocation, verifyClaimWalletLogin } from "./_lib/backend";

// Types cho Vercel Edge/Serverless function
export const config = {
  runtime: "edge",
};

function readSignerPrivateKey(): `0x${string}` {
  let value = process.env.SIGNER_PRIVATE_KEY?.trim();
  if (!value) {
    throw new Error("Voucher signer is not configured on the server.");
  }

  // Vercel values are sometimes pasted with quotes or without the 0x prefix.
  // Normalize those harmless differences, but never accept a wallet address or
  // an arbitrary string as a private key.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      "Voucher signer is misconfigured. SIGNER_PRIVATE_KEY must be a 32-byte private key (64 hex characters), not a wallet address.",
    );
  }
  return normalized as `0x${string}`;
}

export default async function handler(request: Request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const fid = await requireFarcasterUser(request);
    const body = await request.json();
    const { userAddress, nonce, chainId = 8453, walletLogin } = body;

    if (!isAddress(userAddress) || nonce === undefined) {
      return new Response(JSON.stringify({ error: "Missing required parameters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const verifiedWallet = await verifyClaimWalletLogin(fid, userAddress, walletLogin);

    const contractAddress = process.env.TOKENCAST_CONTRACT_ADDRESS as `0x${string}`;
    const configuredChainId = Number(process.env.TOKENCAST_CHAIN_ID ?? 8453);
    if (
      (configuredChainId !== base.id && configuredChainId !== baseSepolia.id) ||
      !isAddress(contractAddress) ||
      contractAddress === zeroAddress ||
      Number(chainId) !== configuredChainId
    ) {
      return new Response(JSON.stringify({ error: "Claim contract is not configured for this network." }), { status: 503, headers: { "Content-Type": "application/json" } });
    }

    // Validate the server signer before reserving any allocation. A bad Vercel
    // value must never move a reward into voucher_issued state.
    const account = privateKeyToAccount(readSignerPrivateKey());
    const publicClient = createBaseClient(configuredChainId);
    const contractReadAbi = [
      {
        type: "function",
        name: "userNonces",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
      },
      {
        type: "function",
        name: "signServer",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
      },
    ] as const;
    const [onchainNonce, onchainSigner] = await Promise.all([
      publicClient.readContract({
        address: contractAddress,
        abi: contractReadAbi,
        functionName: "userNonces",
        args: [verifiedWallet],
      }),
      publicClient.readContract({
        address: contractAddress,
        abi: contractReadAbi,
        functionName: "signServer",
      }),
    ]);
    if (getAddress(account.address) !== getAddress(onchainSigner)) {
      throw new Error("Configured voucher signer does not match TokenCast signServer.");
    }
    if (onchainNonce !== BigInt(nonce)) {
      return new Response(JSON.stringify({ error: "Claim nonce is stale. Refresh and try again." }), { status: 409, headers: { "Content-Type": "application/json" } });
    }

    const amountWei = BigInt(await reserveClaimAllocation(fid, verifiedWallet, String(onchainNonce)));

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
      user: verifiedWallet,
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
  } catch (cause) { return error(cause); }
}
