import { createWalletClient, custom, encodeFunctionData, getAddress, type Abi, type Address, type Hash, type PublicClient } from "viem"
import { base, baseSepolia } from "viem/chains"
import { ethereumProviderForChain } from "../farcaster"
import { tokenAbi, distributorAbi, stakingAbi, daoAbi } from "./abi"
import { type V4Config } from "./config"
import { verifyV4 } from "./read"

export type V4Action =
  | { kind: "claim" | "activateDay"; day: bigint }
  | { kind: "stake" | "withdraw"; amount: bigint }
  | { kind: "activatePower" | "revokeApproval" | "openVote" }
  | { kind: "claimStake" | "finalizeEpoch" | "sweepEpoch"; epoch: bigint }
  | { kind: "vote"; month: bigint; yes: boolean }
  | { kind: "settleVote" | "claimAirdrop" | "releaseAirdrop"; month: bigint }
  | { kind: "finalizeMonth"; timestamp: bigint }
export type TxProgress = { status: "idle" | "checking" | "signature" | "pending" | "confirmed" | "error"; message: string; hash?: Hash }
export type PendingV4Tx = { hash: Hash; account: Address; to: Address; data: Hash; label: string }

export function actionCall(config: V4Config, action: V4Action): { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; label: string } {
  const staking = { address: config.staking, abi: stakingAbi }
  const mining = { address: config.distributor, abi: distributorAbi }
  const dao = { address: config.dao, abi: daoAbi }
  switch (action.kind) {
    case "claim": return { ...mining, functionName: "claim", args: [action.day], label: "Mining claim" }
    case "activateDay": return { ...mining, functionName: "activateDay", args: [action.day], label: "Open claim window" }
    case "stake": case "withdraw":
      if (action.amount <= 0n) throw Error("Enter an amount greater than zero.")
      return { ...staking, functionName: action.kind, args: [action.amount], label: action.kind === "stake" ? "Stake" : "Withdraw stake" }
    case "activatePower": return { ...staking, functionName: "activateGovernancePower", args: [], label: "Activate voting power" }
    case "revokeApproval": return { address: config.token, abi: tokenAbi, functionName: "approve", args: [config.staking, 0n], label: "Remove staking approval" }
    case "claimStake": return { ...staking, functionName: "claim", args: [action.epoch], label: "Staking reward" }
    case "finalizeEpoch": return { ...staking, functionName: "finalizeEpoch", args: [action.epoch], label: "Prepare staking rewards" }
    case "sweepEpoch": return { ...staking, functionName: "sweepUnclaimed", args: [action.epoch], label: "Roll expired rewards forward" }
    case "finalizeMonth": return { ...mining, functionName: "finalizeMonth", args: [action.timestamp], label: "Close mining month" }
    case "openVote": return { ...dao, functionName: "openMonthlyVote", args: [], label: "Open monthly vote" }
    case "vote": return { ...dao, functionName: "vote", args: [action.month, action.yes], label: action.yes ? "Vote Yes" : "Vote No" }
    case "settleVote": return { ...dao, functionName: "settle", args: [action.month], label: "Execute vote result" }
    case "claimAirdrop": return { ...dao, functionName: "claimAirdrop", args: [action.month], label: "Airdrop claim" }
    case "releaseAirdrop": return { ...dao, functionName: "releaseExpiredAirdrop", args: [action.month], label: "Release expired airdrop" }
  }
}
export function isRejection(error: unknown): boolean {
  let e = error as { code?: number; cause?: unknown } | undefined
  for (let i = 0; e && i < 8; i++, e = e.cause as typeof e) if (e.code === 4001) return true
  return false
}
export function friendlyV4Error(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/insufficient funds/i.test(message)) return "Your wallet needs ETH on this network to pay the transaction fee."
  if (/InvalidPhase|InvalidRound|InvalidVote|NothingToClaim|AlreadyClaimed/i.test(message)) return "The onchain state changed or this action is not available yet. Refresh and try again."
  if (/Locked/i.test(message)) return "Your stake has not completed its 30-day lock."
  if (/fetch|HTTP|timeout|timed out|429|503/i.test(message)) return "Network data is temporarily unavailable. Refresh to try again."
  return message.split("\n")[0].slice(0, 220)
}

/** A timeout stays pending. Never invite a second withdrawal while the first is unconfirmed. */
export async function confirmV4Transaction(client: PublicClient, pending: PendingV4Tx, update: (state: TxProgress) => void,
  remember: (pending: PendingV4Tx | null) => void): Promise<boolean> {
  update({ status: "pending", hash: pending.hash, message: `${pending.label} submitted. Waiting for confirmation…` })
  try {
    let replaced = false
    const receipt = await client.waitForTransactionReceipt({ hash: pending.hash, timeout: 60_000,
      onReplaced: replacement => {
        if (replacement.reason !== "repriced") replaced = true
        else { pending = { ...pending, hash: replacement.transaction.hash }; remember(pending) }
      } })
    const transaction = await client.getTransaction({ hash: receipt.transactionHash })
    if (replaced || transaction.to?.toLowerCase() !== pending.to.toLowerCase() || transaction.from.toLowerCase() !== pending.account.toLowerCase()
      || transaction.input.toLowerCase() !== pending.data.toLowerCase() || receipt.status !== "success") {
      remember(null)
      update({ status: "error", hash: receipt.transactionHash, message: "Transaction reverted or was replaced with another action. Refresh before retrying." })
      return false
    }
    remember(null)
    update({ status: "confirmed", hash: receipt.transactionHash, message: `${pending.label} confirmed onchain.` })
    return true
  } catch {
    update({ status: "pending", hash: pending.hash, message: "Confirmation is taking longer. Check the transaction status; do not send it again." })
    return false
  }
}

export async function executeV4Action(client: PublicClient, config: V4Config, account: Address, action: V4Action,
  update: (state: TxProgress) => void, remember: (pending: PendingV4Tx | null) => void) {
  try {
    update({ status: "checking", message: "Checking contracts and wallet…" })
    await verifyV4(client, config)
    const chain = config.chainId === 84532 ? baseSepolia : base
    const provider = await ethereumProviderForChain(chain.id)
    const wallet = createWalletClient({ chain, transport: custom(provider as any) })
    const [selected] = await wallet.requestAddresses()
    if (!selected || getAddress(selected) !== getAddress(account)) throw Error("Wallet account changed. Connect the wallet again before continuing.")
    if (await wallet.getChainId() !== chain.id) throw Error("Switch the wallet to the selected Base network.")
    const send = async (call: ReturnType<typeof actionCall>) => {
      // Repeat account/network checks after an approval or wallet interaction.
      const [current] = await wallet.getAddresses()
      if (!current || getAddress(current) !== getAddress(account) || await wallet.getChainId() !== chain.id) throw Error("Wallet or network changed. Reconnect and try again.")
      const { request } = await client.simulateContract({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, account })
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args })
      update({ status: "signature", message: `Confirm ${call.label.toLowerCase()} in your wallet.` })
      const hash = await wallet.writeContract(request)
      const pending: PendingV4Tx = { hash, account, to: call.address, data, label: call.label }
      remember(pending)
      return confirmV4Transaction(client, pending, update, remember)
    }
    if (action.kind === "stake") {
      if (action.amount <= 0n) throw Error("Enter an amount greater than zero.")
      const [balance, allowance] = await Promise.all([
        client.readContract({ address: config.token, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
        client.readContract({ address: config.token, abi: tokenAbi, functionName: "allowance", args: [account, config.staking] }),
      ])
      if (action.amount > balance) throw Error("Stake amount exceeds your onchain balance.")
      if (allowance < action.amount && !await send({ address: config.token, abi: tokenAbi, functionName: "approve", args: [config.staking, action.amount], label: "Exact staking approval" })) return
    }
    await send(actionCall(config, action))
  } catch (error) {
    update(isRejection(error) ? { status: "idle", message: "Wallet request cancelled." } : { status: "error", message: friendlyV4Error(error) })
  }
}
