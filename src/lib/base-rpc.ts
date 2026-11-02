import { fallback, http } from "viem"
import { baseSepolia } from "viem/chains"

/**
 * Browser-safe Base RPC transport.
 *
 * The official public Base endpoints can present Cloudflare challenges to
 * browser/serverless traffic. Put a JSON-RPC endpoint first so read calls do
 * not depend on a cookie or challenge, while retaining the official endpoint
 * as a fallback.
 */
export function baseRpcTransport(chainId: number) {
  const isSepolia = chainId === baseSepolia.id
  const primary = isSepolia
    ? "https://base-sepolia-rpc.publicnode.com"
    : "https://base-rpc.publicnode.com"
  const official = isSepolia
    ? "https://sepolia.base.org"
    : "https://mainnet.base.org"

  return fallback([
    http(primary, { retryCount: 1, retryDelay: 300, timeout: 10_000 }),
    http(official, { retryCount: 0, timeout: 10_000 }),
  ], { retryCount: 0 })
}
