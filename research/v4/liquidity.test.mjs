import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import solc from 'solc'
import { createTestClient, http, publicActions, walletActions, keccak256, parseEther,
  zeroAddress, zeroHash, encodeFunctionData, toHex } from 'viem'
import { foundry } from 'viem/chains'
import { MAX_SUPPLY, DEV_PREMINE, FIRST_DAY_POOL, miningPoolForDay, lifetimeCeilingAfterDays } from './node/bootstrap-model.mjs'

const folders = ['contracts/v4/open', 'contracts/v4/liquidity']
const fixture = 'research/v4/fixtures/TestLiquidityAssets.sol'
const DAY = 86400n
const start = 1893456000n
const eth = parseEther('1') // Test funding ONLY, not a real liquidity budget.
const liquidityTokens = parseEther('500000') // Only part of the owned tokens, no mint.
const uni = name => JSON.parse(fs.readFileSync(`node_modules/@uniswap/v2-core/build/${name}.json`, 'utf8'))
const factoryArtifact = uni('UniswapV2Factory'), pairArtifact = uni('UniswapV2Pair')
const hex = value => value.startsWith('0x') ? value : '0x' + value
const pairHash = keccak256(hex(pairArtifact.evm.deployedBytecode.object))

function compile() {
  const sources = Object.fromEntries(folders.flatMap(folder => fs.readdirSync(folder).filter(x => x.endsWith('.sol')).map(name => {
    const path = `${folder}/${name}`
    return [path, { content: fs.readFileSync(path, 'utf8') }]
  })))
  sources[fixture] = { content: fs.readFileSync(fixture, 'utf8') }
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  }), { import(path) {
    const file = [path, 'node_modules/' + path].find(p => fs.existsSync(p))
    return file ? { contents: fs.readFileSync(file, 'utf8') } : { error: 'Missing ' + path }
  } }))
  assert.deepEqual(result.errors?.filter(x => x.severity === 'error') ?? [], [])
  const all = Object.assign({}, ...Object.values(result.contracts))
  for (const name of ['TokenCastOpenV4', 'MineCastLiquidityLockerV4', 'PermanentLiquidityLockV4']) {
    assert.ok(all[name].evm.deployedBytecode.object.length / 2 <= 24576, `${name}: EIP-170`)
  }
  return all
}

async function chain(t) {
  const child = spawn(process.env.ANVIL_BIN || 'anvil', ['--host', '127.0.0.1', '--port', '0',
    '--timestamp', String(start), '--hardfork', 'cancun'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => child.kill())
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Anvil startup timed out')), 15000)
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

function sqrt(n) {
  let x = n, next = (n + 1n) / 2n
  while (next < x) { x = next; next = (x + n / x) / 2n }
  return x
}

test('V4 dev premine and optional later liquidity: real Uniswap V2 on local EVM', async t => {
  const a = compile(), c = await chain(t)
  const [admin, dev, buyer, outsider] = await c.getAddresses()
  const read = (contract, name, args = []) => c.readContract({ ...contract, functionName: name, args })
  async function deploy(name, args = []) {
    const item = typeof name === 'string' ? a[name] : name
    const hash = await c.deployContract({ account: admin, abi: item.abi, bytecode: hex(item.evm.bytecode.object), args })
    const r = await c.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success')
    return { address: r.contractAddress, abi: item.abi }
  }
  async function send(contract, name, args = [], account = admin, value = 0n) {
    const req = { ...contract, functionName: name, args, account, value }
    const gas = await c.estimateContractGas(req)
    // V2's _update may first write both price accumulators when the timestamp
    // advances between estimate and automining. Cover those two extra SSTOREs.
    const hash = await c.writeContract({ ...req, gas: gas + gas / 5n + 60_000n })
    const r = await c.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') {
      const trace = await c.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] })
      assert.fail(`${name}: estimated=${gas} used=${r.gasUsed} trace=${JSON.stringify(trace)}`)
    }
    return r
  }
  async function denied(contract, name, args, account, error, value = 0n) {
    await assert.rejects(c.simulateContract({ ...contract, functionName: name, args, account, value }), e => {
      assert.match(e.message, new RegExp(error)); return true
    })
  }
  async function at(timestamp) { await c.setNextBlockTimestamp({ timestamp }); await c.mine({ blocks: 1 }) }
  const miningStart = start + 10n * DAY
  const token = await deploy('TokenCastOpenV4', [dev, admin, miningStart])
  const factory = await deploy(factoryArtifact, [admin])
  const weth = await deploy('TestLiquidityWETH')
  const helperArgs = [token.address, factory.address, weth.address, pairHash]
  const minimumLp = sqrt(liquidityTokens * eth) - 1000n
  const params = (overrides = {}) => ({ tokenDesired: liquidityTokens, tokenMin: liquidityTokens, ethMin: eth,
    minLiquidity: minimumLp, deadline: start + 100n * DAY,
    maxInitialTokenReserve: liquidityTokens, maxInitialWethReserve: eth, ...overrides })
  async function helper() {
    const h = await deploy('MineCastLiquidityLockerV4', helperArgs)
    h.abi = [...h.abi, ...token.abi.filter(x => x.type === 'error')]
    return { h, pair: { address: await read(h, 'pair'), abi: pairArtifact.abi },
      locker: { address: await read(h, 'locker'), abi: a.PermanentLiquidityLockV4.abi } }
  }
  async function funded() {
    const ctx = await helper()
    await send(token, 'approve', [ctx.h.address, liquidityTokens], dev)
    await send(ctx.h, 'addLiquidityAndLock', [params()], dev, eth)
    return ctx
  }
  async function miningDriver() {
    const d = await deploy('TestLiquidityDistributor', [token.address])
    const driver = { ...d, abi: [...d.abi, ...token.abi.filter(x => x.type === 'error')] }
    await send(token, 'finalizeDistributor', [driver.address, factory.address]); return driver
  }
  let checkpoint = await c.snapshot()
  async function scenario(name, fn) {
    await t.test(name, async () => { await c.revert({ id: checkpoint }); checkpoint = await c.snapshot(); await fn() })
  }
  async function failedAdd(h, p = params(), value = eth, caller = dev) {
    const pair = { address: await read(h, 'pair'), abi: pairArtifact.abi }
    const snapshot = async () => Promise.all([read(token, 'balanceOf', [caller]), read(token, 'balanceOf', [pair.address]),
      read(weth, 'balanceOf', [pair.address]), read(pair, 'totalSupply'), read(token, 'cumulativeMinted'),
      c.getBalance({ address: h.address }), c.getBalance({ address: weth.address })])
    const before = await snapshot()
    const hash = await c.writeContract({ ...h, functionName: 'addLiquidityAndLock', args: [p], account: caller, value, gas: 8_000_000n })
    assert.equal((await c.waitForTransactionReceipt({ hash })).status, 'reverted')
    assert.deepEqual(await snapshot(), before)
  }

  await scenario('constructor mints exactly 2.1M to dev, no ETH/pool or repeat-premine function', async () => {
    assert.equal(await read(token, 'devWallet'), dev)
    assert.equal(await read(token, 'DEV_PREMINE'), DEV_PREMINE)
    assert.equal(await read(token, 'totalSupply'), DEV_PREMINE)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
    assert.equal(await read(token, 'balanceOf', [dev]), DEV_PREMINE)
    assert.equal(await read(token, 'balanceOf', [admin]), 0n)
    assert.equal(await read(factory, 'getPair', [token.address, weth.address]), zeroAddress)
    assert.equal(await read(token, 'releasedSupply'), DEV_PREMINE)
    const names = token.abi.filter(x => x.type === 'function').map(x => x.name)
    for (const fn of ['mint', 'mintInitialLiquidity', 'mintDevPremine', 'setDevWallet']) assert.ok(!names.includes(fn))
    await denied(token, 'issue', [0n, dev, 1n], dev, 'Unauthorized')
    await send(token, 'burn', [1n], dev)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
    assert.equal(await read(token, 'totalSupply'), DEV_PREMINE - 1n)
  })

  await scenario('invalid dev/admin/time and liquidity dependencies cannot deploy', async () => {
    for (const args of [[zeroAddress, admin, miningStart], [dev, zeroAddress, miningStart], [dev, admin, start]]) {
      await assert.rejects(deploy('TokenCastOpenV4', args))
    }
    for (const args of [
      [outsider, factory.address, weth.address, pairHash], [token.address, outsider, weth.address, pairHash],
      [token.address, factory.address, outsider, pairHash], [weth.address, factory.address, weth.address, pairHash],
      [token.address, factory.address, weth.address, zeroHash],
      [token.address, factory.address, weth.address, toHex(42, { size: 32 })],
    ]) await assert.rejects(deploy('MineCastLiquidityLockerV4', args))
    await assert.rejects(deploy('PermanentLiquidityLockV4', [outsider]))
  })

  await scenario('mining can issue before any DEX pair exists; dev/admin have no direct mint power', async () => {
    const driver = await miningDriver()
    assert.equal(await read(token, 'bootstrapAdmin'), zeroAddress)
    await denied(token, 'finalizeDistributor', [driver.address, factory.address], admin, 'AlreadyFinalized')
    await denied(driver, 'issue', [0n, dev, 1n], admin, 'IssuanceExceeded')
    await at(miningStart + DAY)
    await send(driver, 'issue', [0n, buyer, parseEther('10000')])
    assert.equal(await read(token, 'balanceOf', [buyer]), parseEther('10000'))
    assert.equal(await read(factory, 'getPair', [token.address, weth.address]), zeroAddress)
    for (const who of [dev, admin, outsider]) await denied(token, 'issue', [0n, who, 1n], who, 'Unauthorized')
  })

  await scenario('later liquidity spends owned tokens, creates no supply, locks new LP immediately', async () => {
    const { h, pair, locker } = await funded()
    assert.equal(keccak256(await c.getCode({ address: pair.address })), pairHash)
    assert.equal(await read(token, 'balanceOf', [dev]), DEV_PREMINE - liquidityTokens)
    assert.equal(await read(token, 'balanceOf', [pair.address]), liquidityTokens)
    assert.equal(await read(weth, 'balanceOf', [pair.address]), eth)
    assert.equal(await read(locker, 'lockedBalance'), minimumLp)
    assert.equal(await read(pair, 'totalSupply'), minimumLp + 1000n)
    for (const who of [dev, h.address]) assert.equal(await read(pair, 'balanceOf', [who]), 0n)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
    assert.equal(await read(token, 'totalSupply'), DEV_PREMINE)
    assert.equal(await c.getBalance({ address: h.address }), 0n)
  })

  await scenario('claimed mining tokens can fund liquidity without a special dev permission', async () => {
    const driver = await miningDriver()
    await at(miningStart + DAY)
    await send(driver, 'issue', [0n, buyer, liquidityTokens])
    const { h, locker } = await helper()
    await send(token, 'approve', [h.address, liquidityTokens], buyer)
    await send(h, 'addLiquidityAndLock', [params()], buyer, eth)
    assert.equal(await read(token, 'balanceOf', [buyer]), 0n)
    assert.equal(await read(locker, 'lockedBalance'), minimumLp)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE + liquidityTokens)
  })

  await scenario('no caller can spend another wallet allowance; bounds/allowance failures revert', async () => {
    const { h } = await helper()
    await send(token, 'approve', [h.address, liquidityTokens], dev)
    await denied(h, 'addLiquidityAndLock', [params()], outsider, 'allowance|Allowance|balance|Balance', eth)
    for (const overrides of [{ deadline: start - 1n }, { tokenMin: 0n }, { ethMin: 0n }, { minLiquidity: 0n },
      { tokenMin: liquidityTokens + 1n }, { ethMin: eth + 1n }, { tokenDesired: 1n << 112n }]) {
      await denied(h, 'addLiquidityAndLock', [params(overrides)], dev, 'InvalidParameters', eth)
    }
    await denied(h, 'addLiquidityAndLock', [params()], dev, 'InvalidParameters', 0n)
    await send(token, 'approve', [h.address, liquidityTokens - 1n], dev)
    await failedAdd(h)
  })

  await scenario('LP minimum and bad WETH credit roll back transfers, deposits, LP and approvals consumed', async () => {
    const { h } = await helper()
    await send(token, 'approve', [h.address, liquidityTokens], dev)
    await denied(h, 'addLiquidityAndLock', [params({ minLiquidity: minimumLp + 1n })], dev, 'LiquidityMismatch', eth)
    await failedAdd(h, params({ minLiquidity: minimumLp + 1n }))
    assert.equal(await read(token, 'allowance', [dev, h.address]), liquidityTokens)
    await send(weth, 'setShortMint', [1n])
    await denied(h, 'addLiquidityAndLock', [params()], dev, 'FundingMismatch', eth)
    await failedAdd(h)
  })

  await scenario('precreated empty pair: donated tokens/WETH are bounded and grant no LP to donor', async () => {
    await send(factory, 'createPair', [token.address, weth.address], outsider)
    const { h, pair, locker } = await helper()
    const donation = parseEther('0.01'), giftTokens = parseEther('10')
    await send(weth, 'deposit', [], outsider, donation)
    await send(weth, 'transfer', [pair.address, donation], outsider)
    await send(token, 'transfer', [pair.address, giftTokens], dev)
    await send(pair, 'sync') // Already synced gifts must not permanently block initialization.
    await send(token, 'approve', [h.address, liquidityTokens], dev)
    await denied(h, 'addLiquidityAndLock', [params()], dev, 'SlippageExceeded', eth)
    await failedAdd(h)
    await send(h, 'addLiquidityAndLock', [params({ maxInitialTokenReserve: liquidityTokens + giftTokens,
      maxInitialWethReserve: eth + donation })], dev, eth)
    assert.equal(await read(token, 'balanceOf', [pair.address]), liquidityTokens + giftTokens)
    assert.equal(await read(weth, 'balanceOf', [pair.address]), eth + donation)
    assert.equal(await read(pair, 'balanceOf', [outsider]), 0n)
    assert.equal(await read(locker, 'lockedBalance'), minimumLp)
  })

  await scenario('existing pool: repeated additions refund unused ETH or leave excess tokens in wallet', async () => {
    const { h, pair, locker } = await funded()
    await send(token, 'approve', [h.address, liquidityTokens * 2n], dev)
    const beforeEth = await c.getBalance({ address: dev })
    const r = await send(h, 'addLiquidityAndLock', [params({ maxInitialTokenReserve: 0n,
      maxInitialWethReserve: 0n })], dev, eth * 2n)
    assert.equal(beforeEth - await c.getBalance({ address: dev }), eth + r.gasUsed * r.effectiveGasPrice)
    const beforeTokens = await read(token, 'balanceOf', [dev])
    await send(h, 'addLiquidityAndLock', [params({ tokenMin: liquidityTokens / 2n, ethMin: eth / 2n,
      minLiquidity: minimumLp / 2n })], dev, eth / 2n)
    assert.equal(beforeTokens - await read(token, 'balanceOf', [dev]), liquidityTokens / 2n)
    assert.equal(await read(weth, 'balanceOf', [pair.address]), eth * 5n / 2n)
    assert.ok(await read(locker, 'lockedBalance') > minimumLp)
    for (const asset of [token, weth]) assert.equal(await read(asset, 'balanceOf', [h.address]), 0n)
    assert.equal(await c.getBalance({ address: h.address }), 0n)
  })

  await scenario('changed pool ratio is rejected by token/ETH minima', async () => {
    const { h, pair } = await funded()
    await send(token, 'approve', [h.address, liquidityTokens], dev)
    await send(weth, 'deposit', [], outsider, eth)
    await send(weth, 'transfer', [pair.address, eth], outsider)
    await denied(h, 'addLiquidityAndLock', [params()], dev, 'SlippageExceeded', eth)
    await failedAdd(h)
  })

  await scenario('WETH and ETH-refund callbacks cannot re-enter; rejected refund reverts the deposit', async () => {
    const { h, locker } = await funded()
    const provider = await deploy('TestLiquidityProvider')
    await send(token, 'transfer', [provider.address, liquidityTokens], dev)
    const callback = encodeFunctionData({ abi: h.abi, functionName: 'addLiquidityAndLock', args: [params()] })
    const beforeLP = await read(locker, 'lockedBalance')
    const hash = await c.writeContract({ ...provider, functionName: 'fund', args: [h.address, params(), true, '0x'],
      account: admin, value: eth * 2n, gas: 8_000_000n })
    assert.equal((await c.waitForTransactionReceipt({ hash })).status, 'reverted')
    assert.equal(await read(token, 'balanceOf', [provider.address]), liquidityTokens)
    assert.equal(await read(locker, 'lockedBalance'), beforeLP)
    await send(weth, 'setCallback', [h.address, callback])
    await send(provider, 'fund', [h.address, params(), false, callback], admin, eth * 2n)
    assert.equal(await read(provider, 'reentrySucceeded'), false)
    assert.equal(await read(weth, 'reentrySucceeded'), false)
    assert.equal(await c.getBalance({ address: provider.address }), eth)
    assert.equal(await c.getBalance({ address: h.address }), 0n)
  })

  await scenario('LP has no withdrawal/approval/recovery path now or after 100 years', async () => {
    const { pair, locker } = await funded()
    assert.deepEqual(locker.abi.filter(x => x.type === 'function').map(x => x.name).sort(), ['lockedBalance', 'lpToken'])
    for (const name of ['withdraw()', 'unlock()', 'rescue()', 'execute()', 'upgradeTo(address)']) {
      await assert.rejects(c.call({ account: dev, to: locker.address, data: keccak256(toHex(name)).slice(0, 10) }))
    }
    await denied(pair, 'transferFrom', [locker.address, dev, 1n], dev, 'revert|underflow|ds-math')
    await denied(pair, 'burn', [dev], dev, 'INSUFFICIENT_LIQUIDITY_BURNED')
    await at(start + 100n * 365n * DAY)
    assert.equal(await read(locker, 'lockedBalance'), minimumLp)
    assert.equal(await read(pair, 'allowance', [locker.address, dev]), 0n)
    await denied(pair, 'transferFrom', [locker.address, dev, 1n], dev, 'revert|underflow|ds-math')
  })

  async function buy(pair, input = parseEther('0.01')) {
    const tokenReserve = await read(token, 'balanceOf', [pair.address]), ethReserve = await read(weth, 'balanceOf', [pair.address])
    const output = input * 997n * tokenReserve / (ethReserve * 1000n + input * 997n)
    await send(weth, 'deposit', [], buyer, input); await send(weth, 'transfer', [pair.address, input], buyer)
    const tokenFirst = (await read(pair, 'token0')).toLowerCase() === token.address.toLowerCase()
    await send(pair, 'swap', [tokenFirst ? output : 0n, tokenFirst ? 0n : output, buyer, '0x'], buyer)
    return { output, tokenFirst }
  }

  await scenario('locked liquidity permits buys/sells; other LPs and protocol fees retain only their shares', async () => {
    await send(factory, 'setFeeTo', [outsider])
    const { pair, locker } = await funded()
    await at((await c.getBlock()).timestamp + 60n)
    const { output, tokenFirst } = await buy(pair, parseEther('0.1'))
    const input = output / 2n
    const ethOut = input * 997n * await read(weth, 'balanceOf', [pair.address])
      / ((await read(token, 'balanceOf', [pair.address])) * 1000n + input * 997n)
    await send(token, 'transfer', [pair.address, input], buyer)
    await send(pair, 'swap', [tokenFirst ? 0n : ethOut, tokenFirst ? ethOut : 0n, buyer, '0x'], buyer)
    const addToken = output / 4n
    const addWeth = addToken * await read(weth, 'balanceOf', [pair.address]) / await read(token, 'balanceOf', [pair.address]) + 1n
    await send(weth, 'deposit', [], buyer, addWeth)
    await send(weth, 'transfer', [pair.address, addWeth], buyer)
    await send(token, 'transfer', [pair.address, addToken], buyer)
    await send(pair, 'mint', [buyer], buyer)
    for (const who of [buyer, outsider]) {
      const ownLP = await read(pair, 'balanceOf', [who]); assert.ok(ownLP > 0n)
      await send(pair, 'transfer', [pair.address, ownLP], who); await send(pair, 'burn', [who], who)
    }
    assert.equal(await read(locker, 'lockedBalance'), minimumLp)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE)
    assert.ok(await read(pair, 'price0CumulativeLast') > 0n)
    assert.ok(await read(pair, 'price1CumulativeLast') > 0n)
  })

  await scenario('99.99% mining calendar matches model; burns/skipped days never replenish caps', async () => {
    assert.equal(await read(token, 'MAX_SUPPLY'), MAX_SUPPLY)
    const days = [0n, 1n, 2n, 29n, 137n, 364n, 918n, 3650n, 12000n, (1n << 256n) - 1n]
    let seed = 42n
    for (let i = 0; i < 32; i++) { seed = (seed * 1664525n + 1013904223n) % (1n << 32n); days.push(seed % 18000n) }
    for (const day of days) {
      assert.equal(await read(token, 'dailyEmissionForDay', [day]), miningPoolForDay(day))
      assert.equal(await read(token, 'releasedSupplyAfterDays', [day]), lifetimeCeilingAfterDays(day))
    }
    const badDriver = await deploy('TestLiquidityDistributor', [weth.address])
    await denied(token, 'finalizeDistributor', [badDriver.address, factory.address], admin, 'InvalidConfiguration')
    await denied(token, 'finalizeDistributor', [badDriver.address, factory.address], dev, 'Unauthorized')
    const driver = await miningDriver()
    await at(miningStart + DAY - 1n)
    await denied(driver, 'issue', [0n, buyer, 1n], admin, 'IssuanceExceeded')
    await at(miningStart + DAY)
    await denied(driver, 'issue', [0n, buyer, FIRST_DAY_POOL + 1n], admin, 'IssuanceExceeded')
    await send(driver, 'issue', [0n, buyer, FIRST_DAY_POOL])
    await send(token, 'burn', [FIRST_DAY_POOL], buyer)
    assert.equal(await read(token, 'totalSupply'), DEV_PREMINE)
    assert.equal(await read(token, 'cumulativeMinted'), DEV_PREMINE + FIRST_DAY_POOL)
    await denied(driver, 'issue', [0n, buyer, 1n], admin, 'IssuanceExceeded')
    await at(miningStart + 3n * DAY)
    await denied(driver, 'issue', [2n, buyer, miningPoolForDay(2n) + miningPoolForDay(1n)], admin, 'IssuanceExceeded')
    await send(driver, 'issue', [2n, buyer, miningPoolForDay(2n)])
    assert.equal(await read(token, 'mintedForDay', [1n]), 0n)
  })
})
