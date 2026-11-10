import { createPublicClient, fallback, http, type Address, type Chain } from "viem"
import { base, baseSepolia } from "viem/chains"
import { parseV4Config, type V4Config } from "../../src/lib/v4/config"
import { readV4Network, readV4Day } from "../../src/lib/v4/read"
import { miningPhase, type V4Session } from "../../src/lib/v4/state"
import { supabase } from "./backend"

export function serverV4Config() {
  const env = Object.fromEntries(["CHAIN_ID", "TOKEN_ADDRESS", "DISTRIBUTOR_ADDRESS", "STAKING_ADDRESS", "DAO_ADDRESS", "REGISTRY_ADDRESS"].map(key => [`VITE_V4_${key}`, process.env[`V4_${key}`]]))
  const result = parseV4Config(env)
  if (!result.config) throw Error(result.error)
  return result.config
}
export function serverV4Client(config: V4Config) {
  const chain = config.chainId === 84532 ? baseSepolia : base
  const urls = [process.env.V4_RPC_URL, config.chainId === 84532 ? "https://base-sepolia-rpc.publicnode.com" : "https://base-rpc.publicnode.com"].filter(Boolean) as string[]
  return createPublicClient({ chain: chain as Chain, batch: { multicall: true }, transport: fallback(urls.map(url => http(url, { timeout: 10000, retryCount: 1 }))) })
}
export function scopeV4(config: V4Config) { return `chain_id=eq.${config.chainId}&distributor=eq.${config.distributor.toLowerCase()}` }
export const sessionColumns = "id,fid,wallet_address,cast_hash,day,started_at,ends_at,follower_count,estimated_weight,follower_observed_at"
export async function sessionsV4(config: V4Config, fid: number) {
  const result = await supabase(`v4_mining_sessions?${scopeV4(config)}&fid=eq.${fid}&select=${sessionColumns}&order=day.desc&limit=50`)
  return await result.json() as V4Session[]
}
export async function gateV4(config: V4Config, sessions: V4Session[]) {
  const client = serverV4Client(config)
  const network = await readV4Network(client, config)
  if (network.timestamp < network.launch) return { eligible: false, reason: "V4 mining has not launched yet.", network }
  if (network.pool === 0n) return { eligible: false, reason: "The mining emission schedule has ended.", network }
  if (network.totalBond < 1000000n * 10n ** 18n) return { eligible: false, reason: "Waiting for an active validator bond before starting mining.", network }
  const latest = sessions[0]
  if (latest) {
    if (Date.parse(latest.ends_at) / 1000 > Number(network.timestamp)) return { eligible: false, reason: "Your 24-hour mining session is still active.", network }
    if (BigInt(latest.day) === network.day) return { eligible: false, reason: "This account already has a session in today's cohort.", network }
    const data = await readV4Day(client, config, network, BigInt(latest.day), latest.wallet_address as Address)
    const phase = miningPhase(data, network.timestamp, latest)
    if (!["claimed", "expired", "excluded", "missed", "contested"].includes(phase)) return { eligible: false,
      reason: phase === "claimable" ? "Claim your previous reward before posting another mining cast." : "Your previous reward is waiting for the daily report or review. Claim it before starting again.", network }
  }
  return { eligible: true, reason: "Ready to cast.", network }
}
export function identityV4(config: V4Config) { return { protocol: "open-v4-quorum-1", chainId: config.chainId, distributor: config.distributor } }
