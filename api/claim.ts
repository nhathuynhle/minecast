import { privateKeyToAccount } from "viem/accounts";
import { parseEther } from "viem";

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
    const { userAddress, amount, nonce, chainId = 8453, contractAddress } = body;

    if (!userAddress || !amount || nonce === undefined) {
      return new Response(JSON.stringify({ error: "Missing required parameters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Lấy Signer Private Key từ biến môi trường Vercel (được bảo mật 100%)
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

    const amountWei = parseEther(String(amount));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // Hết hạn sau 30 phút

    // Cấu trúc EIP-712 chuẩn khớp 100% với TokenCast.sol
    const domain = {
      name: "TokenCast",
      version: "1",
      chainId: Number(chainId),
      verifyingContract: contractAddress as `0x${string}`,
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
