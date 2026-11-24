import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createTestClient, http, publicActions, walletActions, parseEther, keccak256, toHex, getAddress, getContractAddress, encodeFunctionData, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { compileOpen } from '../research/v4/compile-open.mjs'
import { buildOpenReport, openDigest, typedReport } from '../research/v4/open-report.mjs'
import { commitmentOf } from '../research/v4/node/open-worker.mjs'
import { GOVERNANCE_DELAY } from '../research/v4/prepare-open-deployment.mjs'
import { loadModule } from './v4-test-loader.mjs'
import { checkBrowser } from './v4-browser-check.mjs'

const readApp = await loadModule('src/lib/v4/read.ts')
const { miningPhase, DAY, monthStart } = await loadModule('src/lib/v4/state.ts')
const appABI = await loadModule('src/lib/v4/abi.ts')
const { executeV4Action } = await loadModule('src/lib/v4/transactions.ts', {
  '../farcaster': 'export const ethereumProviderForChain = async () => globalThis.v4TestProvider',
})
const launch = 1893456000n // 2030-01-01 UTC; deterministic isolated chain.

test('miniapp V4 reads and wallet actions integrate with actual contracts', async t => {
  const artifacts = Object.assign({}, ...Object.values(compileOpen().contracts))
  for (const [name, key] of Object.entries({ TokenCastOpenV4: 'tokenAbi', MineCastNodeRegistryV4: 'registryAbi',
    MineCastOpenDistributorV4: 'distributorAbi', MineCastOpenStakingV4: 'stakingAbi', MineCastOpenDaoV4: 'daoAbi', MineCastGovernorV4: 'governorAbi' })) {
    assert.deepEqual(appABI[key], artifacts[name].abi, 'Regenerate stale app ABI: ' + name)
  }
  const child = spawn(process.env.ANVIL_BIN || 'anvil', ['--host', '127.0.0.1', '--port', '0', '--chain-id', '84532',
    '--timestamp', String(launch - 14n * DAY), '--hardfork', 'cancun'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => { child.kill(); delete globalThis.v4TestProvider })
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Anvil startup timeout')) }, 15000)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    createInterface({ input: child.stdout }).on('line', line => {
      const match = /Listening on (127\.0\.0\.1:\d+)/.exec(line)
      if (match) { clearTimeout(timer); resolve('http://' + match[1]) }
    })
  })
  const c = createTestClient({ mode: 'anvil', chain: baseSepolia, transport: http(url), pollingInterval: 10, cacheTime: 0 }).extend(publicActions).extend(walletActions)
  const [admin, miner, other] = await c.getAddresses()
  let selected = miner, rejectWallet = false, sent = 0
  globalThis.v4TestProvider = { request: async args => {
    if (args.method === 'eth_requestAccounts' && rejectWallet) throw { code: 4001 }
    if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') return [selected]
    if (args.method === 'eth_sendTransaction') sent++
    return c.request(args)
  } }
  async function deploy(name, args) {
    const a = artifacts[name]
    const receipt = await c.waitForTransactionReceipt({ hash: await c.deployContract({ account: admin, abi: a.abi, bytecode: '0x' + a.evm.bytecode.object, args }) })
    assert.equal(receipt.status, 'success')
    return { address: getAddress(receipt.contractAddress), abi: a.abi }
  }
  async function send(contract, functionName, args = []) {
    const hash = await c.writeContract({ ...contract, functionName, args, account: admin })
    assert.equal((await c.waitForTransactionReceipt({ hash })).status, 'success')
  }
  async function at(timestamp) { await c.setNextBlockTimestamp({ timestamp }); await c.mine({ blocks: 1 }) }
  const token = await deploy('TokenCastOpenV4', [admin, admin, launch])
  const registry = await deploy('MineCastNodeRegistryV4', [token.address])
  const staking = await deploy('MineCastOpenStakingV4', [token.address])
  // The timelock's only proposer is the governor deployed three transactions later (as in the real deployment).
  const governorAt = getContractAddress({ from: admin, nonce: BigInt(await c.getTransactionCount({ address: admin }) + 3) })
  const timelock = await deploy('TimelockController', [GOVERNANCE_DELAY, [governorAt], [zeroAddress], zeroAddress])
  const dao = await deploy('MineCastOpenDaoV4', [token.address, staking.address, timelock.address])
  const mining = await deploy('MineCastOpenDistributorV4', [token.address, registry.address, staking.address, dao.address])
  const governor = await deploy('MineCastGovernorV4', [staking.address, timelock.address, registry.address, dao.address, 10, 50])
  assert.equal(governor.address, governorAt)
  const config = { chainId: 84532, token: token.address, distributor: mining.address, registry: registry.address, staking: staking.address, dao: dao.address, governor: governor.address }
  await send(token, 'finalizeDistributor', [mining.address, timelock.address])
  const key = privateKeyToAccount(generatePrivateKey())
  await send(token, 'approve', [registry.address, parseEther('1000000')])
  await send(registry, 'registerNode', [key.address, parseEther('1000000')])
  await at(launch - 6n * DAY); await send(registry, 'activateNode', [key.address])
  const network = () => readApp.readV4Network(c, config, miner)
  async function action(input, expected = 'confirmed', who = miner) {
    const updates = [], pending = []
    await executeV4Action(c, config, who, input, x => updates.push(x), x => pending.push(x))
    assert.equal(updates.at(-1).status, expected, updates.at(-1).message)
    return { updates, pending }
  }
  async function startSession(day, inviter) {
    await at(launch + day * DAY + 100n)
    await action({ kind: 'startMining', fid: 42n, castHash: toHex(day + 1n, { size: 20 }), inviter })
  }
  async function publish(day) {
    const [, castHash, invites, startedAt, level] = await c.readContract({ ...mining, functionName: 'sessions', args: [day, miner] })
    const bundle = buildOpenReport({ chainId: 84532, distributor: mining.address, day, launchTime: launch,
      sourceHash: await c.readContract({ ...mining, functionName: 'sessionsHash', args: [day] }),
      entries: [{ fid: 42n, wallet: miner, followers: 100000n, engagement: 100n, nodeWork: false, castHash, startedAt, level, invites }] }) // x10 followers x10 engagement: 1% under the floor
    const close = launch + (day + 1n) * DAY
    if ((await c.getBlock()).timestamp < close) await at(close) // phase 1 at the 00:00 UTC close: the node commits
    await c.setBalance({ address: key.address, value: parseEther('1') })
    const digest = openDigest(84532, mining.address, bundle.report), salt = keccak256(key.address)
    await c.waitForTransactionReceipt({ hash: await c.writeContract({ ...mining, functionName: 'commitReport', account: key,
      args: [day, commitmentOf(digest, key.address, salt)] }) })
    await at(close + 1800n) // phase 2 after the 30-minute commit phase: reveal, then sign
    await c.waitForTransactionReceipt({ hash: await c.writeContract({ ...mining, functionName: 'revealCommitment', account: key, args: [day, digest, salt] }) })
    await send(mining, 'submitSignatures', [bundle.report, [key.address], [await key.signTypedData(typedReport(84532, mining.address, bundle.report))]])
    await send(mining, 'publishAllocations', [day, bundle.entries, bundle.proofs])
    const n = await network(), d = await readApp.readV4Day(c, config, n, day, miner)
    assert.equal(miningPhase(d, n.timestamp), 'review')
    await at((await c.getBlock()).timestamp + 3600n) // 1-hour review
    await action({ kind: 'activateDay', day })
    return bundle
  }

  await t.test('network identity, immutable bindings and premine are read from Base', async () => {
    const n = await network()
    assert.equal(n.totalSupply, parseEther('2100000')); assert.equal(n.maxSupply, parseEther('21000000000'))
    assert.equal(n.balance, 0n); assert.equal(n.totalBond, parseEther('1000000'))
    await assert.rejects(readApp.verifyV4(c, { ...config, chainId: 8453 }), /network/)
    await assert.rejects(readApp.verifyV4(c, { ...config, dao: other }), /links|returned no data/)
  })
  await t.test('wallet cancellation and account mismatch send no transaction', async () => {
    selected = other; await action({ kind: 'revokeApproval' }, 'error')
    selected = miner; rejectWallet = true; await action({ kind: 'revokeApproval' }, 'idle'); rejectWallet = false
    assert.equal(sent, 0)
  })
  const inviter = getAddress('0x' + 'a'.repeat(40))
  await startSession(0n, inviter)
  assert.equal((await network()).inviter, inviter) // an invite link is recorded with the session
  const first = await publish(0n)
  assert.equal(await c.readContract({ ...mining, functionName: 'inviteCount', args: [inviter] }), 1n) // 100+ followers and engagement: counts
  await t.test('claim receipt and balance agree; repeated claim never reports success', async () => {
    let n = await network(), d = await readApp.readV4Day(c, config, n, 0n, miner)
    assert.equal(miningPhase(d, n.timestamp), 'claimable'); assert.equal(d.amount, first.amounts[0])
    assert.deepEqual(await readApp.claimableDays(c, config, n, miner), [0n])
    const r = await action({ kind: 'claim', day: 0n })
    assert.ok(r.pending.some(x => x?.hash)); assert.equal(r.pending.at(-1), null)
    n = await network(); d = await readApp.readV4Day(c, config, n, 0n, miner)
    assert.equal(n.balance, first.amounts[0]); assert.equal(miningPhase(d, n.timestamp), 'claimed')
    await action({ kind: 'claim', day: 0n }, 'error')
  })
  const amount = parseEther('400000') // also covers a third of the February mining for the March airdrop
  await t.test('stake uses exact approval, total staked and 30-day lock; withdraw cannot bypass it', async () => {
    const r = await action({ kind: 'stake', amount })
    assert.equal(r.updates.filter(x => x.status === 'confirmed').length, 2)
    const n = await network(), s = await readApp.readV4Stake(c, config, n, 0n, miner)
    assert.equal(s.balance, amount); assert.equal(n.totalStaked, amount); assert.equal(s.votingPower, 0n) // votes only once 30 days old
    assert.ok(s.lockedUntil > n.timestamp)
    assert.equal(await c.readContract({ ...token, functionName: 'allowance', args: [miner, staking.address] }), 0n)
    await action({ kind: 'withdraw', amount }, 'error')
  })
  await at(launch + 36n * DAY) // the stake is now over 30 days old and votes without activation
  // A February cohort to airdrop on in March; reported before the February ledger closes.
  // The next cohort's session opens at 00:00 UTC while day 40 still waits for its report; claiming comes later.
  await startSession(40n); await startSession(41n); await publish(40n)
  await t.test('earlier rewards are claimed together while a later session is open', async () => {
    const n = await network()
    assert.deepEqual(await readApp.claimableDays(c, config, n, miner), [40n])
    await action({ kind: 'claimMany', days: [40n] })
    assert.deepEqual(await readApp.claimableDays(c, config, await network(), miner), [])
  })
  await t.test('monthly snapshot voting and burn use matured stake without backend signatures', async () => {
    await at(monthStart(203002n) + 16n * DAY + 100n)
    let n = await network(), d = await readApp.readV4Dao(c, config, n, 203002n, miner)
    assert.equal(d.canFinalizeMonth, true)
    await action({ kind: 'finalizeMonth', timestamp: monthStart(203002n) })
    d = await readApp.readV4Dao(c, config, await network(), 203002n, miner); assert.equal(d.canOpen, true)
    await action({ kind: 'openVote' })
    d = await readApp.readV4Dao(c, config, await network(), 203002n, miner)
    assert.equal(d.power, amount); assert.equal(d.airdrop, false)
    await action({ kind: 'vote', month: 203002n, yes: true })
    d = await readApp.readV4Dao(c, config, await network(), 203002n, miner)
    assert.equal(d.voted, true); assert.equal(d.yes, amount)
    await action({ kind: 'vote', month: 203002n, yes: false }, 'error')
  })
  await at(monthStart(203002n) + 26n * DAY + 200n)
  const beforeBurn = (await network()).totalSupply
  await action({ kind: 'settleVote', month: 203002n })
  assert.ok((await network()).totalSupply < beforeBurn)
  await t.test('fixed staking epochs can finalize and pay a real reward', async () => {
    await at(launch + 61n * DAY)
    await action({ kind: 'finalizeEpoch', epoch: 0n }); await action({ kind: 'finalizeEpoch', epoch: 1n })
    const n = await network(), s = await readApp.readV4Stake(c, config, n, 1n, miner)
    assert.ok(s.claimable > 0n)
    await action({ kind: 'claimStake', epoch: 1n })
    assert.equal((await network()).balance, n.balance + s.claimable)
    assert.equal((await readApp.readV4Stake(c, config, await network(), 1n, miner)).claimable, 0n)
  })
  await t.test('odd-month vote executes airdrop to prior-month miners, with receipt-backed UI', async () => {
    await at(monthStart(203003n) + 16n * DAY + 100n)
    await action({ kind: 'finalizeMonth', timestamp: monthStart(203003n) }); await action({ kind: 'openVote' })
    await action({ kind: 'vote', month: 203003n, yes: true })
    let d = await readApp.readV4Dao(c, config, await network(), 203003n, miner)
    assert.equal(d.airdrop, true); assert.equal(d.claimable, 0n)
    await at(d.voteEnd + 3n * DAY); await action({ kind: 'settleVote', month: 203003n })
    const n = await network(); d = await readApp.readV4Dao(c, config, n, 203003n, miner)
    assert.ok(d.claimable > 0n)
    await action({ kind: 'claimAirdrop', month: 203003n })
    assert.equal((await network()).balance, n.balance + d.claimable)
    assert.equal((await readApp.readV4Dao(c, config, await network(), 203003n, miner)).collected, true)
  })
  await t.test('stake governance: a node operator proposes a treasury spend, stakers vote, anyone queues and executes', async () => {
    let g = await readApp.readV4Governance(c, config, await network(), admin)
    assert.equal(g.proposals.length, 0); assert.equal(g.nodeKey, key.address); assert.ok(g.treasury.capRemaining > 0n)
    await assert.rejects(readApp.readV4Governance(c, { ...config, dao: staking.address }, await network(), admin))
    const grant = parseEther('1000'), description = 'Fund a community dashboard\nPaid in one transfer, reported in the channel.'
    const calldatas = [encodeFunctionData({ abi: appABI.daoAbi, functionName: 'spend', args: [other, grant, launch + 400n * DAY] })]
    selected = admin
    await action({ kind: 'propose', targets: [dao.address], values: [0n], calldatas, description }, 'error', admin) // 400k-stake rule, no node path
    await action({ kind: 'propose', targets: [dao.address], values: [0n], calldatas, description, nodeKey: key.address }, 'confirmed', admin)
    selected = miner
    g = await readApp.readV4Governance(c, config, await network(), miner)
    let [p] = g.proposals
    assert.equal(p.state, 'Pending'); assert.equal(p.description, description); assert.equal(p.supermajority, false)
    assert.deepEqual(p.actions, [{ kind: 'spend', to: other, amount: grant }])
    await at((await c.getBlock()).timestamp + 11n) // test Governor: 10 s delay, 50 s voting (timestamp clock)
    p = (await readApp.readV4Governance(c, config, await network(), miner)).proposals[0]
    assert.equal(p.state, 'Active'); assert.equal(p.power, amount)
    await action({ kind: 'castVote', proposalId: p.id, support: 1 })
    await action({ kind: 'castVote', proposalId: p.id, support: 0 }, 'error')
    p = (await readApp.readV4Governance(c, config, await network(), miner)).proposals[0]
    assert.equal(p.voted, true); assert.equal(p.forVotes, amount)
    await at((await c.getBlock()).timestamp + 51n)
    p = (await readApp.readV4Governance(c, config, await network(), miner)).proposals[0]
    assert.equal(p.state, 'Succeeded')
    const calls = { targets: p.targets, values: p.values, calldatas: p.calldatas, descriptionHash: p.descriptionHash }
    await action({ kind: 'queueProposal', ...calls })
    p = (await readApp.readV4Governance(c, config, await network(), miner)).proposals[0]
    assert.equal(p.state, 'Queued')
    await action({ kind: 'executeProposal', ...calls }, 'error') // still in the 14-day timelock
    await at(p.eta)
    const before = await c.readContract({ ...token, functionName: 'balanceOf', args: [other] })
    await action({ kind: 'executeProposal', ...calls })
    assert.equal(await c.readContract({ ...token, functionName: 'balanceOf', args: [other] }), before + grant)
    const capBefore = g.treasury.capRemaining
    g = await readApp.readV4Governance(c, config, await network(), miner)
    assert.equal(g.proposals[0].state, 'Executed')
    assert.ok(g.treasury.capRemaining < capBefore) // the spend used part of the refilling 5% credit
    await action({ kind: 'withdraw', amount })
    assert.equal((await network()).totalStaked, 0n)
  })
  if (process.env.V4_BROWSER_CHECK === '1') await t.test('mobile and desktop V4 views use real chain data without overflow', () => checkBrowser(config, url, miner, t))
})
