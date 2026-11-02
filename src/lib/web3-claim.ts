import { createPublicClient, createWalletClient, custom, getAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { TOKENCAST_ABI, TOKENCAST_CHAIN_ID, TOKENCAST_CONTRACT_ADDRESS, TOKENCAST_IS_DEPLOYED } from "./contract";
import { readClaimNonce } from "./onchain";
import { ethereumProviderForChain, farcasterFetch } from "./farcaster";
import { baseRpcTransport } from "./base-rpc";

export type ClaimStatus = "idle" | "signing_wallet_login" | "requesting_voucher" | "sending_tx" | "success" | "error";

export async function executeClaimOnBase({
  userAddress,
  onStatusChange,
}: {
  userAddress: `0x${string}`;
  onStatusChange: (status: ClaimStatus, message?: string) => void;
}) {
  try {
    if (!TOKENCAST_IS_DEPLOYED) {
      throw new Error("Claims are not live yet. The TokenCast contract address has not been configured.");
    }
    onStatusChange("requesting_voucher", "Đang xin chữ ký xác thực từ máy chủ...");

    const chain = TOKENCAST_CHAIN_ID === baseSepolia.id ? baseSepolia : base;
    const chainId = chain.id;

    const provider = await ethereumProviderForChain(chainId);
    const walletClient = createWalletClient({
      chain,
      transport: custom(provider as any),
    });
    const [account] = await walletClient.requestAddresses();
    if (!account) throw new Error("No wallet was connected.");
    if (getAddress(account) !== getAddress(userAddress)) {
      throw new Error("Connected wallet does not match the selected payout address.");
    }
    const nonce = await readClaimNonce(account);

    // Signing this short-lived message is free: it proves the user controls
    // the withdrawal wallet before the server issues a claim voucher.
    onStatusChange("signing_wallet_login", "Sign the free MineCast withdrawal login message in your wallet...");
    const loginResponse = await farcasterFetch("/api/claim/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAddress: account }),
    });
    const login = await loginResponse.json();
    if (!loginResponse.ok || !login.message || !login.nonce || !login.proof || !login.expiresAt) {
      throw new Error(login.error || "Could not prepare secure wallet login.");
    }
    const loginSignature = await walletClient.signMessage({ account, message: login.message });

    // 1. Gọi Server API để lấy voucher có chữ ký hợp lệ
    onStatusChange("requesting_voucher", "Verifying wallet login and preparing your claim...");
    const response = await farcasterFetch("/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress: account,
        nonce: nonce.toString(),
        chainId,
        walletLogin: {
          expiresAt: login.expiresAt,
          nonce: login.nonce,
          proof: login.proof,
          signature: loginSignature,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Không thể lấy chữ ký xác nhận claim.");
    }

    const { amountWei, deadline, v, r, s } = data;

    onStatusChange("sending_tx", "Vui lòng xác nhận giao dịch trên ví Base của bạn (Phí gas ~$0.002)...");

    // 2. Mở ví của user để ký giao dịch on-chain
    const publicClient = createPublicClient({ chain, transport: baseRpcTransport(chain.id) });
    const { request } = await publicClient.simulateContract({
      address: TOKENCAST_CONTRACT_ADDRESS,
      abi: TOKENCAST_ABI,
      functionName: "claim",
      args: [BigInt(amountWei), BigInt(deadline), Number(v), r, s],
      account,
    });
    const hash = await walletClient.writeContract(request);

    onStatusChange("sending_tx", "Transaction sent. Waiting for Base confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Claim transaction reverted on Base.");
    const confirmation = await farcasterFetch("/api/claim/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAddress: account, nonce: nonce.toString(), transactionHash: hash }),
    });
    const confirmationData = await confirmation.json();
    if (!confirmation.ok || !confirmationData.confirmed) {
      throw new Error(confirmationData.error || "Base claim could not be confirmed by the mining ledger.");
    }

    onStatusChange("success", `Claim thành công! Tx Hash: ${hash}`);
    return hash;
  } catch (error: any) {
    onStatusChange("error", error.message || "Giao dịch thất bại.");
    throw error;
  }
}
