import { createWalletClient, custom, getAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { TOKENCAST_ABI, TOKENCAST_CHAIN_ID, TOKENCAST_CONTRACT_ADDRESS, TOKENCAST_IS_DEPLOYED } from "./contract";
import { readClaimNonce } from "./onchain";

export type ClaimStatus = "idle" | "requesting_voucher" | "sending_tx" | "success" | "error";

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
    if (typeof window === "undefined" || !(window as any).ethereum) {
      throw new Error("Không tìm thấy ví Web3 (Warpcast hoặc MetaMask).");
    }

    onStatusChange("requesting_voucher", "Đang xin chữ ký xác thực từ máy chủ...");

    const chain = TOKENCAST_CHAIN_ID === baseSepolia.id ? baseSepolia : base;
    const chainId = chain.id;

    const walletClient = createWalletClient({
      chain,
      transport: custom((window as any).ethereum),
    });
    const [account] = await walletClient.requestAddresses();
    if (!account) throw new Error("No wallet was connected.");
    if (getAddress(account) !== getAddress(userAddress)) {
      throw new Error("Connected wallet does not match the selected payout address.");
    }
    const nonce = await readClaimNonce(account);

    // 1. Gọi Server API để lấy voucher có chữ ký hợp lệ
    const response = await fetch("/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress,
        userAddress: account,
        nonce: nonce.toString(),
        chainId,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Không thể lấy chữ ký xác nhận claim.");
    }

    const { amountWei, deadline, v, r, s } = data;

    onStatusChange("sending_tx", "Vui lòng xác nhận giao dịch trên ví Base của bạn (Phí gas ~$0.002)...");

    // 2. Mở ví của user để ký giao dịch on-chain
    const hash = await walletClient.writeContract({
      address: TOKENCAST_CONTRACT_ADDRESS,
      abi: TOKENCAST_ABI,
      functionName: "claim",
      args: [BigInt(amountWei), BigInt(deadline), Number(v), r, s],
      account,
    });

    onStatusChange("success", `Claim thành công! Tx Hash: ${hash}`);
    return hash;
  } catch (error: any) {
    onStatusChange("error", error.message || "Giao dịch thất bại.");
    throw error;
  }
}
