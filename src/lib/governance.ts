import { createPublicClient, createWalletClient, custom, formatUnits, isAddress, zeroAddress } from "viem"
import { base, baseSepolia } from "viem/chains"
import { baseRpcTransport } from "./base-rpc"
import { ethereumProviderForChain } from "@/lib/farcaster"
import { TOKENCAST_CHAIN_ID } from "@/lib/contract"

const configuredAddress = import.meta.env.VITE_DAO_GOVERNANCE_ADDRESS
export const DAO_GOVERNANCE_ADDRESS = (
  configuredAddress && isAddress(configuredAddress) ? configuredAddress : zeroAddress
) as `0x${string}`

const configuredChainId = Number(import.meta.env.VITE_DAO_CHAIN_ID ?? TOKENCAST_CHAIN_ID)
export const DAO_CHAIN_ID = configuredChainId === baseSepolia.id ? baseSepolia.id : base.id
export const DAO_IS_DEPLOYED = DAO_GOVERNANCE_ADDRESS !== zeroAddress
const stakingAddress = import.meta.env.VITE_DAO_STAKING_ADDRESS
export const DAO_STAKING_ADDRESS = (stakingAddress && isAddress(stakingAddress) ? stakingAddress : zeroAddress) as `0x${string}`
export const STAKING_IS_CONFIGURED = DAO_STAKING_ADDRESS !== zeroAddress

const chain = DAO_CHAIN_ID === baseSepolia.id ? baseSepolia : base
const publicClient = createPublicClient({ chain, transport: baseRpcTransport(chain.id) })

export async function readTotalStaked(): Promise<string> {
  if (!STAKING_IS_CONFIGURED) throw new Error("Staking is not configured.")
  const total = await publicClient.readContract({ address: DAO_STAKING_ADDRESS, abi: [{ type: "function", name: "totalStaked", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const, functionName: "totalStaked" })
  return formatUnits(total, 18)
}

const GOVERNANCE_ABI = [
  { type: "function", name: "currentCalendarMonth", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function", name: "proposalForMonth", stateMutability: "view",
    inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "proposalInfo", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { type: "uint8" }, { type: "uint64" }, { type: "uint32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint32" }, { type: "bool" },
    ],
  },
  {
    type: "function", name: "proposalVotes", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function", name: "hasVoted", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "castVote", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "bool" }], outputs: [{ type: "uint256" }],
  },
] as const

export type DaoProposal = {
  id: bigint
  kind: "Miner airdrop" | "Treasury burn"
  targetCalendarMonth: number
  calendarMonth: number
  amount: string
  yesVotes: string
  noVotes: string
  snapshotBlock: bigint
  deadlineBlock: bigint
  active: boolean
  voted: boolean
}

export async function readDaoProposals(account?: `0x${string}`): Promise<{ epoch: number; proposals: DaoProposal[] }> {
  if (!DAO_IS_DEPLOYED) return { epoch: 0, proposals: [] }
  const [calendarMonthRaw, blockNumber] = await Promise.all([
    publicClient.readContract({ address: DAO_GOVERNANCE_ADDRESS, abi: GOVERNANCE_ABI, functionName: "currentCalendarMonth" }),
    publicClient.getBlockNumber(),
  ])
  const calendarMonth = Number(calendarMonthRaw)
  const proposalId = await publicClient.readContract({
    address: DAO_GOVERNANCE_ADDRESS,
    abi: GOVERNANCE_ABI,
    functionName: "proposalForMonth",
    args: [BigInt(calendarMonth)],
  })
  const ids = proposalId === 0n ? [] : [proposalId]

  const proposals = await Promise.all(ids.map(async (id) => {
    const [rawInfo, rawVotes] = await Promise.all([
      publicClient.readContract({ address: DAO_GOVERNANCE_ADDRESS, abi: GOVERNANCE_ABI, functionName: "proposalInfo", args: [id] }),
      publicClient.readContract({ address: DAO_GOVERNANCE_ADDRESS, abi: GOVERNANCE_ABI, functionName: "proposalVotes", args: [id] }),
    ])
    const proposal = rawInfo as unknown as readonly [number, bigint, number, bigint, bigint, bigint, number, boolean]
    const votes = rawVotes as unknown as readonly [bigint, bigint, bigint]
    const voted = account
      ? await publicClient.readContract({ address: DAO_GOVERNANCE_ADDRESS, abi: GOVERNANCE_ABI, functionName: "hasVoted", args: [id, account] })
      : false
    return {
      id,
      kind: proposal[0] === 0 ? "Miner airdrop" : "Treasury burn",
      targetCalendarMonth: Number(proposal[1]),
      calendarMonth: Number(proposal[2]),
      amount: formatUnits(votes[0], 18),
      yesVotes: formatUnits(votes[1], 18),
      noVotes: formatUnits(votes[2], 18),
      snapshotBlock: proposal[3],
      deadlineBlock: proposal[4],
      active: blockNumber > proposal[3] && blockNumber <= proposal[4],
      voted,
    } satisfies DaoProposal
  }))
  return { epoch: calendarMonth, proposals }
}

export async function castDaoVote(proposalId: bigint, support: boolean): Promise<`0x${string}`> {
  if (!DAO_IS_DEPLOYED) throw new Error("MineCast DAO V3 has not been deployed yet.")
  const provider = await ethereumProviderForChain(DAO_CHAIN_ID)
  const walletClient = createWalletClient({ chain, transport: custom(provider as any) })
  const [account] = await walletClient.requestAddresses()
  if (!account) throw new Error("No wallet was connected.")

  const { request } = await publicClient.simulateContract({
    address: DAO_GOVERNANCE_ADDRESS,
    abi: GOVERNANCE_ABI,
    functionName: "castVote",
    args: [proposalId, support],
    account,
  })
  const hash = await walletClient.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") throw new Error("DAO vote transaction reverted on Base.")
  return hash
}
