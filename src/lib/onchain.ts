import { createPublicClient, formatUnits, http } from "viem"
import { base, baseSepolia } from "viem/chains"
import {
  TOKENCAST_ABI,
  TOKENCAST_CHAIN_ID,
  TOKENCAST_CONTRACT_ADDRESS,
  TOKENCAST_IS_DEPLOYED,
} from "@/lib/contract"

const chain = TOKENCAST_CHAIN_ID === baseSepolia.id ? baseSepolia : base
const publicClient = createPublicClient({ chain, transport: http() })

export type OnchainSnapshot = {
  mintedSupply: number
  era: number
  walletBalance: number | null
}

export function basescanUrl(path = ""): string {
  const host = chain.id === baseSepolia.id ? "https://sepolia.basescan.org" : "https://basescan.org"
  return `${host}${path}`
}

export async function readOnchainSnapshot(address?: `0x${string}`): Promise<OnchainSnapshot> {
  if (!TOKENCAST_IS_DEPLOYED) throw new Error("Token contract has not been configured.")
  const [mintedSupply, era, walletBalance] = await Promise.all([
    publicClient.readContract({ address: TOKENCAST_CONTRACT_ADDRESS, abi: TOKENCAST_ABI, functionName: "mintedSupply" }),
    publicClient.readContract({ address: TOKENCAST_CONTRACT_ADDRESS, abi: TOKENCAST_ABI, functionName: "currentEra" }),
    address
      ? publicClient.readContract({ address: TOKENCAST_CONTRACT_ADDRESS, abi: TOKENCAST_ABI, functionName: "balanceOf", args: [address] })
      : Promise.resolve(null),
  ])
  return {
    mintedSupply: Number(formatUnits(mintedSupply, 18)),
    era: Number(era),
    walletBalance: walletBalance === null ? null : Number(formatUnits(walletBalance, 18)),
  }
}

export async function readClaimNonce(address: `0x${string}`): Promise<bigint> {
  if (!TOKENCAST_IS_DEPLOYED) throw new Error("Token contract has not been configured.")
  return publicClient.readContract({
    address: TOKENCAST_CONTRACT_ADDRESS,
    abi: TOKENCAST_ABI,
    functionName: "userNonces",
    args: [address],
  })
}
