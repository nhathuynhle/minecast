// Keeper: the permissionless upkeep no one owns. Every node runs it at the end of each worker pass, so the
// protocol keeps moving without the founder. Each candidate call is simulated first; the contracts themselves
// decide whether it is due, and a call that would revert is simply not sent. Gas comes from the node key.
//   closing months, opening and settling the monthly DAO vote, releasing expired airdrops,
//   finalizing and sweeping staking epochs, opening claims for days certified by other nodes,
//   ejecting keys that went silent (found from registry Activated logs, scanned incrementally),
//   and proving keys "behind" on stalled days whose leading report this node signed (3 in a row eject them).
import fs from 'node:fs'
import path from 'node:path'
import { parseAbi } from 'viem'
import { buildOpenReport } from '../open-report.mjs'

const DAY = 86400n
const abi = parseAbi([
  'function registry() view returns (address)',
  'function staking() view returns (address)',
  'function treasury() view returns (address)',
  'function finalizeMonth(uint256 nextMonthStart)',
  'function activateDay(uint256 day)',
  'function openMonthlyVote() returns (uint256)',
  'function settle(uint256 month)',
  'function releaseExpiredAirdrop(uint256 month)',
  'function nextEpochToFinalize() view returns (uint256)',
  'function currentEpoch() view returns (uint256)',
  'function finalizeEpoch(uint256 epoch)',
  'function sweepUnclaimed(uint256 epoch)',
  'function ejectInactive(address signingKey)',
  'struct Report { uint256 day; bytes32 root; uint256 totalWeight; uint256 allocated; uint256 leafCount; bytes32 sourceHash; }',
  'function proveBehind(uint256 day, address signingKey, Report leader)',
  'event Activated(address indexed signingKey, uint256 indexed startDay, uint256 weight)',
])

/** First second of the UTC month `back` months before the one holding `now`, and its yyyymm id. */
function month(now, back) {
  const d = new Date(Number(now) * 1000), start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) / 1000
  const m = new Date(start * 1000)
  return { start: BigInt(start), id: BigInt(m.getUTCFullYear() * 100 + m.getUTCMonth() + 1) }
}

// Public Base endpoints cap eth_getLogs at 200 blocks per call.
const LOG_RANGE = 200n

/** First block holding the registry's code: no key can have been activated before it. */
async function deployBlock(client, address, head) {
  let lo = 0n, hi = head
  while (lo < hi) { const mid = (lo + hi) / 2n; if ((await client.getCode({ address, blockNumber: mid }))?.length > 2) hi = mid; else lo = mid + 1n }
  return lo
}

/** Every key ever activated, from Activated logs; the scan starts at the registry's deployment and saves its
 *  progress after every range, so an RPC failure costs one range, not the whole scan. */
async function activatedKeys(client, registry, dir, head) {
  const file = path.join(dir, `keeper-${registry.toLowerCase()}.json`)
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  let from = state ? BigInt(state.from) : await deployBlock(client, registry, head)
  const keys = new Set(state?.keys ?? [])
  for (let i = 0; i < 50 && from <= head; i++) {
    const to = from + LOG_RANGE - 1n < head ? from + LOG_RANGE - 1n : head
    for (const log of await client.getContractEvents({ address: registry, abi, eventName: 'Activated', fromBlock: from, toBlock: to })) keys.add(log.args.signingKey)
    from = to + 1n
    fs.writeFileSync(file, JSON.stringify({ from: String(from), keys: [...keys] }))
  }
  return [...keys]
}

export async function keep({ client, account, distributor, dir }, launchTime, now) {
  const done = []
  async function attempt(address, functionName, args = []) {
    let request
    try { ({ request } = await client.simulateContract({ address, abi, functionName, args, account })) }
    catch (error) {
      if (!error.walk?.(e => e.name === 'ContractFunctionRevertedError')) throw error // RPC trouble, not "not due yet"
      return
    }
    const receipt = await client.waitForTransactionReceipt({ hash: await client.writeContract(request) })
    if (receipt.status !== 'success') throw Error(functionName + ' reverted')
    done.push(`${functionName}(${args.join(', ')})`)
  }
  const read = (address, functionName, args) => client.readContract({ address, abi, functionName, args })
  const [registry, staking, dao] = await Promise.all(['registry', 'staking', 'treasury'].map(name => read(distributor, name)))
  const today = now < launchTime ? 0n : (now - launchTime) / DAY

  // Days certified and published by other nodes: open their claims once the review is over.
  for (let day = today > 8n ? today - 8n : 0n; day < today; day++) await attempt(distributor, 'activateDay', [day])
  for (const back of [1, 0]) await attempt(distributor, 'finalizeMonth', [month(now, back).start])
  await attempt(dao, 'openMonthlyVote')
  for (const back of [1, 0]) await attempt(dao, 'settle', [month(now, back).id])
  for (const back of [5, 4, 3]) await attempt(dao, 'releaseExpiredAirdrop', [month(now, back).id])
  await attempt(staking, 'finalizeEpoch', [await read(staking, 'nextEpochToFinalize')])
  const epoch = await read(staking, 'currentEpoch')
  for (const back of [5n, 4n]) if (epoch >= back) await attempt(staking, 'sweepUnclaimed', [epoch - back])
  const keys = await activatedKeys(client, registry, dir, await client.getBlockNumber())
  for (const key of keys) await attempt(registry, 'ejectInactive', [key])
  // A day still without quorum a day after its close: if the report this node signed carries over half of the
  // bond, every key off it is behind. Days go in order, since only consecutive days build an ejection.
  for (let day = today > 8n ? today - 8n : 0n; day + 2n <= today; day++) {
    const file = path.join(dir, `${client.chain.id}-${distributor.toLowerCase()}-${day}.json`)
    if (!fs.existsSync(file)) continue
    const { report } = buildOpenReport({ chainId: client.chain.id, distributor, ...JSON.parse(fs.readFileSync(file, 'utf8')).input })
    for (const key of keys) await attempt(distributor, 'proveBehind', [day, key, report])
  }
  return done
}
