import { zeroAddress, type Address, type PublicClient } from "viem"
import { tokenAbi, distributorAbi, stakingAbi, daoAbi, registryAbi } from "./abi"
import { V4_POLICY_HASH, type V4Config } from "./config"
import { DAY, monthAt, monthStart, previousMonth, type MiningDay } from "./state"

export async function verifyV4(client: PublicClient, config: V4Config, blockNumber?: bigint) {
  if (await client.getChainId() !== config.chainId) throw Error("RPC network does not match this V4 deployment.")
  const r = await Promise.all([
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "distributor", blockNumber }),
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "bootstrapAdmin", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "token", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "staking", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "treasury", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "registry", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "POLICY_HASH", blockNumber }),
    ...[config.staking, config.dao, config.registry].map(address => client.readContract({ address, abi: stakingAbi, functionName: "token", blockNumber })),
    client.readContract({ address: config.dao, abi: daoAbi, functionName: "staking", blockNumber }),
  ])
  const expected = [config.distributor, zeroAddress, config.token, config.staking, config.dao, config.registry, V4_POLICY_HASH, config.token, config.token, config.token, config.staking]
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
  const [pool, totalBond, balance, boostLevel, boostUnlocked] = await Promise.all([
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "dailyEmissionForDay", args: [day], blockNumber }),
    client.readContract({ address: config.registry, abi: registryAbi, functionName: "totalWeightAt", args: [day], blockNumber }),
    account ? client.readContract({ address: config.token, abi: tokenAbi, functionName: "balanceOf", args: [account], blockNumber }) : 0n,
    account ? client.readContract({ address: config.token, abi: tokenAbi, functionName: "boostLevel", args: [account], blockNumber }) : 0,
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "boostUnlockedLevel", blockNumber }),
  ])
  return { blockNumber, timestamp: block.timestamp, launch, day, totalSupply, cumulativeMinted, maxSupply, totalStaked, rewardLiability, treasuryBalance, reserved, pool, totalBond, balance,
    boostLevel: Number(boostLevel), boostUnlocked: Number(boostUnlocked) }
}
export type V4Network = Awaited<ReturnType<typeof readV4Network>>

export async function readV4Day(client: PublicClient, config: V4Config, network: V4Network, day: bigint, account?: Address): Promise<MiningDay> {
  if (day < 0n || day > network.day) throw Error("Choose a mining day between 0 and the current day.")
  const blockNumber = network.blockNumber
  const [info, allocation, pool, reviewPeriod, resultWindow, workWindow] = await Promise.all([
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "dayInfo", args: [day], blockNumber }),
    account ? client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "allocations", args: [day, account], blockNumber }) : [0n, 0n, false] as const,
    client.readContract({ address: config.token, abi: tokenAbi, functionName: "dailyEmissionForDay", args: [day], blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "REVIEW_PERIOD", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "RESULT_WINDOW", blockNumber }),
    client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "WORK_WINDOW", blockNumber }),
  ])
  const [, certifiedAt] = await client.readContract({ address: config.distributor, abi: distributorAbi, functionName: "certificate", args: [info.digest], blockNumber })
  return { day, digest: info.digest, allocated: info.report.allocated, totalWeight: info.report.totalWeight, published: info.published,
    leafCount: info.report.leafCount, certifiedAt, claimEnd: info.claimEnd, contested: info.contested,
    fid: allocation[0], amount: allocation[1], claimed: allocation[2], pool, end: network.launch + (day + 1n) * DAY, reviewPeriod, resultWindow, workWindow }
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
  const [balance, lockedUntil, activePower, nextEpoch, reward, collected] = await Promise.all([
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "stakedBalance", args: [who], blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "lockedUntil", args: [who], blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "activeVotingBalance", args: [who], blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "nextEpochToFinalize", blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "epochs", args: [epoch], blockNumber }),
    client.readContract({ address: config.staking, abi: stakingAbi, functionName: "claimed", args: [epoch, who], blockNumber }),
  ])
  const pastStake = reward[5] && BigInt(reward[0]) < network.timestamp ? await client.readContract({ address: config.staking, abi: stakingAbi, functionName: "stakeAtTime", args: [who, BigInt(reward[0])], blockNumber }) : 0n
  return { balance, lockedUntil, activePower, nextEpoch, epoch, claimEnd: reward[1], totalAtSnapshot: reward[2], rewardAmount: reward[3], finalized: reward[6], collected,
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
  const [power, share] = await Promise.all([
    r[1] > 0n && r[0] < blockNumber ? client.readContract({ address: config.staking, abi: stakingAbi, functionName: "votingPowerAt", args: [who, r[0]], blockNumber }) : 0n,
    r[7] > 0n ? client.readContract({ address: r[5], abi: distributorAbi, functionName: "claimedByMonth", args: [r[6], who], blockNumber }) : 0n,
  ])
  const date = new Date(Number(network.timestamp) * 1000).getUTCDate()
  return { month, previous, snapshot: r[0], voteEnd: r[1], claimEnd: r[2], airdrop: r[1] > 0n ? r[3] : month % 2n === 1n,
    settled: r[4], budget: r[8], remaining: r[9], yes: r[10], no: r[11], voted, collected, power, monthFinalized,
    // Month ledgers close after the last cohort's 8-day result window and 7-day claim window (+1 day).
    canFinalizeMonth: !monthFinalized && monthStart(month) > network.launch && network.timestamp >= monthStart(month) + 16n * DAY,
    canOpen: month === monthAt(network.timestamp) && date >= 8 && date <= 28 && monthFinalized && r[1] === 0n,
    canSettle: r[1] > 0n && !r[4] && network.timestamp >= r[1] + (r[10] > r[11] ? 3n * DAY : 0n),
    claimable: account && r[2] > network.timestamp && !collected && r[7] > 0n ? r[8] * share / r[7] : 0n }
}
export type V4Dao = Awaited<ReturnType<typeof readV4Dao>>
