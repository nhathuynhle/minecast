import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestClient, http, publicActions, walletActions, parseEther, keccak256, toHex, zeroAddress, getAddress, getContractAddress, encodeFunctionData } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { compileOpen } from './compile-open.mjs'
import { prepareDeployment, GOVERNANCE_DELAY } from './prepare-open-deployment.mjs'
import { verifyDeployment } from './verify-open-deployment.mjs'
import { buildOpenReport, openDigest, typedReport, weightOf } from './open-report.mjs'
import { miningPoolForDay, lifetimeCeilingAfterDays, MAX_SUPPLY, DEV_PREMINE } from './node/bootstrap-model.mjs'
import { processDay } from './node/open-worker.mjs'

const DAY = 86400n, HOUR = 3600n, launch = 1893456000n, unit = parseEther('1'), minBond = parseEther('1000000')
const hash = text => keccak256(toHex(text))
async function startChain(t) {
  const child = spawn(process.env.ANVIL_BIN || 'anvil', ['--host', '127.0.0.1', '--port', '0',
    '--timestamp', String(launch - 14n * DAY), '--hardfork', 'cancun'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => child.kill())
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Anvil startup timed out')) }, 15000)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', code => { clearTimeout(timer); reject(Error('Anvil exited: ' + code)) })
    createInterface({ input: child.stdout }).on('line', line => {
      const match = /Listening on (127\.0\.0\.1:\d+)/.exec(line)
      if (match) { clearTimeout(timer); resolve('http://' + match[1]) }
    })
  })
  return createTestClient({ chain: foundry, mode: 'anvil', transport: http(url), pollingInterval: 10,
    cacheTime: 0 }).extend(publicActions).extend(walletActions)
}

test('Open V4: real stake quorum, full allocation publication, staking and DAO', async t => {
  const artifacts = Object.assign({}, ...Object.values(compileOpen().contracts))
  const c = await startChain(t)
  const [admin, alice, bob, carol, outsider] = await c.getAddresses()
  const keys = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()))
  const read = (contract, functionName, args = []) => c.readContract({ ...contract, functionName, args })
  const same = (a, b) => assert.equal(String(a).toLowerCase(), String(b).toLowerCase())
  async function deploy(name, args) {
    const a = artifacts[name]
    const tx = await c.deployContract({ account: admin, abi: a.abi, bytecode: '0x' + a.evm.bytecode.object, args })
    const r = await c.waitForTransactionReceipt({ hash: tx }); assert.equal(r.status, 'success', name)
    return { address: r.contractAddress, abi: a.abi }
  }
  async function send(contract, functionName, args = [], account = admin) {
    const request = { ...contract, functionName, args, account }
    const gas = await c.estimateContractGas(request)
    const tx = await c.writeContract({ ...request, gas: gas + gas / 5n + 10000n })
    const r = await c.waitForTransactionReceipt({ hash: tx })
    assert.equal(r.status, 'success', functionName)
    return r
  }
  async function denied(contract, functionName, args = [], account = outsider, error) {
    await assert.rejects(c.simulateContract({ ...contract, functionName, args, account }), e => {
      if (error) assert.match(e.message, new RegExp(error)); return true
    })
  }
  async function at(timestamp) { await c.setNextBlockTimestamp({ timestamp }); await c.mine({ blocks: 1 }) }
  const now = async () => (await c.getBlock()).timestamp
  const token = await deploy('TokenCastOpenV4', [admin, admin, launch])
  const registry = await deploy('MineCastNodeRegistryV4', [token.address])
  const staking = await deploy('MineCastOpenStakingV4', [token.address])
  // The timelock's only proposer is the governor deployed three transactions later.
  const governorAt = getContractAddress({ from: admin, nonce: BigInt(await c.getTransactionCount({ address: admin }) + 3) })
  const timelock = await deploy('TimelockController', [GOVERNANCE_DELAY, [governorAt], [zeroAddress], zeroAddress])
  const dao = await deploy('MineCastOpenDaoV4', [token.address, staking.address, timelock.address])
  const mining = await deploy('MineCastOpenDistributorV4', [token.address, registry.address, staking.address, dao.address])
  const governor = await deploy('MineCastGovernorV4', [staking.address, timelock.address, registry.address, 10, 50])
  same(governor.address, governorAt)
  await send(token, 'finalizeDistributor', [mining.address, timelock.address])
  async function bond(key, who = admin, amount = minBond) {
    await send(token, 'approve', [registry.address, amount], who)
    await send(registry, 'registerNode', [key.address, amount], who)
  }
  await bond(keys[0])
  await denied(registry, 'activateNode', [keys[0].address], admin, 'InvalidPhase')
  await at(launch - 6n * DAY)
  await send(registry, 'activateNode', [keys[0].address], outsider)
  let checkpoint = await c.snapshot()
  async function scenario(name, fn) {
    await t.test(name, async () => {
      await c.revert({ id: checkpoint }); checkpoint = await c.snapshot()
      await fn()
    })
  }
  const castOf = (fid, day) => toHex(BigInt(fid) + day * 1000000n, { size: 20 })
  // Miners open their sessions onchain; entries carry the exact recorded start time and cast.
  async function mineDay(day = 0n, specs = [[1, alice], [2, bob]]) {
    const start = launch + day * DAY + 100n
    if (await now() >= start - 100n + DAY) throw Error('mineDay ' + day + ' is already over')
    if (await now() < start) await at(start)
    const entries = []
    for (const [fid, wallet, followers = 2000n, nodeKey = zeroAddress, castHash = castOf(fid, day)] of specs) {
      const last = await read(mining, 'lastSessionStart', [wallet])
      if (last !== 0n && await now() < last + DAY) await at(last + DAY)
      await send(mining, 'startMining', [BigInt(fid), castHash], wallet)
      const [, , startedAt, level] = await read(mining, 'sessions', [day, wallet])
      entries.push({ fid: BigInt(fid), wallet, followers, nodeWork: nodeKey !== zeroAddress, castHash, startedAt, nodeKey, level })
    }
    return entries
  }
  async function report(day = 0n, entries, sourceHash) {
    entries ??= await mineDay(day)
    sourceHash ??= await read(mining, 'sessionsHash', [day])
    return buildOpenReport({ chainId: 31337, distributor: mining.address, launchTime: launch, day, entries, sourceHash })
  }
  const sig = (key, r, chainId = 31337, distributor = mining.address) => key.signTypedData(typedReport(chainId, distributor, r))
  async function submit(bundle, signers = [keys[0]]) {
    return send(mining, 'submitSignatures', [bundle.report, signers.map(k => k.address),
      await Promise.all(signers.map(k => sig(k, bundle.report)))], outsider)
  }
  async function activate(bundle, signers = [keys[0]]) {
    const open = launch + (bundle.report.day + 2n) * DAY + 6n * HOUR
    if (await now() < open) await at(open)
    await submit(bundle, signers)
    for (let i = 0; i < bundle.entries.length; i += 100) {
      await send(mining, 'publishAllocations', [bundle.report.day, bundle.entries.slice(i, i + 100), bundle.proofs.slice(i, i + 100)], outsider)
    }
    await at(await now() + 2n * DAY)
    await send(mining, 'activateDay', [bundle.report.day], outsider)
  }
  async function initialClaims(r) {
    r ??= await report(); await activate(r)
    await send(mining, 'claim', [r.report.day], alice); await send(mining, 'claim', [r.report.day], bob)
    return r
  }

  await scenario('immutable lifetime/day caps and 2.1M premine match integer model', async () => {
    assert.equal(await read(token, 'totalSupply'), DEV_PREMINE)
    assert.equal(await read(token, 'bootstrapAdmin'), zeroAddress)
    assert.equal(await read(token, 'MAX_SUPPLY'), MAX_SUPPLY)
    await denied(token, 'finalizeDistributor', [mining.address, timelock.address], admin, 'AlreadyFinalized')
    await denied(token, 'scheduleDistributor', [mining.address, 31n], admin, 'Unauthorized')
    same(await read(token, 'distributor'), mining.address); same(await read(token, 'governance'), timelock.address)
    await denied(token, 'issue', [0n, alice, 1n], admin, 'Unauthorized')
    for (const d of [0n, 1n, 29n, 138n, 365n, 919n, 3650n, 12000n, 2n ** 256n - 1n]) {
      assert.equal(await read(token, 'dailyEmissionForDay', [d]), miningPoolForDay(d))
      assert.equal(await read(token, 'releasedSupplyAfterDays', [d]), lifetimeCeilingAfterDays(d))
    }
    await send(token, 'burn', [unit])
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
  })

  await scenario('unsigned deployment plan executes with exact addresses; read-only verifier rejects mismatches', async () => {
    const bundled = Object.fromEntries(Object.entries(artifacts).map(([name, a]) => [name, {
      abi: a.abi, bytecode: '0x' + a.evm.bytecode.object, runtimeTemplate: '0x' + a.evm.deployedBytecode.object,
      immutableReferences: a.evm.deployedBytecode.immutableReferences,
    }]))
    const config = { chainId: 31337, deployer: admin, devWallet: alice,
      launchTime: Number((await now() / DAY + 15n) * DAY), pendingNonce: await c.getTransactionCount({ address: admin, blockTag: 'pending' }) }
    const currentTime = Number(await now())
    assert.throws(() => prepareDeployment({ ...config, devWallet: zeroAddress }, bundled, currentTime), /nonzero/)
    assert.throws(() => prepareDeployment({ ...config, launchTime: currentTime + 86400 }, bundled, currentTime), /8 days/)
    assert.throws(() => prepareDeployment({ ...config, launchTime: config.launchTime + 3600 }, bundled, currentTime), /00:00 UTC/)
    const plan = prepareDeployment(config, bundled, currentTime)
    for (const tx of plan.transactions) {
      const request = { account: admin, to: tx.to, data: tx.data, value: 0n, nonce: tx.nonce }
      const gas = await c.estimateGas(request)
      const hash = await c.sendTransaction({ ...request, gas: gas + gas / 5n })
      const receipt = await c.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success')
      if (tx.expectedAddress) assert.equal(receipt.contractAddress.toLowerCase(), tx.expectedAddress.toLowerCase())
    }
    const verified = await verifyDeployment(c, plan, bundled)
    assert.equal(verified.runtimeAndBindingsMatch, true); assert.equal(verified.enoughActiveBond, false)
    await assert.rejects(verifyDeployment(c, { ...plan, chainId: 8453 }, bundled), /chain ID/)
    await assert.rejects(verifyDeployment(c, { ...plan, devWallet: bob }, bundled), /dev wallet/)
    await assert.rejects(verifyDeployment(c, { ...plan, addresses: { ...plan.addresses, MineCastOpenDistributorV4: token.address } }, bundled), /runtime/)
    await assert.rejects(verifyDeployment(c, { ...plan, governanceDelay: 1n }, bundled), /timelock delay/)
  })

  await scenario('boost boundary differential fuzz: 2k+node=50, base maximum=100, burn level L adds 0.2L beyond it', async () => {
    let seed = 7n
    const counts = [0n, 9n, 10n, 499n, 500n, 999n, 1000n, 1999n, 2000n, 4999n, 5000n, 9999n, 10000n, 25000n, 50000n, 100000n]
    for (let i = 0; i < 64; i++) { seed = (seed * 1664525n + 1013904223n) % 2n ** 32n; counts.push(seed % 200000n) }
    for (const followers of counts) for (const nodeWork of [false, true]) for (const level of [0, 1, 9]) {
      assert.equal(await read(mining, 'miningWeight', [followers, nodeWork, BigInt(level)]), weightOf({ followers, nodeWork, level }))
    }
    assert.equal(await read(mining, 'miningWeight', [2000n, true, 0n]), 250n) // weights are in fifths: x50
    assert.equal(await read(mining, 'miningWeight', [100000n, true, 9n]), 1400n) // x100 base, x2.8 boost
  })

  await scenario('bond admission, key uniqueness, delayed activation, escrow ownership', async () => {
    await denied(registry, 'registerNode', [keys[1].address, minBond - 1n], admin, 'InvalidNode')
    await denied(registry, 'registerNode', [keys[0].address, minBond], admin, 'InvalidNode')
    await denied(registry, 'requestExit', [keys[0].address], alice, 'Unauthorized')
    await bond(keys[1]); await denied(registry, 'activateNode', [keys[1].address], admin, 'InvalidPhase')
    await at(launch + 2n * DAY); await send(registry, 'activateNode', [keys[1].address])
    assert.equal(await read(registry, 'totalWeightAt', [2n]), minBond)
    assert.equal(await read(registry, 'totalWeightAt', [3n]), 2n * minBond)
    assert.equal(await read(registry, 'totalEscrowed'), 2n * minBond)
    assert.equal(await read(token, 'balanceOf', [registry.address]), 2n * minBond)
    assert.deepEqual(await read(registry, 'keysOf', [admin]), [keys[0].address, keys[1].address])
  })

  await scenario('sessions are opened onchain: one per wallet per 24h, reports bound to the exact list', async () => {
    await denied(mining, 'startMining', [1n, castOf(1, 0n)], alice, 'InvalidSession')
    const [a] = await mineDay(0n, [[1, alice]])
    await denied(mining, 'startMining', [5n, castOf(5, 0n)], alice, 'InvalidSession')
    await denied(mining, 'startMining', [0n, castOf(9, 0n)], bob, 'InvalidSession')
    await denied(mining, 'startMining', [9n, toHex(0n, { size: 20 })], bob, 'InvalidSession')
    assert.equal(await read(mining, 'sessionCount', [0n]), 1n); same(await read(mining, 'sessionWallet', [0n, 0n]), alice)
    await at(a.startedAt + DAY - 1n); await denied(mining, 'startMining', [1n, castOf(1, 1n)], alice, 'InvalidSession')
    await at(a.startedAt + DAY); await send(mining, 'startMining', [1n, castOf(1, 1n)], alice)
    const fake = { ...a, fid: 2n, wallet: carol, castHash: castOf(2, 0n) } // no onchain session behind it
    const bad = await report(0n, [a], hash('not the session list')), r = await report(0n, [a, fake])
    await at(launch + 2n * DAY + 6n * HOUR)
    await assert.rejects(submit(bad), /InvalidReport/)
    await submit(r)
    await send(mining, 'publishAllocations', [0n, [r.entries[0]], [r.proofs[0]]])
    await denied(mining, 'publishAllocations', [0n, [r.entries[1]], [r.proofs[1]]], outsider, 'InvalidAllocation')
  })

  await scenario('one-node bootstrap, EIP712 replay protection, duplicates and early results', async () => {
    const r = await report()
    assert.equal(openDigest(31337, mining.address, r.report), await read(mining, 'reportDigest', [r.report]))
    await denied(mining, 'submitSignatures', [r.report, [keys[0].address], [await sig(keys[0], r.report)]], admin, 'InvalidPhase')
    await at(launch + 2n * DAY + 6n * HOUR)
    for (const [chain, address] of [[8453, mining.address], [31337, token.address]]) {
      await denied(mining, 'submitSignatures', [r.report, [keys[0].address], [await sig(keys[0], r.report, chain, address)]], admin, 'InvalidSignature')
    }
    await submit(r)
    const certificate = await read(mining, 'certificate', [openDigest(31337, mining.address, r.report)])
    assert.equal(certificate[0], minBond); assert.ok(certificate[1] > 0n)
    await assert.rejects(submit(r), /DuplicateSigner/)
    await denied(mining, 'activateDay', [0n], admin, 'InvalidPhase')
  })

  await scenario('full onchain publication is mandatory; claims need no downloaded proof', async () => {
    const r = await report(); await at(launch + 2n * DAY + 6n * HOUR); await submit(r)
    await send(mining, 'publishAllocations', [0n, [r.entries[0]], [r.proofs[0]]])
    await at(await now() + 2n * DAY)
    await denied(mining, 'activateDay', [0n], admin, 'InvalidPhase')
    await send(mining, 'publishAllocations', [0n, [r.entries[1]], [r.proofs[1]]])
    await send(mining, 'activateDay', [0n])
    const before = await read(token, 'balanceOf', [alice])
    await send(mining, 'claim', [0n], alice)
    assert.equal(await read(token, 'balanceOf', [alice]), before + r.amounts[0])
    await denied(mining, 'claim', [0n], alice, 'InvalidPhase')
    await denied(mining, 'claim', [0n], outsider, 'InvalidPhase')
    assert.equal(await read(mining, 'claimedByMonth', [203001n, alice]), r.amounts[0])
  })

  await scenario('worker signs once from its journal, then relays, publishes and activates', async () => {
    const input = { day: 0n, launchTime: launch, entries: await mineDay(0n), sourceHash: await read(mining, 'sessionsHash', [0n]) }
    const ctx = { client: c, account: keys[0], distributor: mining.address,
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'minecast-journal-')), collect: async () => input }
    await c.setBalance({ address: keys[0].address, value: parseEther('10') })
    await at(launch + 2n * DAY + 6n * HOUR - 1n)
    assert.match(await processDay(ctx, 0n, launch, await now()), /not signing/)
    await at(launch + 2n * DAY + 6n * HOUR)
    const wrongBuild = { ...ctx, client: { ...c, chain: { ...c.chain, id: 8453 } } } // digest the distributor would reject
    await assert.rejects(processDay(wrongBuild, 0n, launch, await now()), /does not match the deployed TokenCast V4/)
    assert.deepEqual(fs.readdirSync(ctx.dir), [])
    assert.equal(await processDay(ctx, 0n, launch, await now()), 'waiting for review')
    assert.equal((await read(mining, 'dayInfo', [0n])).published, 2n)
    ctx.collect = async () => { throw Error('a signed day must come from the journal, never be re-collected') }
    await at(await now() + 2n * DAY)
    assert.equal(await processDay(ctx, 0n, launch, await now()), 'activated')
    assert.equal(await processDay(ctx, 0n, launch, await now()), 'claims open')
    await send(mining, 'claim', [0n], alice)
  })

  await scenario('tampered social fields or allocation totals cannot pass committed onchain formula', async () => {
    const r = await report(); r.report.allocated += 1n
    await at(launch + 2n * DAY + 6n * HOUR); await submit(r)
    await denied(mining, 'publishAllocations', [0n, [{ ...r.entries[0], followers: 0n }], [r.proofs[0]]], admin, 'InvalidAllocation')
    await denied(mining, 'publishAllocations', [0n, [{ ...r.entries[0], wallet: carol }], [r.proofs[0]]], admin, 'InvalidAllocation')
    await denied(mining, 'publishAllocations', [0n, [{ ...r.entries[0], startedAt: r.entries[0].startedAt + 1n }], [r.proofs[0]]], admin, 'InvalidAllocation')
    await denied(mining, 'publishAllocations', [0n, [{ ...r.entries[0], nodeWork: true, nodeKey: keys[0].address }], [r.proofs[0]]], admin, 'InvalidAllocation')
    await send(mining, 'publishAllocations', [0n, r.entries, r.proofs])
    await at(await now() + 2n * DAY)
    await denied(mining, 'activateDay', [0n], admin, 'InvalidPhase')
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
  })

  await scenario('cap excess goes 5/95; unclaimed allocations never go to treasury', async () => {
    const r = await report(); await activate(r)
    const pool = miningPoolForDay(0), surplus = pool - r.report.allocated
    assert.equal(r.amounts[0], pool / 100n)
    assert.equal(await read(staking, 'scheduledRewards', [1n]), surplus * 5n / 100n)
    assert.equal(await read(token, 'balanceOf', [dao.address]), surplus - surplus * 5n / 100n)
    const minted = await read(token, 'cumulativeMinted')
    const day = await read(mining, 'dayInfo', [0n])
    await at(day.claimEnd)
    await denied(mining, 'claim', [0n], alice, 'InvalidPhase')
    await denied(mining, 'activateDay', [0n], admin, 'InvalidPhase')
    assert.equal(await read(token, 'cumulativeMinted'), minted)
    assert.equal(await read(token, 'mintedForDay', [0n]), surplus)
  })

  await scenario('empty day can release surplus only with quorum and review', async () => {
    const r = await report(0n, []); await activate(r)
    assert.equal(await read(token, 'mintedForDay', [0n]), miningPoolForDay(0))
    await denied(mining, 'claim', [0n], admin, 'InvalidPhase')
  })

  await scenario('expired result window prevents late minting or backfilled certificates', async () => {
    const r = await report(); await at(launch + 7n * DAY)
    await assert.rejects(submit(r), /InvalidPhase/)
    await denied(mining, 'publishAllocations', [0n, r.entries, r.proofs], admin, 'InvalidPhase')
  })

  await scenario('strict >2/3 of all stake: offline founder cannot be ignored', async () => {
    await initialClaims()
    await bond(keys[1], alice); await bond(keys[2], bob)
    await at(launch + 12n * DAY)
    await send(registry, 'activateNode', [keys[1].address]); await send(registry, 'activateNode', [keys[2].address])
    const day = 13n, r = await report(day)
    await at(launch + (day + 2n) * DAY + 6n * HOUR)
    await submit(r, [keys[1], keys[2]])
    const digest = openDigest(31337, mining.address, r.report)
    assert.deepEqual(await read(mining, 'certificate', [digest]), [2n * minBond, 0n])
    await submit(r, [keys[0]])
    assert.ok((await read(mining, 'certificate', [digest]))[1] > 0n)
    // Founder voluntarily exits: the other two alone can certify future days.
    await send(registry, 'requestExit', [keys[0].address])
    const n = await read(registry, 'nodes', [keys[0].address]), future = n[3]
    const next = await report(future)
    await at(launch + (future + 2n) * DAY + 6n * HOUR); await submit(next, [keys[1], keys[2]])
    assert.ok((await read(mining, 'certificate', [openDigest(31337, mining.address, next.report)]))[1] > 0n)
  })

  await scenario('conflicting quorum blocks activation; double-sign evidence burns actual bond', async () => {
    const a = await report(), b = await report(0n, [a.entries[0]])
    await at(launch + 2n * DAY + 6n * HOUR); await submit(a); await submit(b)
    assert.equal((await read(mining, 'dayInfo', [0n])).contested, true)
    await denied(mining, 'publishAllocations', [0n, a.entries, a.proofs], admin, 'InvalidPhase')
    await denied(registry, 'slashEquivocation', [keys[0].address, 0n], outsider, 'Unauthorized')
    const before = await read(token, 'totalSupply')
    await send(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider)
    assert.equal(await read(token, 'totalSupply'), before - minBond)
    assert.equal(await read(registry, 'totalEscrowed'), 0n)
    assert.equal(await read(registry, 'totalWeightAt', [0n]), minBond)
    assert.equal(await read(registry, 'totalWeightAt', [3n]), 0n)
    await denied(registry, 'withdrawNode', [keys[0].address], admin, 'InvalidPhase')
    await denied(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider, 'InvalidPhase')
  })

  await scenario('false equivocation accusations cannot confiscate escrow', async () => {
    const a = await report(), b = await report(1n)
    await at(launch + 3n * DAY)
    await denied(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), a.report, await sig(keys[0], a.report)], outsider, 'InvalidEvidence')
    await denied(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider, 'InvalidEvidence')
    assert.equal(await read(registry, 'totalEscrowed'), minBond)
  })

  await scenario('evidence invalidates a certificate even without a second submitted quorum', async () => {
    const a = await report(), b = await report(0n, [a.entries[0]])
    await at(launch + 2n * DAY + 6n * HOUR); await submit(a)
    await send(mining, 'publishAllocations', [0n, a.entries, a.proofs])
    await send(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider)
    await at(await now() + 2n * DAY)
    await denied(mining, 'activateDay', [0n], outsider, 'InvalidPhase')
    assert.equal((await read(mining, 'certificate', [openDigest(31337, mining.address, a.report)]))[0], 0n)
  })

  await scenario('no active stake means no certificates; pre-launch exit cannot mint a day', async () => {
    await send(registry, 'requestExit', [keys[0].address])
    const r = await report()
    await at(launch + 2n * DAY + 6n * HOUR)
    await assert.rejects(submit(r), /InvalidPhase/)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
  })

  await scenario('wrong totals and reused casts cannot mint, even with quorum signatures', async () => {
    const day0 = await mineDay(0n)
    const day1 = await mineDay(1n, [[1, alice, 2000n, zeroAddress, day0[0].castHash]])
    await initialClaims(await report(0n, day0))
    const reused = await report(1n, day1)
    // Initial claim occurs at day 4.25, still within day 1's submission window.
    await submit(reused)
    await denied(mining, 'publishAllocations', [1n, reused.entries, reused.proofs], outsider, 'InvalidAllocation')
    assert.equal(await read(token, 'mintedForDay', [1n]), 0n)
  })

  await scenario('exit excludes only future days and returns escrow after 30-day liability', async () => {
    await at(launch + DAY)
    await send(registry, 'requestExit', [keys[0].address])
    assert.equal(await read(registry, 'totalWeightAt', [1n]), minBond)
    assert.equal(await read(registry, 'totalWeightAt', [2n]), 0n)
    await denied(registry, 'withdrawNode', [keys[0].address], admin, 'InvalidPhase')
    const end = await read(registry, 'withdrawAt', [keys[0].address])
    await at(end)
    const before = await read(token, 'balanceOf', [admin])
    await send(registry, 'withdrawNode', [keys[0].address])
    assert.equal(await read(token, 'balanceOf', [admin]), before + minBond)
    await denied(registry, 'withdrawNode', [keys[0].address], admin, 'InvalidPhase')
  })

  await scenario('stake snapshots are fixed even when called late; principal and rewards stay solvent', async () => {
    await initialClaims()
    await send(token, 'approve', [staking.address, 100n * unit], alice)
    await send(staking, 'stake', [100n * unit], alice)
    await denied(staking, 'activateGovernancePower', [], alice, 'Locked')
    await denied(staking, 'withdraw', [unit], alice, 'Locked')
    await at(launch + 31n * DAY)
    await send(token, 'approve', [staking.address, 100n * unit], bob)
    await send(staking, 'stake', [100n * unit], bob)
    await send(staking, 'snapshotEpoch', [1n])
    const e = await read(staking, 'epochs', [1n])
    assert.equal(BigInt(e[0]), launch + 30n * DAY - 1n); assert.equal(e[2], 100n * unit)
    await at(launch + 61n * DAY)
    await send(staking, 'finalizeEpoch', [0n]); await send(staking, 'finalizeEpoch', [1n])
    const rewards = (await read(staking, 'epochs', [1n]))[3]
    const before = await read(token, 'balanceOf', [alice])
    await send(staking, 'claim', [1n], alice)
    assert.equal(await read(token, 'balanceOf', [alice]), before + rewards)
    await denied(staking, 'claim', [1n], bob, 'InvalidAmount')
    await denied(staking, 'claim', [1n], alice, 'InvalidPhase')
    await send(staking, 'withdraw', [100n * unit], alice)
    assert.equal(await read(token, 'balanceOf', [staking.address]), await read(staking, 'totalStaked') + await read(staking, 'rewardLiability'))
  })

  await scenario('expired staking reward rolls forward once without stealing principal', async () => {
    await initialClaims()
    await send(token, 'approve', [staking.address, 100n * unit], alice); await send(staking, 'stake', [100n * unit], alice)
    await at(launch + 61n * DAY)
    await send(staking, 'finalizeEpoch', [0n]); await send(staking, 'finalizeEpoch', [1n])
    const e = await read(staking, 'epochs', [1n])
    await at(e[1]); await denied(staking, 'claim', [1n], alice, 'InvalidPhase')
    await send(staking, 'sweepUnclaimed', [1n]); await denied(staking, 'sweepUnclaimed', [1n], admin, 'InvalidPhase')
    assert.equal(await read(staking, 'rolloverRewards'), e[3])
    assert.equal(await read(token, 'balanceOf', [staking.address]), await read(staking, 'totalStaked') + await read(staking, 'rewardLiability'))
  })

  await scenario('monthly burn: mature stake, immutable snapshot, no token reuse, Yes > No', async () => {
    const r = await initialClaims()
    await send(token, 'approve', [staking.address, 100n * unit], alice); await send(staking, 'stake', [100n * unit], alice)
    const feb = 1896134400n
    await denied(mining, 'finalizeMonth', [feb], admin, 'MonthNotReady')
    await at(feb + 16n * DAY)
    await send(staking, 'activateGovernancePower', [], alice)
    await send(mining, 'finalizeMonth', [feb])
    assert.equal(await read(mining, 'totalClaimedByMonth', [203001n]), r.report.allocated)
    await send(dao, 'openMonthlyVote', [], outsider)
    await send(staking, 'withdraw', [100n * unit], alice)
    await send(token, 'transfer', [bob, 100n * unit], alice)
    await send(token, 'approve', [staking.address, 100n * unit], bob); await send(staking, 'stake', [100n * unit], bob)
    await denied(dao, 'vote', [203002n, true], bob, 'InvalidVote')
    await send(dao, 'vote', [203002n, true], alice)
    await denied(dao, 'vote', [203002n, false], alice, 'InvalidVote')
    const round = await read(dao, 'rounds', [203002n]), before = await read(token, 'totalSupply')
    await at(round[1]); await denied(dao, 'settle', [203002n], outsider, 'InvalidRound')
    await at(round[1] + 3n * DAY); await send(dao, 'settle', [203002n], outsider)
    assert.equal(await read(token, 'totalSupply'), before - round[8])
    assert.equal(await read(dao, 'reserved'), 0n)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE + miningPoolForDay(0))
  })

  await scenario('no votes fails without quorum, releases budget and burns nothing', async () => {
    await initialClaims(); const feb = 1896134400n
    await at(feb + 16n * DAY); await send(mining, 'finalizeMonth', [feb]); await send(dao, 'openMonthlyVote')
    const round = await read(dao, 'rounds', [203002n]), before = await read(token, 'totalSupply')
    await at(round[1]); await send(dao, 'settle', [203002n])
    assert.equal(await read(token, 'totalSupply'), before); assert.equal(await read(dao, 'reserved'), 0n)
  })

  await scenario('odd-month airdrop follows finalized prior-month claimed mining only', async () => {
    await send(token, 'approve', [staking.address, 100n * unit]); await send(staking, 'stake', [100n * unit])
    const day = 31n, r = await report(day)
    await activate(r); await send(mining, 'claim', [day], alice) // Bob deliberately does not claim.
    const march = 1898553600n
    await at(march + 16n * DAY); await send(staking, 'activateGovernancePower')
    await send(mining, 'finalizeMonth', [march]); await send(dao, 'openMonthlyVote')
    await send(dao, 'vote', [203003n, true])
    const round = await read(dao, 'rounds', [203003n])
    assert.equal(round[6], 203002n); assert.equal(round[7], r.amounts[0])
    await at(round[1] + 3n * DAY); await send(dao, 'settle', [203003n])
    const before = await read(token, 'balanceOf', [alice])
    await denied(dao, 'claimAirdrop', [203003n], bob, 'NothingToClaim')
    await send(dao, 'claimAirdrop', [203003n], alice)
    assert.equal(await read(token, 'balanceOf', [alice]), before + round[8])
    await denied(dao, 'claimAirdrop', [203003n], alice, 'NothingToClaim')
    assert.equal(await read(dao, 'reserved'), 0n)
  })

  await scenario('node-work x5 is verified onchain from the previous day signature; claimMany within 7 days', async () => {
    const day0 = await mineDay(0n)
    const day1 = await mineDay(1n, [[1, alice], [2, admin, 2000n, keys[0].address]])
    const day2 = await mineDay(2n, [[3, bob, 2000n, keys[0].address]]) // bob does not operate keys[0]
    await activate(await report(0n, day0))
    const r1 = await report(1n, day1)
    assert.equal(weightOf(r1.entries[1]), 250n)
    await activate(r1)
    assert.equal((await read(mining, 'dayInfo', [1n])).observedWeight, 300n)
    await denied(mining, 'claimMany', [[0n, 1n]], bob, 'InvalidPhase')
    const before = await read(token, 'balanceOf', [alice])
    await send(mining, 'claimMany', [[0n, 1n]], alice)
    assert.equal(await read(token, 'balanceOf', [alice]), before + (await read(mining, 'allocations', [0n, alice]))[1] + (await read(mining, 'allocations', [1n, alice]))[1])
    const r2 = await report(2n, day2)
    await submit(r2)
    await denied(mining, 'publishAllocations', [2n, r2.entries, r2.proofs], outsider, 'InvalidAllocation')
    await at((await read(mining, 'dayInfo', [0n])).claimEnd)
    await denied(mining, 'claim', [0n], bob, 'InvalidPhase')
  })

  await scenario('one transaction opens the next session and claims every open earlier day', async () => {
    const r = await report(); await activate(r) // now day 4
    const before = await read(token, 'balanceOf', [alice])
    await send(mining, 'startMiningAndClaim', [1n, castOf(1, 4n), [0n, 3n]], alice) // day 3 holds nothing: skipped
    assert.equal(await read(token, 'balanceOf', [alice]), before + r.amounts[0])
    assert.equal((await read(mining, 'sessions', [4n, alice]))[0], 1n)
    await denied(mining, 'claimMany', [[0n]], alice, 'InvalidPhase')
    await denied(mining, 'startMiningAndClaim', [2n, castOf(2, 4n), Array(101).fill(0n)], bob, 'InvalidPhase')
  })

  await scenario('burn-boost levels: unlocked by the release calendar, permanent per wallet, x1.2 weight and cap per level', async () => {
    await initialClaims() // alice now holds ~1.05M mined tokens
    await at(launch + 21n * DAY + HOUR)
    assert.equal(await read(token, 'boostUnlockedLevel'), 0n) // 9.99% released
    await denied(token, 'buyBoostLevel', [], alice, 'BoostLocked')
    const [before] = await mineDay(21n, [[1, alice]]) // opened before buying: stays level 0
    await at(launch + 22n * DAY)
    assert.equal(await read(token, 'boostUnlockedLevel'), 1n) // 10.44% released
    const supply = await read(token, 'totalSupply'), minted = await read(token, 'cumulativeMinted')
    await send(token, 'buyBoostLevel', [], alice)
    assert.equal(await read(token, 'boostLevel', [alice]), 1)
    assert.equal(await read(token, 'totalSupply'), supply - 1_000_000n * unit)
    assert.equal(await read(token, 'cumulativeMinted'), minted) // burns never reopen the mint cap
    await denied(token, 'buyBoostLevel', [], alice, 'BoostLocked') // level 2 opens at 20%
    assert.equal(before.level, 0)
    const day22 = await mineDay(22n)
    assert.deepEqual(day22.map(e => e.level), [1, 0])
    const r = await report(22n, day22)
    // A quorum cannot grant a level the session did not have when it opened.
    const forged = await report(21n, [{ ...before, level: 1 }])
    await at(launch + 23n * DAY + 6n * HOUR); await submit(forged)
    await denied(mining, 'publishAllocations', [21n, forged.entries, forged.proofs], outsider, 'InvalidAllocation')
    await activate(r)
    const pool = miningPoolForDay(22n)
    assert.equal(r.amounts[0], pool * 6n / 500n); assert.equal(r.amounts[1], pool / 100n) // 1.2% vs 1% cap
    assert.equal((await read(mining, 'allocations', [22n, alice]))[1], r.amounts[0])
  })

  await scenario('a key that signs nothing for 14 report days can be ejected by anyone', async () => {
    await bond(keys[1])
    await at(launch + DAY + HOUR); await send(registry, 'activateNode', [keys[1].address])
    const r5 = await report(5n)
    await at(launch + 7n * DAY + 6n * HOUR); await submit(r5) // half the stake: recorded, not certified
    assert.equal(await read(registry, 'lastSignedDay', [keys[0].address]), 5n)
    assert.equal((await read(mining, 'certificate', [openDigest(31337, mining.address, r5.report)]))[1], 0n)
    await at(launch + 18n * DAY); await denied(registry, 'ejectInactive', [keys[1].address], outsider, 'InvalidPhase')
    await at(launch + 19n * DAY); await send(registry, 'ejectInactive', [keys[1].address], outsider)
    await denied(registry, 'ejectInactive', [keys[0].address], outsider, 'InvalidPhase')
    assert.equal(await read(registry, 'totalWeightAt', [20n]), minBond)
    assert.ok(await read(registry, 'withdrawAt', [keys[1].address]) > 0n)
    await denied(registry, 'recordSignature', [keys[1].address, 30n], outsider, 'Unauthorized')
  })

  await scenario('stake governance: node or 1M staker proposes, 10% quorum, 14-day timelock spends and schedules a future month', async () => {
    await initialClaims()
    const stake = parseEther('1000000')
    await send(token, 'approve', [staking.address, stake], alice); await send(staking, 'stake', [stake], alice)
    await at(launch + 36n * DAY); await send(staking, 'activateGovernancePower', [], alice)
    await c.mine({ blocks: 2 })
    const next = await deploy('MineCastOpenDistributorV4', [token.address, registry.address, staking.address, dao.address])
    const april = 90n, grant = parseEther('1000') // mining day 90 is 2030-04-01
    const targets = [dao.address, token.address], values = [0n, 0n], datas = [
      encodeFunctionData({ abi: dao.abi, functionName: 'spend', args: [carol, grant] }),
      encodeFunctionData({ abi: token.abi, functionName: 'scheduleDistributor', args: [next.address, april] })]
    const description = 'Grant and April distributor', descHash = keccak256(toHex(description))
    await denied(governor, 'propose', [targets, values, datas, description], outsider, 'GovernorInsufficientProposerVotes')
    await denied(governor, 'proposeAsNode', [keys[0].address, targets, values, datas, description], outsider, 'GovernorRestrictedProposer')
    await send(governor, 'proposeAsNode', [keys[0].address, targets, values, datas, description], admin)
    const id = await read(governor, 'hashProposal', [targets, values, datas, descHash])
    await c.mine({ blocks: 11 })
    await send(governor, 'castVote', [id, 1], alice)
    await c.mine({ blocks: 51 })
    assert.equal(await read(governor, 'state', [id]), 4)
    await send(governor, 'queue', [targets, values, datas, descHash], outsider)
    await denied(governor, 'execute', [targets, values, datas, descHash], outsider)
    await at(await now() + GOVERNANCE_DELAY + 1n)
    await send(governor, 'execute', [targets, values, datas, descHash], outsider)
    assert.equal(await read(token, 'balanceOf', [carol]), grant)
    same(await read(token, 'distributorForDay', [april - 1n]), mining.address); same(await read(token, 'distributorForDay', [april]), next.address)
    // The old contract keeps finishing its own days; only the new one opens April sessions.
    await at(launch + april * DAY + 10n)
    await denied(mining, 'startMining', [7n, castOf(7, april)], carol, 'InvalidPhase')
    await send(next, 'startMining', [7n, castOf(7, april)], carol)
    await denied(dao, 'spend', [carol, 1n], admin, 'Unauthorized')
    await denied(token, 'scheduleDistributor', [next.address, 120n], admin, 'Unauthorized')
  })

  await scenario('governance can only hand over whole future UTC months, never past or partial ones', async () => {
    await c.impersonateAccount({ address: timelock.address }); await c.setBalance({ address: timelock.address, value: parseEther('1') })
    const next = await deploy('MineCastOpenDistributorV4', [token.address, registry.address, staking.address, dao.address])
    await at(launch + 40n * DAY)
    for (const day of [0n, 31n, 75n]) await denied(token, 'scheduleDistributor', [next.address, day], timelock.address, 'InvalidConfiguration')
    await denied(token, 'scheduleDistributor', [alice, 59n], timelock.address, 'InvalidConfiguration')
    await send(token, 'scheduleDistributor', [next.address, 59n], timelock.address) // 2030-03-01
    same(await read(token, 'distributorForDay', [58n]), mining.address); same(await read(token, 'distributorForDay', [59n]), next.address)
    await denied(token, 'scheduleDistributor', [mining.address, 31n], timelock.address, 'InvalidConfiguration')
  })

  await scenario('100 heterogeneous miners: onchain differential allocation and bounded publication gas', async () => {
    const rows = []
    for (let i = 0; i < 100; i++) {
      const wallet = getAddress(toHex(BigInt(i + 1000), { size: 20 }))
      await c.impersonateAccount({ address: wallet }); await c.setBalance({ address: wallet, value: parseEther('1') })
      rows.push([i + 1, wallet, BigInt(i * 1733)])
    }
    const r = await report(0n, await mineDay(0n, rows))
    await at(launch + 2n * DAY + 6n * HOUR); await submit(r)
    const receipt = await send(mining, 'publishAllocations', [0n, r.entries, r.proofs])
    assert.ok(receipt.gasUsed < 16000000n)
    t.diagnostic('100-row publication gas: ' + receipt.gasUsed)
    await at(await now() + 2n * DAY); await send(mining, 'activateDay', [0n])
    let sum = 0n
    for (let i = 0; i < rows.length; i++) {
      const allocation = await read(mining, 'allocations', [0n, r.entries[i].wallet])
      assert.equal(allocation[1], r.amounts[i]); assert.ok(allocation[1] <= miningPoolForDay(0) / 100n)
      sum += allocation[1]
    }
    assert.equal(sum, r.report.allocated)
    assert.equal(await read(token, 'mintedForDay', [0n]), miningPoolForDay(0) - sum)
  })
})
