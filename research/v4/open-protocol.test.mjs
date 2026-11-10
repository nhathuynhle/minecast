import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import { createTestClient, http, publicActions, walletActions, parseEther, keccak256, toHex, zeroAddress, zeroHash } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { compileOpen } from './compile-open.mjs'
import { prepareDeployment } from './prepare-open-deployment.mjs'
import { verifyDeployment } from './verify-open-deployment.mjs'
import { buildOpenReport, openDigest, typedReport, weightOf } from './open-report.mjs'
import { miningPoolForDay, lifetimeCeilingAfterDays, MAX_SUPPLY, DEV_PREMINE } from './node/bootstrap-model.mjs'

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
  const fixture = 'research/v4/fixtures/TestEmissionDistributor.sol'
  const compiled = compileOpen({ [fixture]: { content: fs.readFileSync(fixture, 'utf8') } })
  const artifacts = Object.assign({}, ...Object.values(compiled.contracts))
  const c = await startChain(t)
  const [admin, alice, bob, carol, outsider] = await c.getAddresses()
  const keys = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()))
  const read = (contract, functionName, args = []) => c.readContract({ ...contract, functionName, args })
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
  const dao = await deploy('MineCastMonthlyDaoV4', [token.address, staking.address])
  const mining = await deploy('MineCastOpenDistributorV4', [token.address, registry.address, staking.address, dao.address])
  await send(token, 'finalizeDistributor', [mining.address])
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
  const entry = (fid, wallet, day = 0n, followers = 2000n, nodeWork = false) => ({
    fid: BigInt(fid), wallet, followers, nodeWork, castHash: toHex(BigInt(fid) + day * 1000000n, { size: 20 }),
    startedAt: launch + day * DAY + 100n,
  })
  const report = (day = 0n, entries = [entry(1, alice, day), entry(2, bob, day)], sourceHash = hash('source:' + day)) =>
    buildOpenReport({ chainId: 31337, distributor: mining.address, launchTime: launch, day, entries, sourceHash })
  const sig = (key, r, chainId = 31337, distributor = mining.address) => key.signTypedData(typedReport(chainId, distributor, r))
  async function submit(bundle, signers = [keys[0]]) {
    return send(mining, 'submitSignatures', [bundle.report, signers.map(k => k.address),
      await Promise.all(signers.map(k => sig(k, bundle.report)))], outsider)
  }
  async function activate(bundle, signers = [keys[0]]) {
    await at(launch + (bundle.report.day + 2n) * DAY + 6n * HOUR)
    await submit(bundle, signers)
    for (let i = 0; i < bundle.entries.length; i += 100) {
      await send(mining, 'publishAllocations', [bundle.report.day, bundle.entries.slice(i, i + 100), bundle.proofs.slice(i, i + 100)], outsider)
    }
    await at(await now() + 2n * DAY)
    await send(mining, 'activateDay', [bundle.report.day], outsider)
  }
  async function initialClaims() {
    const r = report(); await activate(r)
    await send(mining, 'claim', [0n], alice); await send(mining, 'claim', [0n], bob)
    return r
  }

  await scenario('immutable lifetime/day caps and 2.1M premine match integer model', async () => {
    assert.equal(await read(token, 'totalSupply'), DEV_PREMINE)
    assert.equal(await read(token, 'bootstrapAdmin'), zeroAddress)
    assert.equal(await read(token, 'MAX_SUPPLY'), MAX_SUPPLY)
    await denied(token, 'finalizeDistributor', [mining.address], admin, 'AlreadyFinalized')
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
      launchTime: Number(await now() + 14n * DAY), pendingNonce: await c.getTransactionCount({ address: admin, blockTag: 'pending' }) }
    const currentTime = Number(await now())
    assert.throws(() => prepareDeployment({ ...config, devWallet: zeroAddress }, bundled, currentTime), /nonzero/)
    assert.throws(() => prepareDeployment({ ...config, launchTime: currentTime + 86400 }, bundled, currentTime), /8 days/)
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
  })

  await scenario('boost boundary differential fuzz: 2k+node=50, maximum=100', async () => {
    let seed = 7n
    const counts = [0n, 9n, 10n, 499n, 500n, 999n, 1000n, 1999n, 2000n, 4999n, 5000n, 9999n, 10000n, 25000n, 50000n, 100000n]
    for (let i = 0; i < 64; i++) { seed = (seed * 1664525n + 1013904223n) % 2n ** 32n; counts.push(seed % 200000n) }
    for (const followers of counts) for (const nodeWork of [false, true]) {
      assert.equal(await read(mining, 'miningWeight', [followers, nodeWork]), weightOf({ followers, nodeWork }))
    }
    assert.equal(await read(mining, 'miningWeight', [2000n, true]), 50n)
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
  })

  await scenario('one-node bootstrap, EIP712 replay protection, duplicates and early results', async () => {
    const r = report()
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
    const r = report(); await at(launch + 2n * DAY + 6n * HOUR); await submit(r)
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

  await scenario('tampered social fields or allocation totals cannot pass committed onchain formula', async () => {
    const r = report(); r.report.allocated += 1n
    await at(launch + 2n * DAY + 6n * HOUR); await submit(r)
    await denied(mining, 'publishAllocations', [0n, [{ ...r.entries[0], followers: 0n }], [r.proofs[0]]], admin, 'InvalidAllocation')
    await denied(mining, 'publishAllocations', [0n, [{ ...r.entries[0], wallet: carol }], [r.proofs[0]]], admin, 'InvalidAllocation')
    await send(mining, 'publishAllocations', [0n, r.entries, r.proofs])
    await at(await now() + 2n * DAY)
    await denied(mining, 'activateDay', [0n], admin, 'InvalidPhase')
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
  })

  await scenario('cap excess goes 5/95; unclaimed allocations never go to treasury', async () => {
    const r = report(); await activate(r)
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
    const r = report(0n, []); await activate(r)
    assert.equal(await read(token, 'mintedForDay', [0n]), miningPoolForDay(0))
    await denied(mining, 'claim', [0n], admin, 'InvalidPhase')
  })

  await scenario('expired result window prevents late minting or backfilled certificates', async () => {
    const r = report(); await at(launch + 7n * DAY)
    await assert.rejects(submit(r), /InvalidPhase/)
    await denied(mining, 'publishAllocations', [0n, r.entries, r.proofs], admin, 'InvalidPhase')
  })

  await scenario('strict >2/3 of all stake: offline founder cannot be ignored', async () => {
    await initialClaims()
    await bond(keys[1], alice); await bond(keys[2], bob)
    await at(launch + 12n * DAY)
    await send(registry, 'activateNode', [keys[1].address]); await send(registry, 'activateNode', [keys[2].address])
    const day = 13n, r = report(day)
    await at(launch + (day + 2n) * DAY + 6n * HOUR)
    await submit(r, [keys[1], keys[2]])
    const digest = openDigest(31337, mining.address, r.report)
    assert.deepEqual(await read(mining, 'certificate', [digest]), [2n * minBond, 0n])
    await submit(r, [keys[0]])
    assert.ok((await read(mining, 'certificate', [digest]))[1] > 0n)
    // Founder voluntarily exits: the other two alone can certify future days.
    await send(registry, 'requestExit', [keys[0].address])
    const n = await read(registry, 'nodes', [keys[0].address]), future = n[3]
    const next = report(future)
    await at(launch + (future + 2n) * DAY + 6n * HOUR); await submit(next, [keys[1], keys[2]])
    assert.ok((await read(mining, 'certificate', [openDigest(31337, mining.address, next.report)]))[1] > 0n)
  })

  await scenario('conflicting quorum blocks activation; double-sign evidence burns actual bond', async () => {
    const a = report(), b = report(0n, a.entries, hash('conflict'))
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
    const a = report(), b = report(1n)
    await at(launch + 3n * DAY)
    await denied(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), a.report, await sig(keys[0], a.report)], outsider, 'InvalidEvidence')
    await denied(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider, 'InvalidEvidence')
    assert.equal(await read(registry, 'totalEscrowed'), minBond)
  })

  await scenario('evidence invalidates a certificate even without a second submitted quorum', async () => {
    const a = report(), b = report(0n, a.entries, hash('hidden conflicting signature'))
    await at(launch + 2n * DAY + 6n * HOUR); await submit(a)
    await send(mining, 'publishAllocations', [0n, a.entries, a.proofs])
    await send(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider)
    await at(await now() + 2n * DAY)
    await denied(mining, 'activateDay', [0n], outsider, 'InvalidPhase')
    assert.equal((await read(mining, 'certificate', [openDigest(31337, mining.address, a.report)]))[0], 0n)
  })

  await scenario('no active stake means no certificates; pre-launch exit cannot mint a day', async () => {
    await send(registry, 'requestExit', [keys[0].address])
    await at(launch + 2n * DAY + 6n * HOUR)
    await assert.rejects(submit(report()), /InvalidPhase/)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
  })

  await scenario('wrong totals and reused casts cannot mint, even with quorum signatures', async () => {
    await initialClaims()
    const r = report(1n, [entry(1, alice, 1n)])
    r.entries[0].castHash = entry(1, alice).castHash
    const reused = report(1n, r.entries)
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
    await at(feb + 10n * DAY)
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
    assert.equal(await read(token, 'totalSupply'), before - round[7])
    assert.equal(await read(dao, 'reserved'), 0n)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE + miningPoolForDay(0))
  })

  await scenario('no votes fails without quorum, releases budget and burns nothing', async () => {
    await initialClaims(); const feb = 1896134400n
    await at(feb + 10n * DAY); await send(mining, 'finalizeMonth', [feb]); await send(dao, 'openMonthlyVote')
    const round = await read(dao, 'rounds', [203002n]), before = await read(token, 'totalSupply')
    await at(round[1]); await send(dao, 'settle', [203002n])
    assert.equal(await read(token, 'totalSupply'), before); assert.equal(await read(dao, 'reserved'), 0n)
  })

  await scenario('odd-month airdrop follows finalized prior-month claimed mining only', async () => {
    await send(token, 'approve', [staking.address, 100n * unit]); await send(staking, 'stake', [100n * unit])
    const day = 31n, r = report(day)
    await activate(r); await send(mining, 'claim', [day], alice) // Bob deliberately does not claim.
    const march = 1898553600n
    await at(march + 10n * DAY); await send(staking, 'activateGovernancePower')
    await send(mining, 'finalizeMonth', [march]); await send(dao, 'openMonthlyVote')
    await send(dao, 'vote', [203003n, true])
    const round = await read(dao, 'rounds', [203003n])
    assert.equal(round[5], 203002n); assert.equal(round[6], r.amounts[0])
    await at(round[1] + 3n * DAY); await send(dao, 'settle', [203003n])
    const before = await read(token, 'balanceOf', [alice])
    await denied(dao, 'claimAirdrop', [203003n], bob, 'NothingToClaim')
    await send(dao, 'claimAirdrop', [203003n], alice)
    assert.equal(await read(token, 'balanceOf', [alice]), before + round[7])
    await denied(dao, 'claimAirdrop', [203003n], alice, 'NothingToClaim')
    assert.equal(await read(dao, 'reserved'), 0n)
  })

  await scenario('100 heterogeneous miners: onchain differential allocation and bounded publication gas', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => entry(i + 1, toHex(BigInt(i + 1000), { size: 20 }), 0n, BigInt(i * 1733), i % 3 === 0))
    const r = report(0n, rows)
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
