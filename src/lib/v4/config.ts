import { getAddress, isAddress, keccak256, toHex, zeroAddress, type Address } from "viem"

export const V4_POLICY_HASH = keccak256(toHex("MineCast.OpenV4.Quorum.3:premine2100000:decay50bps:cap100bps:tiers1-2-4-6-10-18-30-50-75-100:node5x-prevday-signer:surplus5-95:onchain-sessions:claim7d:boost-burn-L1-9-x0.2-1M*L-cap*(1+0.2L)"))
export type V4Config = { chainId: 8453 | 84532; token: Address; distributor: Address; staking: Address; dao: Address; registry: Address }
export type ConfigResult = { config: V4Config; error: null } | { config: null; error: string }
export function parseV4Config(env: Record<string, string | undefined>): ConfigResult {
  if (env.VITE_V4_RPC_URL?.trim()) {
    try {
      const url = new URL(env.VITE_V4_RPC_URL.trim())
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw Error()
    } catch { return { config: null, error: "V4 RPC must be an HTTPS URL or a localhost development endpoint." } }
  }
  const chainId = Number(env.VITE_V4_CHAIN_ID)
  if (chainId !== 8453 && chainId !== 84532) return { config: null, error: "V4 needs an explicit Base or Base Sepolia network." }
  const values = {} as Record<"token" | "distributor" | "staking" | "dao" | "registry", Address>
  for (const key of ["token", "distributor", "staking", "dao", "registry"] as const) {
    const address = env[`VITE_V4_${key.toUpperCase()}_ADDRESS`]?.trim()
    if (!address || !isAddress(address) || address.toLowerCase() === zeroAddress) return { config: null, error: "V4 deployment is not configured yet. Mining and transactions will open after deployment." }
    values[key] = getAddress(address)
  }
  if (new Set(Object.values(values)).size !== 5) return { config: null, error: "V4 contract addresses must be five separate deployments." }
  return { config: { chainId, ...values }, error: null }
}
export function deploymentKey(config: V4Config) { return `${config.chainId}:${config.distributor.toLowerCase()}` }
