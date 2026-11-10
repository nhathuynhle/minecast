import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import solc from 'solc'
import { concatHex, createTestClient, http, publicActions, walletActions, keccak256, toHex, parseEther, zeroHash } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { buildSnapshot, buildWorkManifest, buildNodeRewardReport, claimLeaf, hashPair } from './snapshot.mjs'
import { reportDigest } from './node/report-digest.mjs'
import { prepareSubmission, readNodeReceipts } from './node/relay-report.mjs'
import { nodeWorkDigest } from './node/work.mjs'
import { MAX_SUPPLY, dailyEmissionForDay, releasedSupplyAfterDays } from './emission.mjs'

const DAY = 86400n
const launch = 1893456000n // 2030-01-01 UTC
const bond = parseEther('0.01')
const policy = keccak256(toHex('test-policy'))
const data = keccak256(toHex('fixture'))
const folder = 'contracts/v4'
const fixturePath = 'research/v4/fixtures/TestNitroValidator.sol'
const emissionFixturePath = 'research/v4/fixtures/TestEmissionDistributor.sol'
const measuredImage = '0x' + '12'.repeat(48)
const tokenUnit = parseEther('1')

function compile() {
  const sources = Object.fromEntries(fs.readdirSync(folder).filter(x => x.endsWith('.sol')).map(name => {
    const path = folder + '/' + name
    return [path, { content: fs.readFileSync(path, 'utf8') }]
  }))
  sources[fixturePath] = { content: fs.readFileSync(fixturePath, 'utf8') }
  sources[emissionFixturePath] = { content: fs.readFileSync(emissionFixturePath, 'utf8') }
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }), { import(path) {
    const file = [path, 'node_modules/' + path].find(p => fs.existsSync(p))
    return file ? { contents: fs.readFileSync(file, 'utf8') } : { error: 'Missing ' + path }
  } }))
  assert.deepEqual(output.errors?.filter(x => x.severity === 'error') ?? [], [])
  return output.contracts
}

async function startChain(t) {
  const child = spawn(process.env.ANVIL_BIN || 'anvil',
    ['--host', '127.0.0.1', '--port', '0', '--timestamp', String(launch - DAY), '--hardfork', 'cancun'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => child.kill())
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Anvil startup timed out')), 15000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(Error('Anvil exited: ' + code)) })
    createInterface({ input: child.stdout }).on('line', line => {
      const match = /Listening on (127\.0\.0\.1:\d+)/.exec(line)
      if (match) { clearTimeout(timer); resolve('http://' + match[1]) }
    })
  })
  return createTestClient({ chain: foundry, mode: 'anvil', transport: http(url), pollingInterval: 10,
    cacheTime: 0 }).extend(publicActions).extend(walletActions)
}

test('V4 local EVM', async t => {
  const artifacts = compile()
  const client = await startChain(t)
  const [admin, alice, bob, carol] = await client.getAddresses()
  async function deploy(name, args, source = folder + '/' + name + '.sol') {
    const { abi, evm } = artifacts[source][name]
    const hash = await client.deployContract({ account: admin, abi, bytecode: '0x' + evm.bytecode.object, args })
    const receipt = await client.waitForTransactionReceipt({ hash })
    assert.equal(receipt.status, 'success', name)
    return { address: receipt.contractAddress, abi }
  }
  const token = await deploy('TokenCastV4', [admin, launch])
  const staking = await deploy('MineCastStakingV4', [token.address])
  const dao = await deploy('MineCastMonthlyDaoV4', [token.address, staking.address])
  const issuer = privateKeyToAccount(generatePrivateKey())
  const validator = await deploy('TestNitroValidator', [issuer.address], fixturePath)
  const mining = await deploy('MineCastDailyDistributorV4', [
    token.address, staking.address, dao.address, bond, policy, validator.address, measuredImage,
  ])
  const read = (c, fn, args = []) => client.readContract({ ...c, functionName: fn, args })
  async function send(c, fn, args = [], account = admin, value = 0n) {
    const request = { ...c, functionName: fn, args, account, value }
    // Checkpoint lookup cost can change between estimation and the mined block.
    const estimate = await client.estimateContractGas(request)
    const hash = await client.writeContract({ ...request, gas: estimate + estimate / 5n })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      const tx = await client.getTransaction({ hash })
      const trace = await client.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] })
      assert.fail(fn + ' failed: ' + trace.error + ' ' + (trace.output ?? '') + ' gas ' + receipt.gasUsed + '/' + tx.gas)
    }
  }
  async function denied(c, fn, args, account, error, value = 0n) {
    await assert.rejects(client.simulateContract({ ...c, account, functionName: fn, args, value }), e => {
      assert.match(e.message, new RegExp(error))
      return true
    })
  }
  async function at(timestamp) {
    await client.setNextBlockTimestamp({ timestamp })
    await client.mine({ blocks: 1 })
  }
  async function attest(digest, timestamp, pcr0 = measuredImage, signer = issuer, moduleId = data) {
    const tbs = concatHex([toHex(timestamp * 1000n, { size: 8 }), pcr0, digest, moduleId])
    return { tbs, signature: await signer.sign({ hash: keccak256(tbs) }), hints: '0x' }
  }
  async function submit(day, root, amount, reporter = admin, uri = 'ipfs://fixture', dataHash = data, rosterHash = zeroHash) {
    const digest = reportDigest({ chainId: 31337n, distributor: mining.address, policyHash: policy,
      reporter, day, cutoff: launch + (day + 1n) * DAY, nonce: await read(mining, 'reportNonce', [day]),
      root, allocated: amount, dataHash, dataURI: uri, rosterHash })
    const proof = await attest(digest, await latestTime())
    const request = await prepareSubmission(client, mining.address, reporter,
      { day, root, allocated: amount, dataHash, dataURI: uri, proof })
    const hash = await client.writeContract(request)
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success')
  }
  const challenge = id => send(mining, 'challenge', [id, data, 'ipfs://evidence'], carol, bond)
  const resolve = day => send(mining, 'activateDay', [day])
  const latestTime = async () => (await client.getBlock()).timestamp
  await send(token, 'finalizeDistributor', [mining.address])

  const workWindow = await read(mining, 'WORK_WINDOW')
  await at(launch + DAY + workWindow)
  const cap = await read(token, 'dailyEmissionForDay', [0n])
  const a = 400n * tokenUnit, b = 200n * tokenUnit
  const leafA = claimLeaf(31337n, mining.address, 0n, 1, alice, a)
  const leafB = claimLeaf(31337n, mining.address, 0n, 2, bob, b)
  await submit(0n, hashPair(leafA, leafB), a + b)
  await denied(mining, 'activateDay', [0n], admin, 'InvalidPhase')
  await at(launch + 3n * DAY + workWindow + 60n)
  await resolve(0n)
  const baseline = await client.snapshot()
  let checkpoint = baseline
  async function scenario(name, fn) {
    await t.test(name, async () => {
      await client.revert({ id: checkpoint })
      checkpoint = await client.snapshot()
      await fn()
    })
  }
  async function claimAndStake() {
    await send(mining, 'claim', [0n, 1n, a, [leafB]], alice)
    await send(mining, 'claim', [0n, 2n, b, [leafA]], bob)
    for (const [who, amount] of [[alice, a], [bob, b]]) {
      await send(token, 'approve', [staking.address, amount], who)
      await send(staking, 'stake', [amount], who)
    }
  }

  await scenario('onchain daily decay and calendar budgets match the node calculator', async () => {
    assert.equal(await read(token, 'DAILY_DECAY_BPS'), 50n)
    assert.equal(await read(token, 'BASE_DAILY_EMISSION'), parseEther('105000000'))
    assert.equal(await read(token, 'MAX_SUPPLY'), MAX_SUPPLY)
    assert.equal(await read(mining, 'MAX_MINER_BPS'), 100n)
    for (const day of [0n, 1n, 29n, 59n, 137n, 138n, 271n, 272n, 364n, 729n, 918n, 1824n, 3650n, 12000n, (1n << 256n) - 1n]) {
      assert.equal(await read(token, 'dailyEmissionForDay', [day]), dailyEmissionForDay(day))
      assert.equal(await read(token, 'releasedSupplyAfterDays', [day]), releasedSupplyAfterDays(day))
    }
    assert.equal(await read(token, 'releasedSupply'), releasedSupplyAfterDays((await latestTime() - launch) / DAY))
    const gas = await client.estimateContractGas({ ...token, account: admin,
      functionName: 'dailyEmissionForDay', args: [(1n << 256n) - 1n] })
    assert.ok(gas < 300000n, 'far-future queries must not loop over every elapsed day')
  })

  await scenario('calendar and daily mint caps survive burns, skipped days and caller attempts', async () => {
    const start = await latestTime() + DAY
    const isolated = await deploy('TokenCastV4', [admin, start])
    const deployedDriver = await deploy('TestEmissionDistributor', [isolated.address], emissionFixturePath)
    // Decode token errors that bubble through the test-only distributor.
    const driver = { ...deployedDriver,
      abi: [...deployedDriver.abi, ...isolated.abi.filter(item => item.type === 'error')] }
    await send(isolated, 'finalizeDistributor', [driver.address])
    assert.equal(await read(isolated, 'releasedSupply'), 0n)
    await denied(driver, 'issue', [0n, alice, 1n], alice, 'IssuanceExceeded')
    await at(start + DAY - 1n)
    await denied(driver, 'issue', [0n, alice, 1n], alice, 'IssuanceExceeded')
    await at(start + DAY)
    const first = dailyEmissionForDay(0)
    assert.equal(await read(isolated, 'releasedSupply'), first)
    await denied(isolated, 'issue', [0n, alice, 1n], alice, 'Unauthorized')
    await denied(driver, 'issue', [1n, alice, 1n], alice, 'IssuanceExceeded')
    await denied(driver, 'issue', [0n, alice, first + 1n], alice, 'IssuanceExceeded')
    await send(driver, 'issue', [0n, alice, first])
    await send(isolated, 'burn', [first / 2n], alice)
    assert.equal(await read(isolated, 'cumulativeMinted'), first)
    await denied(driver, 'issue', [0n, alice, 1n], alice, 'IssuanceExceeded')
    await at(start + 2n * DAY)
    const second = dailyEmissionForDay(1)
    await denied(driver, 'issue', [1n, alice, first], alice, 'IssuanceExceeded')
    await send(driver, 'issue', [1n, alice, second])
    await at(start + 4n * DAY)
    const fourth = dailyEmissionForDay(3)
    await denied(driver, 'issue', [3n, alice, fourth + dailyEmissionForDay(2)], alice, 'IssuanceExceeded')
    await send(driver, 'issue', [3n, alice, fourth])
    assert.equal(await read(isolated, 'mintedForDay', [2n]), 0n)
    assert.equal(await read(isolated, 'cumulativeMinted'), first + second + fourth)
    assert.equal(await read(isolated, 'totalSupply'), first / 2n + second + fourth)
    assert.equal(await read(isolated, 'releasedSupply'), releasedSupplyAfterDays(4))
  })

  await scenario('the 1% miner limit follows each decaying day, including day 272', async () => {
    for (const day of [2n, 272n]) {
      await at(launch + (day + 1n) * DAY + workWindow + 300n)
      const pool = await read(token, 'dailyEmissionForDay', [day])
      const limit = pool / 100n
      const valid = claimLeaf(31337n, mining.address, day, 1, alice, limit)
      const over = claimLeaf(31337n, mining.address, day, 2, bob, limit + 1n)
      // A faulty root must not bypass the contract's independently enforced cap.
      await submit(day, hashPair(valid, over), limit * 2n + 1n)
      await at((await latestTime()) + 2n * DAY + 2n)
      const beforeStake = await read(token, 'balanceOf', [staking.address])
      const beforeTreasury = await read(token, 'balanceOf', [dao.address])
      await resolve(day)
      const surplus = pool - limit * 2n - 1n
      assert.equal(await read(token, 'balanceOf', [staking.address]) - beforeStake, surplus * 5n / 100n)
      assert.equal(await read(token, 'balanceOf', [dao.address]) - beforeTreasury, surplus - surplus * 5n / 100n)
      await denied(mining, 'claim', [day, 2n, limit + 1n, [valid]], bob, 'InvalidClaim')
      const before = await read(token, 'balanceOf', [alice])
      await send(mining, 'claim', [day, 1n, limit, [over]], alice)
      assert.equal(await read(token, 'balanceOf', [alice]) - before, limit)
      await denied(mining, 'claim', [day, 1n, limit, [over]], alice, 'AlreadyClaimed')
      assert.equal(await read(token, 'mintedForDay', [day]), pool - limit - 1n)
    }
  })

  await scenario('24h claim, recipient binding, daily surplus and irreversible monthly close', async () => {
    const unused = cap - a - b
    assert.equal(await read(staking, 'scheduledRewards', [1n]), unused * 5n / 100n)
    assert.equal(await read(token, 'balanceOf', [dao.address]), unused - unused * 5n / 100n)
    await denied(mining, 'claim', [0n, 1n, a, [leafB]], carol, 'InvalidClaim')
    const close = await read(mining, 'claimEnd', [0n])
    await at(close - 10n)
    await send(mining, 'claim', [0n, 1n, a, [leafB]], alice)
    await denied(mining, 'claim', [0n, 1n, a, [leafB]], alice, 'AlreadyClaimed')
    await at(close)
    await denied(mining, 'claim', [0n, 2n, b, [leafA]], bob, 'InvalidClaim')
    assert.equal(await read(token, 'mintedForDay', [0n]), cap - b)
    const feb = launch + 31n * DAY
    await denied(mining, 'finalizeMonth', [feb], alice, 'MonthNotReady')
    await at(feb + 10n * DAY)
    await send(mining, 'finalizeMonth', [feb])
    assert.equal(await read(mining, 'totalClaimedByMonth', [203001n]), a)
    await denied(mining, 'finalizeMonth', [feb], alice, 'MonthNotReady')
    const noProof = { tbs: '0x', signature: '0x', hints: '0x' }
    await denied(mining, 'submit', [1n, leafA, a, data, 'uri', noProof], alice, 'InvalidPhase', bond)
  })

  await scenario('inconclusive dispute, replacement, public proofs and bond withdrawal', async () => {
    await submit(2n, zeroHash, 0n)
    await challenge(2n)
    await denied(mining, 'activateDay', [2n], admin, 'InvalidPhase')
    await at((await latestTime()) + 2n * DAY + 2n)
    await resolve(2n)
    assert.equal(await read(mining, 'dayActivated', [2n]), false)
    const miners = [alice, bob, carol].map((wallet, i) => ({ wallet, fid: i + 1, followers: 1000 * (i + 1) }))
    const pool = await read(token, 'dailyEmissionForDay', [2n])
    const report = buildSnapshot({ chainId: 31337, distributor: mining.address, day: 2, poolWei: pool, miners })
    await submit(2n, report.root, BigInt(report.allocated))
    await at((await latestTime()) + 2n * DAY + 2n)
    await resolve(2n)
    for (const claim of report.claims) {
      await send(mining, 'claim', [2n, claim.fid, BigInt(claim.amount), claim.proof], claim.wallet)
    }
    assert.equal(await read(token, 'mintedForDay', [2n]), pool)
    assert.equal(await read(mining, 'bondCredit', [carol]), bond)
    await send(mining, 'withdrawBond', [carol], carol)
    await denied(mining, 'withdrawBond', [carol], carol, 'InvalidPhase')
  })

  await scenario('stakers earn funded epoch without spending principal', async () => {
    await claimAndStake()
    await denied(staking, 'withdraw', [1n], alice, 'Locked')
    await at(launch + 30n * DAY + 60n)
    await send(staking, 'skipEpoch', [0n])
    await send(staking, 'snapshotEpoch', [1n])
    await at(launch + 60n * DAY + 60n)
    await send(staking, 'finalizeEpoch', [1n])
    const reward = (cap - a - b) * 5n / 100n
    await send(staking, 'claim', [1n], alice)
    assert.equal(await read(token, 'balanceOf', [alice]), reward * a / (a + b))
    await denied(staking, 'claim', [1n], alice, 'AlreadyClaimed')
    await send(staking, 'withdraw', [a], alice)
    assert.equal(await read(staking, 'totalStaked'), b)
  })

  await scenario('last mining day belongs to the old month even when claimed in the new month', async () => {
    const feb = launch + 31n * DAY
    const day = 30n
    await at(feb + 3n * DAY)
    await submit(day, claimLeaf(31337n, mining.address, day, 7, bob, b), b)
    await at(feb + 8n * DAY - 60n)
    await resolve(day)
    await denied(mining, 'finalizeMonth', [feb], admin, 'MonthNotReady')
    await at((await read(mining, 'claimEnd', [day])) - 10n)
    await send(mining, 'claim', [day, 7n, b, []], bob)
    await at(feb + 10n * DAY)
    await send(mining, 'finalizeMonth', [feb])
    assert.equal(await read(mining, 'claimedByMonth', [203001n, bob]), b)
    assert.equal(await read(mining, 'totalClaimedByMonth', [203002n]), 0n)
  })

  await scenario('rejected and stale reports cannot issue tokens', async () => {
    await claimAndStake()
    await at(launch + 35n * DAY + workWindow)
    await send(staking, 'activateGovernancePower', [], bob)
    await submit(34n, leafB, b)
    await challenge(2n)
    await send(mining, 'voteOnReport', [2n, false], bob)
    await at((await latestTime()) + 2n * DAY + 2n)
    await resolve(34n)
    assert.equal(await read(mining, 'bondCredit', [carol]), 2n * bond)
    await submit(34n, leafB, b)
    await at(launch + 43n * DAY)
    await resolve(34n)
    assert.equal(await read(mining, 'dayActivated', [34n]), false)
    assert.equal(await read(token, 'mintedForDay', [34n]), 0n)
  })

  await scenario('a monthly vote with no turnout releases exactly its reservation', async () => {
    await claimAndStake()
    const feb = launch + 31n * DAY
    await at(feb + 10n * DAY)
    await send(mining, 'finalizeMonth', [feb])
    await send(dao, 'openMonthlyVote')
    const supply = await read(token, 'totalSupply')
    assert.equal(await read(dao, 'reserved'), (a + b) / 20n)
    await at((await latestTime()) + 7n * DAY + 2n)
    await send(dao, 'settle', [203002n])
    assert.equal(await read(dao, 'reserved'), 0n)
    assert.equal(await read(token, 'totalSupply'), supply)
    await denied(dao, 'settle', [203002n], admin, 'InvalidRound')
  })

  await scenario('DAO burns then airdrops using frozen months, mature stake and unique ballots', async () => {
    await claimAndStake()
    await denied(staking, 'activateGovernancePower', [], alice, 'GovernanceLockActive')
    await at(launch + 35n * DAY + workWindow)
    await send(staking, 'activateGovernancePower', [], alice)
    await send(staking, 'activateGovernancePower', [], bob)
    // A contested February allocation is accepted by mature stake.
    const day = 34n
    await submit(day, claimLeaf(31337n, mining.address, day, 1, alice, a), a)
    await challenge(2n)
    await send(mining, 'voteOnReport', [2n, true], alice)
    await send(mining, 'voteOnReport', [2n, false], bob)
    await denied(mining, 'voteOnReport', [2n, false], alice, 'InvalidPhase')
    await at((await latestTime()) + 2n * DAY + 2n)
    await resolve(day)
    await send(mining, 'claim', [day, 1n, a, []], alice)
    assert.equal(await read(mining, 'bondCredit', [admin]), 3n * bond)
    const feb = launch + 31n * DAY
    await at(feb + 10n * DAY)
    await send(mining, 'finalizeMonth', [feb])
    await send(dao, 'openMonthlyVote')
    await send(dao, 'vote', [203002n, true], alice)
    await denied(dao, 'vote', [203002n, true], alice, 'InvalidVote')
    await send(staking, 'withdraw', [a], alice)
    await send(token, 'transfer', [carol, a], alice)
    await send(token, 'approve', [staking.address, a], carol)
    await send(staking, 'stake', [a], carol)
    await denied(dao, 'vote', [203002n, true], carol, 'InvalidVote')
    const preBurn = await read(token, 'totalSupply')
    await at((await latestTime()) + 7n * DAY + 60n)
    await denied(dao, 'settle', [203002n], admin, 'InvalidRound')
    await at((await latestTime()) + 3n * DAY)
    await send(dao, 'settle', [203002n])
    assert.equal(preBurn - await read(token, 'totalSupply'), (a + b) / 20n)
    const march = feb + 28n * DAY
    await at(march + 10n * DAY)
    await send(mining, 'finalizeMonth', [march])
    await send(dao, 'openMonthlyVote')
    await send(dao, 'vote', [203003n, true], bob)
    await at((await latestTime()) + 10n * DAY + 60n)
    await send(dao, 'settle', [203003n])
    await denied(dao, 'claimAirdrop', [203003n], bob, 'NothingToClaim')
    const before = await read(token, 'balanceOf', [alice])
    await send(dao, 'claimAirdrop', [203003n], alice)
    assert.equal(await read(token, 'balanceOf', [alice]) - before, a / 10n)
    assert.equal(await read(dao, 'reserved'), 0n)
    await denied(dao, 'claimAirdrop', [203003n], alice, 'NothingToClaim')
  })

  await scenario('a bond cannot bypass image, source manifest, reporter or freshness checks', async () => {
    const report = [2n, leafB, b, data, 'ipfs://community-report']
    const digest = await read(mining, 'reportDigest', [carol, ...report])
    const now = await latestTime()
    const proof = await attest(digest, now)
    const reject = (fields, p, who = carol) => denied(mining, 'submit', [...fields, p], who, 'InvalidNodeProof', bond)
    await reject(report, proof, bob)
    await reject([2n, leafB, b + 1n, data, report[4]], proof)
    await reject([2n, leafB, b, policy, report[4]], proof)
    await reject([2n, leafA, b, data, report[4]], proof)
    await reject([2n, leafB, b, data, 'ipfs://elsewhere'], proof)
    await reject(report, await attest(digest, now, '0x' + '00'.repeat(48)))
    await reject(report, await attest(digest, now, '0x' + '34'.repeat(48)))
    await reject(report, await attest(digest, now + 3600n))
    await at(now + 901n)
    await reject(report, proof)
    assert.equal(await read(mining, 'currentReport', [2n]), 0n)
    const forged = await attest(digest, await latestTime(), measuredImage, privateKeyToAccount(generatePrivateKey()))
    const invalidFixtureSelector = keccak256(toHex('InvalidFixture()')).slice(0, 10)
    await denied(mining, 'submit', [...report, forged], carol, invalidFixtureSelector, bond)
    await submit(2n, leafB, b, carol, report[4])
    await send(mining, 'challenge', [2n, data, 'ipfs://evidence'], alice, bond)
    await at((await latestTime()) + 2n * DAY + 2n)
    await resolve(2n)
    assert.equal(await read(mining, 'currentReport', [2n]), 0n)
    await reject(report, await attest(digest, await latestTime()))
  })

  await scenario('two independent workers earn boosted claims when a third wallet submits', async () => {
    const day = 4n
    const cutoff = launch + (day + 1n) * DAY
    await at(cutoff)
    const miners = [
      { fid: 1, wallet: alice, followers: 1000 }, { fid: 2, wallet: bob, followers: 2000 },
      ...Array.from({ length: 120 }, (_, i) => ({ fid: i + 3, wallet: toHex(i + 1000, { size: 20 }), followers: 100000 })),
    ]
    const pool = await read(token, 'dailyEmissionForDay', [day])
    const input = { chainId: 31337, distributor: mining.address, day, poolWei: pool, miners, evidenceHash: data }
    const work = buildWorkManifest(input)
    const before = await client.getBlockNumber({ cacheTime: 0 })
    async function workerProof(fid, wallet, moduleId) {
      const digest = nodeWorkDigest({ ...input, policyHash: policy, cutoff, dataHash: work.dataHash, fid, wallet })
      return attest(digest, await latestTime(), measuredImage, issuer, moduleId)
    }
    const proofA = await workerProof(1, alice, data)
    const proofB = await workerProof(2, bob, policy)
    const recordArgs = (fid, proof) => [day, work.dataHash, BigInt(fid), proof]
    await denied(mining, 'recordNodeWork', recordArgs(1, proofA), bob, 'InvalidNodeProof')
    const request = await prepareSubmission(client, mining.address, alice,
      { kind: 'work', fid: 1, day, dataHash: work.dataHash, proof: proofA })
    const hash = await client.writeContract(request)
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success')
    await denied(mining, 'recordNodeWork', recordArgs(1, proofA), alice, 'DuplicateNodeWork')
    await denied(mining, 'recordNodeWork', recordArgs(2, await workerProof(2, bob, data)), bob, 'DuplicateNodeWork')
    await send(mining, 'recordNodeWork', recordArgs(2, proofB), bob)
    await denied(mining, 'submit', [day, leafA, a, work.dataHash, 'uri', proofA], admin, 'InvalidPhase', bond)
    await at(cutoff + workWindow)
    await denied(mining, 'recordNodeWork', recordArgs(3, proofA), carol, 'InvalidPhase')
    const { receipts, rosterHash } = await readNodeReceipts(client, mining.address, day, work.dataHash, before, 'latest')
    assert.throws(() => buildNodeRewardReport(work.bytes, receipts.slice(1), rosterHash), /receipts/)
    const final = buildNodeRewardReport(work.bytes, receipts, rosterHash)
    const sum = 120n * 100n + 30n + 50n
    assert.equal(BigInt(final.claims[0].amount), pool * 30n / sum)
    assert.equal(BigInt(final.claims[1].amount), pool * 50n / sum)
    const stale = reportDigest({ ...input, policyHash: policy, reporter: admin, cutoff, nonce: 0n,
      ...final, allocated: BigInt(final.allocated), dataURI: 'uri', rosterHash: zeroHash })
    await denied(mining, 'submit', [day, final.root, BigInt(final.allocated), work.dataHash, 'uri',
      await attest(stale, await latestTime())], admin, 'InvalidNodeProof', bond)
    await submit(day, final.root, BigInt(final.allocated), admin, 'uri', work.dataHash, rosterHash)
    await at((await latestTime()) + 2n * DAY + 2n)
    await resolve(day)
    for (const claim of final.claims.slice(0, 2)) {
      await send(mining, 'claim', [day, claim.fid, BigInt(claim.amount), claim.proof], claim.wallet)
      assert.equal(await read(token, 'balanceOf', [claim.wallet]), BigInt(claim.amount))
    }
  })

  await scenario('independent attested reporters can submit, finalize and supply claims from launch', async () => {
    const day = 2n
    const root = claimLeaf(31337n, mining.address, day, 7, bob, b)
    assert.equal(await read(staking, 'stakedBalance', [carol]), 0n)
    await submit(day, root, b, carol, 'ipfs://community-report')
    await at((await latestTime()) + 2n * DAY + 2n)
    await send(mining, 'activateDay', [day], alice)
    await send(mining, 'claim', [day, 7n, b, []], bob)
    assert.equal(await read(token, 'balanceOf', [bob]), b)
    await denied(token, 'issue', [day, bob, 1n], carol, 'Unauthorized')

    const nextDay = 4n
    await submit(nextDay, zeroHash, 0n, alice, 'ipfs://another-report')
    await at((await latestTime()) + 2n * DAY + 2n)
    await send(mining, 'activateDay', [nextDay], bob)
    assert.equal(await read(mining, 'dayActivated', [nextDay]), true)
  })
})
