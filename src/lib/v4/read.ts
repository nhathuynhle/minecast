import { decodeFunctionData, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem"
import { tokenAbi, distributorAbi, stakingAbi, daoAbi, registryAbi, governorAbi } from "./abi"
import { V4_POLICY_HASH, type V4Config } from "./config"
import { DAY, monthAt, monthStart, previousMonth, type MiningDay } from "./state"

export async function verifyV4(client: PublicClient, config: V4Config, blockNumber?: bigint) {
  if (await client.getChainId() !== config.chainId) throw Error("RPC network does not match this V4 deployment.")
  // The configured distributor may be a past one after a governance upgrade; it still settles its own days.
  const r = await Promise.all([
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "bootstrapAdmin", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "token", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "staking", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "treasury", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "registry", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "POLICY_HASH", blockNumber }),
    ...[config.staking, config.dao, config.registry].map(address => client.readContract({ address, abi: stakingAbi, functionName: "token", blockNumber })),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "staking", blockNumber }),
  ])
  const expected = [zeroAddress, config.token, config.staking, config.dao, config.registry, V4_POLICY_HASH, config.token, config.token, config.token, config.staking]
  if (r.some((value, i) => value.toLowerCase() !== expected[i].toLowerCase())) throw Error("V4 contract links or reward policy do not match. Transactions are disabled.")
}

export async function readV4Network(client: PublicClient, config: V4Config, account?: Address) {
  const block = await client.getBlock()
  const blockNumber = block.number
  await verifyV4(client, config, blockNumber)
  const readToken = <N extends "launchTime" | "totalSupply" | "cumulativeMinted" | "MAX_SUPPLY"> (functionName: N) => client.readContract({ address: config.token, abi: tokenAbi, functionName, blockNumber })
  const [launch, totalSupply, cumulativeMinted, maxSupply, totalStaked, rewardLiability, treasuryBalance, reserved] = await Promise.all([
    readToken("launchTime"), readToken("totalSupply"), readToken("cumulativeMinted"), readToken("MAX_SUPPLY"),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "totalStaked", blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "rewardLiability", blockNumber }),
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "balanceOf", args: [config.dao], blockNumber }),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "reserved", blockNumber }),
  ])
  const day = block.timestamp < launch ? 0n : (block.timestamp - launch) / DAY
  const [pool, totalBond, balance, boostLevel, boostUnlocked, currentDistributor, invites, inviter] = await Promise.all([
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "dailyEmissionForDay", args: [day], blockNumber }),
    client.readContract({ address: config.registry, abi: registryAbi, functionName: "totalWeightAt", args: [day], blockNumber }),
    account ? client.readContract({ address: config.token, abi: tokenAbi, functionName: "balanceOf", args: [account], blockNumber }) : 0n,
    account ? client.readContract({ address: config.token, abi: tokenAbi, functionName: "boostLevel", args: [account], blockNumber }) : 0,
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "boostUnlockedLevel", blockNumber }),
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "distributor", blockNumber }),
    account ? client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "inviteCount", args: [account], blockNumber }) : 0n,
    account ? client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "inviterOf", args: [account], blockNumber }) : zeroAddress,
  ])
  return { blockNumber, timestamp: block.timestamp, launch, day, totalSupply, cumulativeMinted, maxSupply, totalStaked, rewardLiability, treasuryBalance, reserved, pool, totalBond, balance,
    boostLevel: Number(boostLevel), boostUnlocked: Number(boostUnlocked), invites: Number(invites < 10n ? invites : 10n), inviter,
    // Stake governance moved mining to a new distributor: this build can settle old days but must not start sessions.
    currentDistributor, moved: currentDistributor.toLowerCase() !== config.distributor.toLowerCase() }
}
export type V4Network = Awaited<ReturnType<typeof readV4Network>>

export async function readV4Day(client: PublicClient, config: V4Config, network: V4Network, day: bigint, account?: Address): Promise<MiningDay> {
  if (day < 0n || day > network.day) throw Error("Choose a mining day between 0 and the current day.")
  const blockNumber = network.blockNumber
  const [info, allocation, pool, reviewPeriod, resultWindow, commitWindow] = await Promise.all([
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "dayInfo", args: [day], blockNumber }),
    account ? client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "allocations", args: [day, account], blockNumber }) : [0n, 0n, false] as const,
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "dailyEmissionForDay", args: [day], blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "REVIEW_PERIOD", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "RESULT_WINDOW", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "COMMIT_WINDOW", blockNumber }),
  ])
  const [, certifiedAt] = await client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "certificate", args: [info.digest], blockNumber })
  return { day, digest: info.digest, allocated: info.report.allocated, totalWeight: info.report.totalWeight, published: info.published,
    leafCount: info.report.leafCount, certifiedAt, claimEnd: info.claimEnd, contested: info.contested,
    fid: allocation[0], amount: allocation[1], claimed: allocation[2], pool, end: network.launch + (day + 1n) * DAY, reviewPeriod, resultWindow, commitWindow }
}

/** Earlier days whose 7-day claim window is open for `account`; a day can stay claimable ~16 days after it ends. */
export async function claimableDays(client: PublicClient, config: V4Config, network: V4Network, account: Address) {
  const days = Array.from({ length: 17 }, (_, i) => network.day - 1n - BigInt(i)).filter(day => day >= 0n)
  const rows = await Promise.all(days.map(day => Promise.all([
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "dayInfo", args: [day], blockNumber: network.blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "allocations", args: [day, account], blockNumber: network.blockNumber }),
  ])))
  return days.filter((_, i) => rows[i][0].claimEnd > network.timestamp && rows[i][1][1] > 0n && !rows[i][1][2]).reverse()
}

export async function readV4Stake(client: PublicClient, config: V4Config, network: V4Network, epoch: bigint, account?: Address) {
  const blockNumber = network.blockNumber, who = account ?? zeroAddress
  const [balance, lockedUntil, votingPower, nextEpoch, reward, collected] = await Promise.all([
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "stakedBalance", args: [who], blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "lockedUntil", args: [who], blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "getVotes", args: [who], blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "nextEpochToFinalize", blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "epochs", args: [epoch], blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "claimed", args: [epoch, who], blockNumber }),
  ])
  const pastStake = reward[5] && BigInt(reward[0]) < network.timestamp ? await client.readContract({ address: config.staking, abi: stakingAbi, functionName: "stakeAtTime", args: [who, BigInt(reward[0])], blockNumber }) : 0n
  return { balance, lockedUntil, votingPower, nextEpoch, epoch, claimEnd: reward[1], totalAtSnapshot: reward[2], rewardAmount: reward[3], finalized: reward[6], collected,
    canSweep: reward[6] && reward[1] > 0n && network.timestamp >= reward[1] && !reward[7],
    claimable: account && reward[6] && !collected && network.timestamp < reward[1] && reward[2] > 0n ? reward[3] * pastStake / reward[2] : 0n }
}
export type V4Stake = Awaited<ReturnType<typeof readV4Stake>>

export async function readV4Dao(client: PublicClient, config: V4Config, network: V4Network, month: bigint, account?: Address) {
  const blockNumber = network.blockNumber, who = account ?? zeroAddress
  const previous = previousMonth(month)
  const [r, voted, collected, monthFinalized] = await Promise.all([
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "rounds", args: [month], blockNumber }),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "voted", args: [month, who], blockNumber }),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "collected", args: [month, who], blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "monthFinalized", args: [previous], blockNumber }),
  ])
  const openedAt = r[1] > 0n ? r[1] - 7n * DAY : 0n
  const [power, share, stakedAtOpen] = await Promise.all([
    r[1] > 0n && r[0] < network.timestamp ? client.readContract({ address: config.staking, abi: stakingAbi, functionName: "votingPowerAt", args: [who, r[0]], blockNumber }) : 0n,
    r[7] > 0n ? client.readContract({ address: r[5], abi: distributorAbi, functionName: "claimedByMonth", args: [r[6], who], blockNumber }) : 0n,
    openedAt > 0n && openedAt < network.timestamp ? client.readContract({ address: config.staking, abi: stakingAbi, functionName: "stakeAtTime", args: [who, openedAt], blockNumber }) : 0n,
  ])
  // Airdrops require a third of the prior month's mining to be staked when the round opened.
  const eligible = share > 0n && stakedAtOpen * 3n >= share
  const date = new Date(Number(network.timestamp) * 1000).getUTCDate()
  return { month, previous, snapshot: r[0], voteEnd: r[1], claimEnd: r[2], airdrop: r[1] > 0n ? r[3] : month % 2n === 1n,
    settled: r[4], budget: r[8], remaining: r[9], yes: r[10], no: r[11], voted, collected, power, monthFinalized,
    // Month ledgers close after the last cohort's 8-day result window and 7-day claim window (+1 day).
    canFinalizeMonth: !monthFinalized && monthStart(month) > network.launch && network.timestamp >= monthStart(month) + 16n * DAY,
    canOpen: month === monthAt(network.timestamp) && date >= 8 && date <= 28 && monthFinalized && r[1] === 0n,
    canSettle: r[1] > 0n && !r[4] && network.timestamp >= r[1] + (r[10] > r[11] ? 3n * DAY : 0n),
    mined: share, eligible,
    claimable: account && eligible && r[2] > network.timestamp && !collected && r[7] > 0n ? r[8] * share / r[7] : 0n }
}
export type V4Dao = Awaited<ReturnType<typeof readV4Dao>>

export const PROPOSAL_STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"] as const
export type V4ProposalAction = { kind: "spend" | "spendLarge"; to: Address; amount: bigint } | { kind: "call"; target: Address; label: string }
export type V4Proposal = {
  id: bigint; proposer: Address; state: typeof PROPOSAL_STATES[number]; description: string; actions: V4ProposalAction[]
  targets: Address[]; values: bigint[]; calldatas: Hex[]; descriptionHash: Hex
  forVotes: bigint; againstVotes: bigint; abstainVotes: bigint; quorum: bigint; supermajority: boolean
  snapshot: bigint; deadline: bigint; eta: bigint; voted: boolean; power: bigint
}
const timelockAbi = parseAbi(["function getMinDelay() view returns (uint256)"])
type Created = { proposer: Address; targets: Address[]; values: bigint[]; calldatas: Hex[]; description: string }
const created = new Map<string, Created>() // ProposalCreated never changes, so it is read once per proposal

function decodeAction(config: V4Config, target: Address, data: Hex): V4ProposalAction {
  const known = [[config.dao, daoAbi], [config.token, tokenAbi], [config.registry, registryAbi], [config.governor, governorAbi]] as const
  const abi = known.find(([address]) => address?.toLowerCase() === target.toLowerCase())?.[1]
  try {
    if (abi) {
      const call = decodeFunctionData({ abi: abi as any, data })
      if ((call.functionName === "spend" || call.functionName === "spendLarge") && abi === daoAbi) return { kind: call.functionName, to: call.args![0] as Address, amount: call.args![1] as bigint }
      return { kind: "call", target, label: call.functionName }
    }
  } catch { /* unknown selector: shown raw */ }
  return { kind: "call", target, label: data.slice(0, 10) }
}

/** Stake governance and treasury state for the miniapp: the latest proposals, voting power and the spend cap. */
export async function readV4Governance(client: PublicClient, config: V4Config, network: V4Network, account?: Address, limit = 10) {
  const governor = config.governor
  if (!governor) return null
  const blockNumber = network.blockNumber, gov = { address: governor, abi: governorAbi, blockNumber } as const
  const [dao, staking, registry, timelock, daoGovernance] = await Promise.all([
    client.readContract({ ...gov, functionName: "dao" }), client.readContract({ ...gov, functionName: "token" }),
    client.readContract({ ...gov, functionName: "registry" }), client.readContract({ ...gov, functionName: "timelock" }),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "governance", blockNumber }),
  ])
  if ([dao, staking, registry, timelock].some((v, i) => v.toLowerCase() !== [config.dao, config.staking, config.registry, daoGovernance][i].toLowerCase()))
    throw Error("Governor links do not match this V4 deployment. Governance actions are disabled.")
  const [threshold, votingDelay, votingPeriod, timelockDelay, count, clock, spendCredit, spendAt, largeCredit, largeAt, keys] = await Promise.all([
    client.readContract({ ...gov, functionName: "proposalThreshold" }), client.readContract({ ...gov, functionName: "votingDelay" }),
    client.readContract({ ...gov, functionName: "votingPeriod" }), client.readContract({ address: timelock, abi: timelockAbi, functionName: "getMinDelay", blockNumber }),
    client.readContract({ ...gov, functionName: "proposalCount" }), client.readContract({ ...gov, functionName: "clock" }),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "spendCredit", blockNumber }),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "spendAt", blockNumber }),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "largeSpendCredit", blockNumber }),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "largeSpendAt", blockNumber }),
    account ? client.readContract({ address: config.registry, abi: registryAbi, functionName: "keysOf", args: [account], blockNumber }) : [],
  ])
  const votes = account && clock > 0n ? await client.readContract({ ...gov, functionName: "getVotes", args: [account, BigInt(clock) - 1n] }) : 0n
  // An active node's operator may propose without the stake threshold (proposeAsNode with that key).
  const weights = await Promise.all(keys.map(key => client.readContract({ address: config.registry, abi: registryAbi, functionName: "weightAt", args: [key, network.day], blockNumber })))
  const nodeKey = keys.find((_, i) => weights[i] > 0n)
  const unreserved = network.treasuryBalance - network.reserved
  // Both DAO spends draw on credit (basis points of the unreserved treasury) that refills linearly up to its cap.
  const available = (credit: bigint, at: bigint, capBps: bigint, refill: bigint) => {
    const bps = credit + (network.timestamp - at) * capBps / refill
    return unreserved * (bps > capBps ? capBps : bps) / 10_000n
  }
  const indexes = Array.from({ length: Math.min(limit, Number(count)) }, (_, i) => count - 1n - BigInt(i))
  const proposals = await Promise.all(indexes.map(async index => {
    const [id, createdBlock] = await client.readContract({ ...gov, functionName: "proposalAt", args: [index] })
    const key = `${config.chainId}:${governor.toLowerCase()}:${id}`
    if (!created.has(key)) {
      const logs = await client.getContractEvents({ address: governor, abi: governorAbi, eventName: "ProposalCreated", fromBlock: createdBlock, toBlock: createdBlock })
      const log = logs.find(l => l.args.proposalId === id)
      if (!log) throw Error("Proposal details are temporarily unavailable.")
      const a = log.args as unknown as Created
      created.set(key, { proposer: a.proposer, targets: [...a.targets], values: [...a.values], calldatas: [...a.calldatas], description: a.description })
    }
    const c = created.get(key)!
    const [state, tally, supermajority, snapshot, deadline, eta, voted] = await Promise.all([
      client.readContract({ ...gov, functionName: "state", args: [id] }), client.readContract({ ...gov, functionName: "proposalVotes", args: [id] }),
      client.readContract({ ...gov, functionName: "needsSupermajority", args: [id] }),
      client.readContract({ ...gov, functionName: "proposalSnapshot", args: [id] }), client.readContract({ ...gov, functionName: "proposalDeadline", args: [id] }),
      client.readContract({ ...gov, functionName: "proposalEta", args: [id] }),
      account ? client.readContract({ ...gov, functionName: "hasVoted", args: [id, account] }) : false,
    ])
    // Quorum and voting power exist only once the snapshot time (Governor timestamp clock) has passed (zero while the proposal is pending).
    const started = snapshot < BigInt(clock)
    const [quorum, power] = await Promise.all([
      started ? client.readContract({ ...gov, functionName: "proposalQuorum", args: [id] }) : 0n,
      account && started ? client.readContract({ ...gov, functionName: "getVotes", args: [account, snapshot] }) : 0n,
    ])
    return { id, proposer: c.proposer, state: PROPOSAL_STATES[state], description: c.description,
      actions: c.targets.map((target, i) => decodeAction(config, target, c.calldatas[i])),
      targets: c.targets, values: c.values, calldatas: c.calldatas, descriptionHash: keccak256(toHex(c.description)),
      againstVotes: tally[0], forVotes: tally[1], abstainVotes: tally[2], quorum, supermajority, snapshot, deadline, eta, voted, power } satisfies V4Proposal
  }))
  return { governor, clock: BigInt(clock), threshold, votes, nodeKey, votingDelay, votingPeriod, timelockDelay, proposals,
    treasury: { balance: network.treasuryBalance, reserved: network.reserved, unreserved,
      capRemaining: available(spendCredit, spendAt, 500n, 30n * DAY), largeRemaining: available(largeCredit, largeAt, 2000n, 90n * DAY) } }
}
export type V4Governance = NonNullable<Awaited<ReturnType<typeof readV4Governance>>>
