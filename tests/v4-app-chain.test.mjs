import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createTestClient, http, publicActions, walletActions, parseEther, keccak256, toHex, getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { compileOpen } from '../research/v4/compile-open.mjs'
import { buildOpenReport, typedReport } from '../research/v4/open-report.mjs'
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
  // Governance is not exercised by the miniapp here; any contract stands in for the timelock.
  const dao = await deploy('MineCastOpenDaoV4', [token.address, staking.address, staking.address])
  const mining = await deploy('MineCastOpenDistributorV4', [token.address, registry.address, staking.address, dao.address])
  const config = { chainId: 84532, token: token.address, distributor: mining.address, registry: registry.address, staking: staking.address, dao: dao.address }
  await send(token, 'finalizeDistributor', [mining.address, staking.address])
  const key = privateKeyToAccount(generatePrivateKey())
  await send(token, 'approve', [registry.address, parseEther('1000000')])
  await send(registry, 'registerNode', [key.address, parseEther('1000000')])
  await at(launch - 6n * DAY); await send(registry, 'activateNode', [key.address])
  const network = () => readApp.readV4Network(c, config, miner)
  async function action(input, expected = 'confirmed') {
    const updates = [], pending = []
    await executeV4Action(c, config, miner, input, x => updates.push(x), x => pending.push(x))
    assert.equal(updates.at(-1).status, expected, updates.at(-1).message)
    return { updates, pending }
  }
  async function startSession(day) {
    await at(launch + day * DAY + 100n)
    await action({ kind: 'startMining', fid: 42n, castHash: toHex(day + 1n, { size: 20 }) })
  }
  async function publish(day) {
    const [, castHash, startedAt, level] = await c.readContract({ ...mining, functionName: 'sessions', args: [day, miner] })
    const bundle = buildOpenReport({ chainId: 84532, distributor: mining.address, day, launchTime: launch,
      sourceHash: await c.readContract({ ...mining, functionName: 'sessionsHash', args: [day] }),
      entries: [{ fid: 42n, wallet: miner, followers: 2000n, nodeWork: false, castHash, startedAt, level }] })
    await at(launch + (day + 2n) * DAY + 6n * 3600n)
    await send(mining, 'submitSignatures', [bundle.report, [key.address], [await key.signTypedData(typedReport(84532, mining.address, bundle.report))]])
    await send(mining, 'publishAllocations', [day, bundle.entries, bundle.proofs])
    const n = await network(), d = await readApp.readV4Day(c, config, n, day, miner)
    assert.equal(miningPhase(d, n.timestamp), 'review')
    await at((await c.getBlock()).timestamp + 2n * DAY)
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
    selected = other; await action({ kind: 'activatePower' }, 'error')
    selected = miner; rejectWallet = true; await action({ kind: 'activatePower' }, 'idle'); rejectWallet = false
    assert.equal(sent, 0)
  })
  await startSession(0n)
  const first = await publish(0n)
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
  const amount = parseEther('1000')
  await t.test('stake uses exact approval, total staked and 30-day lock; withdraw cannot bypass it', async () => {
    const r = await action({ kind: 'stake', amount })
    assert.equal(r.updates.filter(x => x.status === 'confirmed').length, 2)
    const n = await network(), s = await readApp.readV4Stake(c, config, n, 0n, miner)
    assert.equal(s.balance, amount); assert.equal(n.totalStaked, amount); assert.equal(s.activePower, 0n)
    assert.ok(s.lockedUntil > n.timestamp)
    assert.equal(await c.readContract({ ...token, functionName: 'allowance', args: [miner, staking.address] }), 0n)
    await action({ kind: 'withdraw', amount }, 'error'); await action({ kind: 'activatePower' }, 'error')
  })
  await at(launch + 36n * DAY); await action({ kind: 'activatePower' })
  // A February cohort to airdrop on in March; reported before the February ledger closes.
  await startSession(40n); await publish(40n); await action({ kind: 'claim', day: 40n })
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
    await action({ kind: 'withdraw', amount })
    assert.equal((await network()).totalStaked, 0n)
  })
  if (process.env.V4_BROWSER_CHECK === '1') await t.test('mobile and desktop V4 views use real chain data without overflow', () => checkBrowser(config, url, miner, t))
})
