import { createPublicClient, http, type Chain, type Transport } from "viem"
import { base, baseSepolia } from "viem/chains"
import { baseRpcTransport } from "../base-rpc"
import type { V4Config } from "./config"

export function createV4Client(config: V4Config, rpcUrl?: string) {
  const chain: Chain = config.chainId === 84532 ? baseSepolia : base
  let transport: Transport = baseRpcTransport(config.chainId)
  if (rpcUrl?.trim()) {
    const url = new URL(rpcUrl.trim())
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw Error("V4 RPC must use HTTPS or a localhost development endpoint.")
    transport = http(url.href, { timeout: 10000, retryCount: 1 })
  }
  return createPublicClient({ chain, transport, batch: { multicall: true } })
}
