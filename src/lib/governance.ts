import { createPublicClient, createWalletClient, custom, formatUnits, http, isAddress, zeroAddress } from "viem"
import { base, baseSepolia } from "viem/chains"
import { ethereumProviderForChain } from "@/lib/farcaster"
import { TOKENCAST_CHAIN_ID } from "@/lib/contract"

const configuredAddress = import.meta.env.VITE_DAO_GOVERNANCE_ADDRESS
export const DAO_GOVERNANCE_ADDRESS = (
  configuredAddress && isAddress(configuredAddress) ? configuredAddress : zeroAddress
) as `0x${string}`

const configuredChainId = Number(import.meta.env.VITE_DAO_CHAIN_ID ?? TOKENCAST_CHAIN_ID)
export const DAO_CHAIN_ID = configuredChainId === baseSepolia.id ? baseSepolia.id : base.id
export const DAO_IS_DEPLOYED = DAO_GOVERNANCE_ADDRESS !== zeroAddress

const chain = DAO_CHAIN_ID === baseSepolia.id ? baseSepolia : base
const publicClient = createPublicClient({ chain, transport: http() })

const GOVERNANCE_ABI = [
  { type: "function", name: "currentEpoch", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function", name: "proposalForEpoch", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint8" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "proposals", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { type: "uint8" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" },
    ],
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
  kind: "Community airdrop" | "Treasury burn"
  epoch: number
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
  const [epochRaw, blockNumber] = await Promise.all([
    publicClient.readContract({ address: DAO_GOVERNANCE_ADDRESS, abi: GOVERNANCE_ABI, functionName: "currentEpoch" }),
    publicClient.getBlockNumber(),
  ])
  const epoch = Number(epochRaw)
  const epochs = epoch > 0 ? [epoch, epoch - 1] : [epoch]
  const ids = (await Promise.all(
    epochs.flatMap((candidate) => [0, 1].map((kind) => publicClient.readContract({
      address: DAO_GOVERNANCE_ADDRESS, abi: GOVERNANCE_ABI, functionName: "proposalForEpoch", args: [BigInt(candidate), kind],
    }))),
  )).filter((id) => id !== 0n)

  const proposals = await Promise.all(ids.map(async (id) => {
    const raw = await publicClient.readContract({ address: DAO_GOVERNANCE_ADDRESS, abi: GOVERNANCE_ABI, functionName: "proposals", args: [id] })
    const proposal = raw as unknown as readonly [number, bigint, bigint, bigint, bigint, number, string, string, string, bigint, bigint, bigint, boolean]
    const voted = account
      ? await publicClient.readContract({ address: DAO_GOVERNANCE_ADDRESS, abi: GOVERNANCE_ABI, functionName: "hasVoted", args: [id, account] })
      : false
    return {
      id,
      kind: proposal[0] === 0 ? "Community airdrop" : "Treasury burn",
      epoch: Number(proposal[1]),
      amount: formatUnits(proposal[9], 18),
      yesVotes: formatUnits(proposal[10], 18),
      noVotes: formatUnits(proposal[11], 18),
      snapshotBlock: proposal[2],
      deadlineBlock: proposal[3],
      active: blockNumber > proposal[2] && blockNumber <= proposal[3],
      voted,
    } satisfies DaoProposal
  }))
  return { epoch, proposals }
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
