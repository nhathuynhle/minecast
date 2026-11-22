import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestClient, http, publicActions, walletActions, parseEther, keccak256, toHex, zeroAddress, zeroHash, getAddress, getContractAddress, encodeFunctionData } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { compileOpen } from './compile-open.mjs'
import { prepareDeployment, GOVERNANCE_DELAY } from './prepare-open-deployment.mjs'
import { verifyDeployment } from './verify-open-deployment.mjs'
import { buildOpenReport, openDigest, typedReport, weightOf } from './open-report.mjs'
import { miningPoolForDay, lifetimeCeilingAfterDays, MAX_SUPPLY, DEV_PREMINE } from './node/bootstrap-model.mjs'
import { commitmentOf, processDay, runPass } from './node/open-worker.mjs'
import { buildProposal } from './governance.mjs'

const DAY = 86400n, HOUR = 3600n, COMMIT = 1800n, REVIEW = HOUR, launch = 1893456000n, unit = parseEther('1'), minBond = parseEther('1000000')
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
  const governor = await deploy('MineCastGovernorV4', [staking.address, timelock.address, registry.address, dao.address, 10, 50])
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
    for (const [fid, wallet, followers = 2000n, nodeKey = zeroAddress, castHash = castOf(fid, day), inviter] of specs) {
      if (inviter) await send(mining, 'startMiningAndClaim', [BigInt(fid), castHash, [], inviter], wallet)
      else await send(mining, 'startMining', [BigInt(fid), castHash], wallet)
      const [, , invites, startedAt, level] = await read(mining, 'sessions', [day, wallet])
      entries.push({ fid: BigInt(fid), wallet, followers, nodeWork: nodeKey !== zeroAddress, castHash, startedAt, nodeKey, level, invites })
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
  async function commit(bundle, signer) {
    await c.setBalance({ address: signer.address, value: parseEther('1') })
    await send(mining, 'commitReport', [bundle.report.day, commitmentOf(openDigest(31337, mining.address, bundle.report), signer.address)], signer)
  }
  // Phase 1 of the report's day: the given keys commit to it, then time moves to the start of phase 2.
  async function reveal(bundle, signers = [keys[0]]) {
    const open = launch + (bundle.report.day + 1n) * DAY // the cohort close
    if (await now() >= open + COMMIT) throw Error('commit phase of day ' + bundle.report.day + ' is over')
    if (await now() < open) await at(open)
    for (const k of signers) await commit(bundle, k)
    await at(open + COMMIT)
  }
  async function certify(bundle, signers = [keys[0]]) {
    await reveal(bundle, signers)
    await submit(bundle, signers)
    for (let i = 0; i < bundle.entries.length; i += 100) {
      await send(mining, 'publishAllocations', [bundle.report.day, bundle.entries.slice(i, i + 100), bundle.proofs.slice(i, i + 100)], outsider)
    }
  }
  async function activate(bundle, signers = [keys[0]]) {
    await certify(bundle, signers)
    await at(await now() + REVIEW)
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

  await scenario('boost boundary differential fuzz: 2k+node=50, invites inside the x100 cap, burn up to the x200 ceiling', async () => {
    let seed = 7n
    const counts = [0n, 9n, 10n, 499n, 500n, 999n, 1000n, 1999n, 2000n, 4999n, 5000n, 9999n, 10000n, 25000n, 50000n, 100000n]
    for (let i = 0; i < 64; i++) { seed = (seed * 1664525n + 1013904223n) % 2n ** 32n; counts.push(seed % 200000n) }
    counts.push(99n, 100n)
    for (const followers of counts) for (const nodeWork of [false, true]) for (const invites of [0, 3, 10]) for (const level of [0, 1, 9]) {
      assert.equal(await read(mining, 'miningWeight', [followers, nodeWork, BigInt(invites), BigInt(level)]), weightOf({ followers, nodeWork, invites, level }))
    }
    assert.equal(await read(mining, 'miningWeight', [2000n, true, 0n, 0n]), 2500n) // weights are in fiftieths: x50
    assert.equal(await read(mining, 'miningWeight', [2000n, false, 10n, 0n]), 1000n) // 10 invites: x2
    assert.equal(await read(mining, 'miningWeight', [100000n, false, 10n, 0n]), 5000n) // invites never pass x100
    assert.equal(await read(mining, 'miningWeight', [100000n, true, 0n, 5n]), 10000n) // burn L5 reaches x200
    assert.equal(await read(mining, 'miningWeight', [100000n, true, 0n, 9n]), 10000n) // ...and nothing passes it
    assert.equal(await read(mining, 'miningWeight', [10000n, false, 0n, 9n]), 4200n) // x30 base keeps the full x2.8
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

  await scenario('sessions are opened onchain: one per wallet per UTC day, reports bound to the exact list', async () => {
    await denied(mining, 'startMining', [1n, castOf(1, 0n)], alice, 'InvalidSession')
    const [a] = await mineDay(0n, [[1, alice]])
    await denied(mining, 'startMining', [5n, castOf(5, 0n)], alice, 'InvalidSession')
    await denied(mining, 'startMining', [0n, castOf(9, 0n)], bob, 'InvalidSession')
    await denied(mining, 'startMining', [9n, toHex(0n, { size: 20 })], bob, 'InvalidSession')
    assert.equal(await read(mining, 'sessionCount', [0n]), 1n); same(await read(mining, 'sessionWallet', [0n, 0n]), alice)
    await at(launch + DAY - 1n); await denied(mining, 'startMining', [1n, castOf(1, 1n)], alice, 'InvalidSession') // same cohort
    await at(launch + DAY); await send(mining, 'startMining', [1n, castOf(1, 1n)], alice) // the next cohort opens at 00:00 UTC
    assert.equal((await read(mining, 'sessions', [1n, alice]))[3], launch + DAY)
    const fake = { ...a, fid: 2n, wallet: carol, castHash: castOf(2, 0n) } // no onchain session behind it
    const bad = await report(0n, [a], hash('not the session list')), r = await report(0n, [a, fake])
    await reveal(r)
    await assert.rejects(submit(bad), /InvalidReport/)
    await submit(r)
    await send(mining, 'publishAllocations', [0n, [r.entries[0]], [r.proofs[0]]])
    await denied(mining, 'publishAllocations', [0n, [r.entries[1]], [r.proofs[1]]], outsider, 'InvalidAllocation')
  })

  await scenario('one-node bootstrap, EIP712 replay protection, duplicates and early results', async () => {
    const r = await report()
    assert.equal(openDigest(31337, mining.address, r.report), await read(mining, 'reportDigest', [r.report]))
    await denied(mining, 'submitSignatures', [r.report, [keys[0].address], [await sig(keys[0], r.report)]], admin, 'InvalidPhase')
    await reveal(r)
    for (const [chain, address] of [[8453, mining.address], [31337, token.address]]) {
      await denied(mining, 'submitSignatures', [r.report, [keys[0].address], [await sig(keys[0], r.report, chain, address)]], admin, 'InvalidSignature')
    }
    await submit(r)
    const certificate = await read(mining, 'certificate', [openDigest(31337, mining.address, r.report)])
    assert.equal(certificate[0], minBond); assert.ok(certificate[1] > 0n)
    assert.equal(await read(mining, 'committedWeight', [openDigest(31337, mining.address, r.report)]), minBond)
    await assert.rejects(submit(r), /DuplicateSigner/)
    await denied(mining, 'activateDay', [0n], admin, 'InvalidPhase')
  })

  await scenario('full onchain publication is mandatory; claims need no downloaded proof', async () => {
    const r = await report(); await reveal(r); await submit(r)
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
    await at(launch + DAY - 1n) // the cohort is still open
    assert.match(await processDay(ctx, 0n, launch, await now()), /not signing/)
    await at(launch + DAY) // 00:00 UTC close, phase 1: commit only, nothing visible to peers yet
    const wrongBuild = { ...ctx, client: { ...c, chain: { ...c.chain, id: 8453 } } } // digest the distributor would reject
    await assert.rejects(processDay(wrongBuild, 0n, launch, await now()), /does not match the deployed TokenCast V4/)
    assert.deepEqual(fs.readdirSync(ctx.dir), [])
    assert.match(await processDay(ctx, 0n, launch, await now()), /committed/)
    assert.notEqual(await read(mining, 'commitments', [0n, keys[0].address]), zeroHash)
    assert.equal(await read(mining, 'announcementCount', [0n]), 0n)
    await at(launch + DAY + COMMIT) // phase 2 after 30 minutes: reveal the committed report, sign, relay
    assert.equal(await processDay(ctx, 0n, launch, await now()), 'waiting for review')
    assert.equal(await read(mining, 'announcementCount', [0n]), 1n) // published before signing, for peers to adopt
    assert.equal(await read(registry, 'certifiedSigner', [0n, keys[0].address]), true)
    assert.equal((await read(mining, 'dayInfo', [0n])).published, 2n)
    ctx.collect = async () => { throw Error('a signed day must come from the journal, never be re-collected') }
    await at(await now() + REVIEW) // claims open about 1.5 hours after the close
    assert.equal(await processDay(ctx, 0n, launch, await now()), 'activated')
    assert.equal(await processDay(ctx, 0n, launch, await now()), 'claims open')
    await send(mining, 'claim', [0n], alice)
  })

  await scenario('tampered social fields or allocation totals cannot pass committed onchain formula', async () => {
    const r = await report(); r.report.allocated += 1n
    await reveal(r); await submit(r)
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
    const r = await report(); await at(launch + DAY + 8n * DAY - REVIEW) // no time left for a review before day 0's deadline
    await assert.rejects(submit(r), /InvalidPhase/)
    await denied(mining, 'publishAllocations', [0n, r.entries, r.proofs], admin, 'InvalidPhase')
  })

  await scenario('strict >2/3 of all stake: offline founder cannot be ignored', async () => {
    await initialClaims()
    await bond(keys[1], alice); await bond(keys[2], bob)
    await at(launch + 12n * DAY)
    await send(registry, 'activateNode', [keys[1].address]); await send(registry, 'activateNode', [keys[2].address])
    const day = 13n, r = await report(day)
    await reveal(r, [keys[1], keys[2]])
    await submit(r, [keys[1], keys[2]])
    const digest = openDigest(31337, mining.address, r.report)
    assert.deepEqual(await read(mining, 'certificate', [digest]), [2n * minBond, 0n])
    await submit(r, [keys[0]])
    assert.ok((await read(mining, 'certificate', [digest]))[1] > 0n)
    // Founder voluntarily exits: the other two alone can certify future days.
    await send(registry, 'requestExit', [keys[0].address])
    const n = await read(registry, 'nodes', [keys[0].address]), future = n[3]
    const next = await report(future)
    await reveal(next, [keys[1], keys[2]]); await submit(next, [keys[1], keys[2]])
    assert.ok((await read(mining, 'certificate', [openDigest(31337, mining.address, next.report)]))[1] > 0n)
  })

  await scenario('a key that alone holds the quorum certifies without a commitment; double-signing contests the day and burns its bond', async () => {
    const a = await report(), b = await report(0n, [a.entries[0]])
    await reveal(a); await submit(a); await submit(b)
    const digestB = openDigest(31337, mining.address, b.report)
    assert.ok((await read(mining, 'certificate', [digestB]))[1] > 0n) // nobody can outvote it, so no commitment is needed
    assert.equal(await read(mining, 'committedWeight', [digestB]), 0n)
    assert.equal((await read(mining, 'dayInfo', [0n])).contested, true) // two conflicting certificates
    const before = await read(token, 'totalSupply')
    await send(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider)
    assert.deepEqual(await read(mining, 'certificate', [openDigest(31337, mining.address, a.report)]), [0n, 0n])
    assert.deepEqual(await read(mining, 'certificate', [digestB]), [0n, 0n])
    await denied(mining, 'publishAllocations', [0n, a.entries, a.proofs], admin, 'InvalidPhase')
    await denied(registry, 'slashEquivocation', [keys[0].address, 0n], outsider, 'Unauthorized')
    assert.equal(await read(token, 'totalSupply'), before - minBond)
    assert.equal(await read(registry, 'totalEscrowed'), 0n)
    assert.equal(await read(registry, 'totalWeightAt', [0n]), minBond)
    assert.equal(await read(registry, 'totalWeightAt', [3n]), 0n)
    await denied(registry, 'withdrawNode', [keys[0].address], admin, 'InvalidPhase')
    await denied(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider, 'InvalidEvidence')
  })

  await scenario('the worker activates its own key once the 7-day join delay ends', async () => {
    await bond(keys[1])
    await c.setBalance({ address: keys[1].address, value: parseEther('1') })
    const ctx = { client: c, account: keys[1], distributor: mining.address, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'minecast-journal-')),
      collect: async () => { throw Error('nothing to report yet') } }
    const [, readyAt] = await read(registry, 'nodes', [keys[1].address])
    await at(readyAt - 1n); await runPass(ctx)
    assert.equal((await read(registry, 'nodes', [keys[1].address]))[5], false) // not ready yet: nothing sent
    await at(readyAt); await runPass(ctx)
    const node = await read(registry, 'nodes', [keys[1].address])
    assert.equal(node[5], true); assert.equal(node[2], (readyAt - launch) / DAY + 1n) // counts from the next day
    await runPass(ctx) // already active: no second transaction
  })

  await scenario('a lone node that misses the 30-minute commit phase still signs its own report late', async () => {
    const input = { day: 0n, launchTime: launch, entries: await mineDay(0n), sourceHash: await read(mining, 'sessionsHash', [0n]) }
    const ctx = { client: c, account: keys[0], distributor: mining.address,
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'minecast-journal-')), collect: async () => input }
    await c.setBalance({ address: keys[0].address, value: parseEther('10') })
    await at(launch + DAY + COMMIT + 600n) // the node was offline for the whole commit phase
    assert.equal(await processDay(ctx, 0n, launch, await now()), 'waiting for review')
    assert.equal(await read(mining, 'commitments', [0n, keys[0].address]), zeroHash)
    assert.equal(await read(mining, 'announcementCount', [0n]), 0n) // without a commitment it cannot announce, and needs not
    await at(await now() + REVIEW)
    assert.equal(await processDay(ctx, 0n, launch, await now()), 'activated')
  })

  await scenario('a key slashed for one day still loses its signature on another day it double-signed', async () => {
    const r0 = await report(0n), r1 = await report(1n), junk0 = await report(0n, []), junk1 = await report(1n, [])
    await reveal(r0); await submit(r0)
    await reveal(r1); await submit(r1)
    const digest1 = openDigest(31337, mining.address, r1.report)
    assert.ok((await read(mining, 'certificate', [digest1]))[1] > 0n)
    const evidence1 = [keys[0].address, r1.report, await sig(keys[0], r1.report), junk1.report, await sig(keys[0], junk1.report)]
    await send(mining, 'proveEquivocation', [keys[0].address, r0.report, await sig(keys[0], r0.report), junk0.report, await sig(keys[0], junk0.report)], outsider)
    await send(mining, 'proveEquivocation', evidence1, outsider) // no bond left to burn, support still removed
    assert.deepEqual(await read(mining, 'certificate', [digest1]), [0n, 0n])
    assert.equal(await read(mining, 'committedWeight', [digest1]), 0n)
    assert.equal((await read(mining, 'dayInfo', [1n])).contested, false)
    await denied(mining, 'proveEquivocation', evidence1, outsider, 'InvalidEvidence') // counted once
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
    await reveal(a); await submit(a)
    await send(mining, 'publishAllocations', [0n, a.entries, a.proofs])
    await send(mining, 'proveEquivocation', [keys[0].address, a.report, await sig(keys[0], a.report), b.report, await sig(keys[0], b.report)], outsider)
    await at(await now() + 2n * DAY)
    await denied(mining, 'activateDay', [0n], outsider, 'InvalidPhase')
    assert.equal((await read(mining, 'certificate', [openDigest(31337, mining.address, a.report)]))[0], 0n)
  })

  await scenario('no active stake means no certificates; pre-launch exit cannot mint a day', async () => {
    await send(registry, 'requestExit', [keys[0].address])
    const r = await report()
    await at(launch + 2n * DAY + 12n * HOUR)
    await assert.rejects(submit(r), /InvalidPhase/)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
  })

  await scenario('wrong totals and reused casts cannot mint, even with quorum signatures', async () => {
    const day0 = await mineDay(0n)
    const day1 = await mineDay(1n, [[1, alice, 2000n, zeroAddress, day0[0].castHash]])
    const reused = await report(1n, day1)
    await certify(await report(0n, day0)) // publishing day 0 marks its casts used
    await reveal(reused); await submit(reused)
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

  await scenario('odd-month airdrop pays prior-month miners who kept a third of their mining staked', async () => {
    await send(token, 'approve', [staking.address, 100n * unit]); await send(staking, 'stake', [100n * unit])
    const day = 31n, r = await report(day), [minedA, minedB] = r.amounts
    await activate(r); await send(mining, 'claim', [day], alice); await send(mining, 'claim', [day], bob)
    await send(token, 'approve', [staking.address, minedA / 3n + 1n], alice); await send(staking, 'stake', [minedA / 3n + 1n], alice)
    const march = 1898553600n
    await at(march + 16n * DAY); await send(staking, 'activateGovernancePower')
    await send(mining, 'finalizeMonth', [march]); await send(dao, 'openMonthlyVote')
    await send(dao, 'vote', [203003n, true])
    const round = await read(dao, 'rounds', [203003n])
    assert.equal(round[6], 203002n); assert.equal(round[7], minedA + minedB)
    await at(round[1] + 3n * DAY); await send(dao, 'settle', [203003n])
    const before = await read(token, 'balanceOf', [alice]), share = round[8] * minedA / round[7]
    await denied(dao, 'claimAirdrop', [203003n], bob, 'NotEligible') // mined and claimed, but staked nothing
    await denied(dao, 'claimAirdrop', [203003n], carol, 'NothingToClaim')
    await send(dao, 'claimAirdrop', [203003n], alice)
    assert.equal(await read(token, 'balanceOf', [alice]), before + share)
    await denied(dao, 'claimAirdrop', [203003n], alice, 'NothingToClaim')
    assert.equal(await read(dao, 'reserved'), round[8] - share) // Bob's part returns to the treasury after the window
    await at((await read(dao, 'rounds', [203003n]))[2]); await send(dao, 'releaseExpiredAirdrop', [203003n], outsider)
    assert.equal(await read(dao, 'reserved'), 0n)
  })

  await scenario('node-work x5 is verified onchain from the previous day signature; claimMany within 7 days', async () => {
    const day0 = await mineDay(0n)
    const day1 = await mineDay(1n, [[1, alice], [2, admin, 2000n, keys[0].address]])
    const r1 = await report(1n, day1)
    assert.equal(weightOf(r1.entries[1]), 2500n)
    await certify(await report(0n, day0)) // right after day 0's close, in its own phase 1
    const day2 = await mineDay(2n, [[3, bob, 2000n, keys[0].address]]) // bob does not operate keys[0]
    const r2 = await report(2n, day2)
    await certify(r1)
    await reveal(r2); await submit(r2)
    await denied(mining, 'publishAllocations', [2n, r2.entries, r2.proofs], outsider, 'InvalidAllocation')
    await at(await now() + 2n * DAY)
    for (const day of [0n, 1n]) await send(mining, 'activateDay', [day], outsider)
    assert.equal((await read(mining, 'dayInfo', [1n])).observedWeight, 3000n)
    await denied(mining, 'claimMany', [[0n, 1n]], bob, 'InvalidPhase')
    const before = await read(token, 'balanceOf', [alice])
    await send(mining, 'claimMany', [[0n, 1n]], alice)
    assert.equal(await read(token, 'balanceOf', [alice]), before + (await read(mining, 'allocations', [0n, alice]))[1] + (await read(mining, 'allocations', [1n, alice]))[1])
    await at((await read(mining, 'dayInfo', [0n])).claimEnd)
    await denied(mining, 'claim', [0n], bob, 'InvalidPhase')
  })

  await scenario('one transaction opens the next session and claims every open earlier day', async () => {
    const r = await report(); await activate(r) // day 0 claims open about 1.5 hours into day 1
    const before = await read(token, 'balanceOf', [alice])
    await send(mining, 'startMiningAndClaim', [1n, castOf(1, 1n), [0n, 3n], zeroAddress], alice) // day 3 holds nothing yet: skipped
    assert.equal(await read(token, 'balanceOf', [alice]), before + r.amounts[0])
    assert.equal((await read(mining, 'sessions', [1n, alice]))[0], 1n)
    await denied(mining, 'claimMany', [[0n]], alice, 'InvalidPhase')
    await denied(mining, 'startMiningAndClaim', [2n, castOf(2, 1n), Array(101).fill(0n), zeroAddress], bob, 'InvalidPhase')
  })

  await scenario('invites: +0.1 weight per invitee FID with 100+ followers, set once, counted once, fixed at session start', async () => {
    // alice (2000 followers) and carol (99: tier floor 10) name bob; bob naming himself is ignored
    const day0 = await mineDay(0n, [[1, alice, 2000n, zeroAddress, undefined, bob], [3, carol, 10n, zeroAddress, undefined, bob], [2, bob, 2000n, zeroAddress, undefined, bob]])
    assert.equal(getAddress(await read(mining, 'inviterOf', [alice])), getAddress(bob))
    assert.equal(await read(mining, 'inviterOf', [bob]), zeroAddress)
    assert.deepEqual(day0.map(e => e.invites), [0, 0, 0])
    await activate(await report(0n, day0))
    assert.equal(await read(mining, 'inviteCount', [bob]), 1n) // carol is under 100 followers
    assert.equal(await read(mining, 'inviteCounted', [1n]), true)
    // fid 1 again from another wallet that names bob: the FID already counted
    const day1 = await mineDay(1n, [[1, outsider, 2000n, zeroAddress, undefined, bob], [2, bob, 2000n, zeroAddress, undefined, carol]])
    assert.deepEqual(day1.map(e => e.invites), [0, 1])
    const r1 = await report(1n, day1)
    assert.equal(weightOf(r1.entries[1]), 550n) // tier 10 x 1.1, in fiftieths
    await activate(r1)
    assert.equal(await read(mining, 'inviteCount', [bob]), 1n)
    assert.equal(getAddress(await read(mining, 'inviterOf', [bob])), getAddress(carol)) // bob may still name his own inviter
    // A quorum cannot grant invites the session did not carry.
    const [own] = await mineDay(2n, [[2, bob]])
    const forged = await report(2n, [{ ...own, invites: 2 }])
    await reveal(forged); await submit(forged)
    await denied(mining, 'publishAllocations', [2n, forged.entries, forged.proofs], outsider, 'InvalidAllocation')
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
    await reveal(forged); await submit(forged)
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
    await at(launch + 7n * DAY + 12n * HOUR); await submit(r5) // half the stake: recorded, not certified
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
    const built = buildProposal({ description, actions: [{ spend: { to: carol, amount: '1000' } },
      { scheduleDistributor: { distributor: next.address, startDay: 90 } }] }, { dao: dao.address, token: token.address })
    assert.deepEqual([built.targets, built.values, built.calldatas, built.descriptionHash], [targets, values, datas, descHash])
    await denied(governor, 'propose', [targets, values, datas, description], outsider, 'GovernorInsufficientProposerVotes')
    await denied(governor, 'proposeAsNode', [keys[0].address, targets, values, datas, description], outsider, 'GovernorRestrictedProposer')
    assert.equal(await read(governor, 'proposalCount'), 0n)
    await send(governor, 'proposeAsNode', [keys[0].address, targets, values, datas, description], admin)
    const id = await read(governor, 'hashProposal', [targets, values, datas, descHash])
    // Apps list proposals onchain and read the actions/description from the ProposalCreated event in that block.
    assert.equal(await read(governor, 'proposalCount'), 1n)
    const [listed, createdBlock] = await read(governor, 'proposalAt', [0n])
    assert.equal(listed, id)
    const [created] = await c.getContractEvents({ address: governor.address, abi: governor.abi, eventName: 'ProposalCreated', fromBlock: createdBlock, toBlock: createdBlock })
    assert.equal(created.args.proposalId, id); assert.equal(created.args.description, description)
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

  await scenario('governance guards: delegation, quorum floor, two thirds for rule changes, one live proposal each', async () => {
    await initialClaims()
    for (const [who, amount] of [[alice, parseEther('1000000')], [bob, parseEther('600000')]]) {
      await send(token, 'approve', [staking.address, amount], who); await send(staking, 'stake', [amount], who)
    }
    await at(launch + 36n * DAY)
    await send(staking, 'activateGovernancePower', [], alice); await send(staking, 'activateGovernancePower', [], bob)
    await send(staking, 'delegate', [carol], alice) // carol now votes with alice's 1M; the stake stays alice's
    await c.mine({ blocks: 2 })
    const block = await c.getBlockNumber() - 1n
    assert.equal(await read(staking, 'votingPowerAt', [carol, block]), parseEther('1000000'))
    assert.equal(await read(staking, 'votingPowerAt', [alice, block]), 0n)
    const grant = n => [[dao.address], [0n], [encodeFunctionData({ abi: dao.abi, functionName: 'spend', args: [carol, n] })]]
    const next = await deploy('MineCastOpenDistributorV4', [token.address, registry.address, staking.address, dao.address])
    const rule = [[token.address], [0n], [encodeFunctionData({ abi: token.abi, functionName: 'scheduleDistributor', args: [next.address, 90n] })]]
    async function propose(actions, description) {
      await send(governor, 'proposeAsNode', [keys[0].address, ...actions, description], admin)
      return read(governor, 'hashProposal', [...actions, keccak256(toHex(description))])
    }
    async function vote(id, votes) {
      await c.mine({ blocks: 11 })
      for (const [who, support] of votes) await send(governor, 'castVote', [id, support], who)
      await c.mine({ blocks: 51 })
      return read(governor, 'state', [id])
    }
    const a = await propose(grant(1n), 'Spend A')
    await denied(governor, 'proposeAsNode', [keys[0].address, ...grant(2n), 'Spend B'], admin, 'ProposerHasLiveProposal')
    assert.equal(await read(governor, 'needsSupermajority', [a]), false)
    assert.equal(await vote(a, [[carol, 1], [bob, 0]]), 4) // 1M for vs 0.6M against: majority, and above the floor
    // 1% of released supply is far above the stake, so the floor is half of all voting power (1.6M / 2).
    assert.equal(await read(governor, 'proposalQuorum', [a]), parseEther('800000'))
    const r = await propose(rule, 'April distributor')
    assert.equal(await read(governor, 'needsSupermajority', [r]), true)
    assert.equal(await vote(r, [[carol, 1], [bob, 0]]), 3) // 62.5% for: a rule change needs two thirds
    const f = await propose(grant(3n), 'Spend C')
    assert.equal(await vote(f, [[bob, 1]]), 3) // 0.6M for: above 10% of stake, below the 0.8M floor
  })

  await scenario('treasury: simple-majority spends are capped at 5% per 30 days; uncapped spends need two thirds', async () => {
    await initialClaims()
    await c.impersonateAccount({ address: timelock.address }); await c.setBalance({ address: timelock.address, value: parseEther('1') })
    const period = 30n * DAY
    await at((await now() / period + 1n) * period + HOUR) // start of a fresh 30-day period
    const unreserved = (await read(token, 'balanceOf', [dao.address])) - (await read(dao, 'reserved'))
    const cap = unreserved * 500n / 10_000n
    assert.ok(cap > 1000n * unit)
    await denied(dao, 'spend', [carol, cap + 1n], timelock.address, 'SpendCapExceeded')
    await send(dao, 'spend', [carol, cap - 1000n], timelock.address)
    await denied(dao, 'spend', [carol, 2000n], timelock.address, 'SpendCapExceeded') // nearly used up this period
    await send(dao, 'spend', [carol, 1000n], timelock.address) // exactly the cap
    await at(await now() + period)
    await send(dao, 'spend', [carol, 1000n], timelock.address) // a new period has its own cap
    await send(dao, 'spendLarge', [carol, unreserved / 2n], timelock.address)
    assert.equal(await read(token, 'balanceOf', [carol]), cap + 1000n + unreserved / 2n)
    await denied(dao, 'spendLarge', [carol, 1n], admin, 'Unauthorized')
    const large = [[dao.address], [0n], [encodeFunctionData({ abi: dao.abi, functionName: 'spendLarge', args: [carol, 1n] })]]
    await send(governor, 'proposeAsNode', [keys[0].address, ...large, 'Move the treasury'], admin)
    const id = await read(governor, 'hashProposal', [...large, keccak256(toHex('Move the treasury'))])
    assert.equal(await read(governor, 'needsSupermajority', [id]), true)
    assert.deepEqual(buildProposal({ description: 'x', actions: [{ spendLarge: { to: carol, amount: '1' } }] }, { dao: dao.address, token: token.address }).calldatas,
      [encodeFunctionData({ abi: dao.abi, functionName: 'spendLarge', args: [carol, unit] })])
  })

  await scenario('keys outside the certified quorum for 14 certified days can be ejected; governance can eject too', async () => {
    await bond(keys[1])
    await at(launch + DAY + HOUR); await send(registry, 'activateNode', [keys[1].address])
    const r5 = await report(5n)
    await reveal(r5, [keys[0]]) // half the stake committed: over the 1/3 floor
    await submit(r5, [keys[0]]) // half the stake: not certified yet
    assert.equal(await read(registry, 'certifiedDays'), 0n)
    await submit(r5, [keys[1]]) // completes the quorum; only the completing batch is credited automatically
    assert.equal(await read(registry, 'certifiedDays'), 1n)
    assert.equal(await read(registry, 'certifiedSigner', [5n, keys[1].address]), true)
    assert.equal(await read(registry, 'certifiedSigner', [5n, keys[0].address]), false)
    await denied(mining, 'proveCertifiedSignature', [5n, keys[2].address], outsider, 'InvalidSignature')
    await send(mining, 'proveCertifiedSignature', [5n, keys[0].address], outsider)
    assert.equal(await read(registry, 'certifiedSigner', [5n, keys[0].address]), true)
    // Fourteen more certified days without keys[1]: it keeps signing (not silent) but is outvoted, so it is out.
    await c.impersonateAccount({ address: mining.address }); await c.setBalance({ address: mining.address, value: parseEther('1') })
    for (let d = 6n; d < 20n; d++) {
      await send(registry, 'noteCertifiedDay', [d], mining.address)
      await send(registry, 'recordCertifiedSignature', [keys[0].address, d], mining.address)
    }
    await send(registry, 'recordSignature', [keys[1].address, 19n], mining.address)
    await denied(registry, 'ejectInactive', [keys[0].address], outsider, 'InvalidPhase')
    await send(registry, 'ejectInactive', [keys[1].address], outsider)
    await denied(registry, 'noteCertifiedDay', [20n], outsider, 'Unauthorized')
    await denied(registry, 'ejectByGovernance', [keys[0].address], admin, 'Unauthorized')
    await c.impersonateAccount({ address: timelock.address }); await c.setBalance({ address: timelock.address, value: parseEther('1') })
    await send(registry, 'ejectByGovernance', [keys[0].address], timelock.address)
    assert.ok(await read(registry, 'withdrawAt', [keys[0].address]) > 0n)
  })

  await scenario('a bonded key commits to its own report, then reveals it once so peers can co-sign it', async () => {
    const r = await report(0n), other = await report(0n, r.entries.map((e, i) => i ? e : { ...e, followers: e.followers + 1n }))
    await c.setBalance({ address: keys[0].address, value: parseEther('10') })
    const commitment = commitmentOf(openDigest(31337, mining.address, r.report), keys[0].address)
    await denied(mining, 'commitReport', [0n, commitment], keys[0], 'InvalidPhase') // the cohort is still open
    await at(launch + DAY)
    await denied(mining, 'commitReport', [0n, commitment], outsider, 'InvalidSignature')
    await denied(mining, 'announceReport', [0n, r.report, r.entries], keys[0], 'InvalidSignature') // nothing committed
    await send(mining, 'commitReport', [0n, commitment], keys[0])
    await denied(mining, 'commitReport', [0n, commitment], keys[0], 'InvalidSignature')
    await denied(mining, 'announceReport', [0n, r.report, r.entries], keys[0], 'InvalidPhase') // still phase 1
    await assert.rejects(submit(r), /InvalidPhase/) // no signature may leak during phase 1 either
    await at(launch + DAY + COMMIT)
    await denied(mining, 'commitReport', [0n, commitment], keys[0], 'InvalidPhase')
    await denied(mining, 'announceReport', [0n, other.report, other.entries], keys[0], 'InvalidSignature') // not what it committed
    await send(mining, 'announceReport', [0n, r.report, r.entries], keys[0])
    await denied(mining, 'announceReport', [0n, r.report, r.entries], keys[0], 'InvalidSignature')
    assert.equal(await read(mining, 'announcementCount', [0n]), 1n)
    same((await read(mining, 'announcementAt', [0n, 0n]))[0], keys[0].address)
  })

  await scenario('signatures alone cannot certify: over 1/3 of all stake must have committed that exact report', async () => {
    await initialClaims()
    await c.impersonateAccount({ address: dao.address }); await c.setBalance({ address: dao.address, value: parseEther('1') })
    await send(token, 'transfer', [admin, 3n * minBond], dao.address) // treasury tokens fund three more test bonds
    const all = keys.slice(0, 4)
    for (const k of all.slice(1)) await bond(k)
    await at(launch + 12n * DAY)
    for (const k of all.slice(1)) await send(registry, 'activateNode', [k.address])
    const e13 = await mineDay(13n), e14 = await mineDay(14n)
    const r = await report(13n, e13), digest = openDigest(31337, mining.address, r.report)
    await reveal(r, [keys[0]]) // a quarter of the stake built it; the rest only co-sign
    await submit(r, all)
    assert.deepEqual(await read(mining, 'certificate', [digest]), [4n * minBond, 0n])
    assert.equal(await read(mining, 'committedWeight', [digest]), minBond)
    const s14 = await report(14n, e14), digest14 = openDigest(31337, mining.address, s14.report)
    await reveal(s14, [keys[0], keys[1], keys[3]]) // three quarters built it; keys[3] is late to sign
    await submit(s14, all.slice(0, 3))
    assert.ok((await read(mining, 'certificate', [digest14]))[1] > 0n)
    // A proven equivocator's commitment leaves with its signature: 2/4 signed and 1/4 committed lose the quorum.
    const other = await report(14n, [])
    await send(mining, 'proveEquivocation', [keys[1].address, s14.report, await sig(keys[1], s14.report), other.report, await sig(keys[1], other.report)], outsider)
    assert.deepEqual(await read(mining, 'certificate', [digest14]), [2n * minBond, 0n])
    assert.equal(await read(mining, 'committedWeight', [digest14]), minBond)
    await denied(mining, 'publishAllocations', [14n, s14.entries, s14.proofs], outsider, 'InvalidPhase')
    // One self-equivocating key cannot cancel the day: the late honest key restores the quorum.
    await submit(s14, [keys[3]])
    assert.ok((await read(mining, 'certificate', [digest14]))[1] > 0n)
    assert.equal((await read(mining, 'dayInfo', [14n])).contested, false)
    same((await read(mining, 'dayInfo', [14n])).digest, digest14)
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
    await reveal(r); await submit(r)
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
