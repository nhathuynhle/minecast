import { getAddress, isAddress, keccak256, toHex, zeroAddress, type Address } from "viem"

export const V4_POLICY_HASH = keccak256(toHex("MineCast.OpenV4.Quorum.10:premine2100000:decay50bps:cap100bps:floor10000:followers1-10x-engagement0-10-sqrt-reactors30d-at-close:node3x-prevday-own-commit-fixed-at-cutoff:invite+0.1-max10-in-cap100-fid-once-f100:surplus5-95:onchain-sessions:claim7d:boost-burn-L1-9-x0.2-1M-each-cap*(1+0.2L)-ceil200:followers-weekly-mon-link7d-account30d:utc-day-sessions:commit30m-salted-open-until-reveal:review1h:cast30m-one-day:dupe-text-earliest"))
export type V4Config = { chainId: 8453 | 84532; token: Address; distributor: Address; staking: Address; dao: Address; registry: Address; governor?: Address }
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
  // Optional: without it the app hides stake governance; mining, staking and monthly votes still work.
  const governor = env.VITE_V4_GOVERNOR_ADDRESS?.trim()
  if (governor && (!isAddress(governor) || Object.values(values).some(v => v.toLowerCase() === governor.toLowerCase()))) return { config: null, error: "V4 governor address is invalid." }
  return { config: { chainId, ...values, ...(governor ? { governor: getAddress(governor) } : {}) }, error: null }
}
export function deploymentKey(config: V4Config) { return `${config.chainId}:${config.distributor.toLowerCase()}` }
