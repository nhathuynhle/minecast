import { createWalletClient, custom, parseEther } from "viem";
import { base, baseSepolia } from "viem/chains";
import { TOKENCAST_ABI, TOKENCAST_CONTRACT_ADDRESS } from "./contract";

export type ClaimStatus = "idle" | "requesting_voucher" | "sending_tx" | "success" | "error";

export async function executeClaimOnBase({
  userAddress,
  amount,
  isTestnet = false,
  onStatusChange,
}: {
  userAddress: `0x${string}`;
  amount: number;
  isTestnet?: boolean;
  onStatusChange: (status: ClaimStatus, message?: string) => void;
}) {
  try {
    if (typeof window === "undefined" || !(window as any).ethereum) {
      throw new Error("Không tìm thấy ví Web3 (Warpcast hoặc MetaMask).");
    }

    onStatusChange("requesting_voucher", "Đang xin chữ ký xác thực từ máy chủ...");

    const chain = isTestnet ? baseSepolia : base;
    const chainId = chain.id;

    // 1. Gọi Server API để lấy voucher có chữ ký hợp lệ
    const response = await fetch("/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userAddress,
        amount,
        nonce: 0, // trong thực tế contract sẽ check nonce
        chainId,
        contractAddress: TOKENCAST_CONTRACT_ADDRESS,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Không thể lấy chữ ký xác nhận claim.");
    }

    const { amountWei, deadline, v, r, s } = data;

    onStatusChange("sending_tx", "Vui lòng xác nhận giao dịch trên ví Base của bạn (Phí gas ~$0.002)...");

    // 2. Mở ví của user để ký giao dịch on-chain
    const walletClient = createWalletClient({
      chain,
      transport: custom((window as any).ethereum),
    });

    const [account] = await walletClient.getAddresses();
    if (!account) {
      throw new Error("Chưa kết nối ví.");
    }

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
