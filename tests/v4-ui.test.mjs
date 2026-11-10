import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './v4-test-loader.mjs'

const state = await loadModule('src/lib/v4/state.ts')
const { parseV4Config, deploymentKey } = await loadModule('src/lib/v4/config.ts')
const { confirmV4Transaction, actionCall, isRejection } = await loadModule('src/lib/v4/transactions.ts', {
  '../farcaster': 'export const ethereumProviderForChain = () => { throw Error("No wallet needed") }',
})
const keys = ['TOKEN', 'DISTRIBUTOR', 'STAKING', 'DAO', 'REGISTRY']
const env = Object.fromEntries(keys.map((k, i) => ['VITE_V4_' + k + '_ADDRESS', '0x' + String(i + 1).repeat(40)]))
env.VITE_V4_CHAIN_ID = '84532'
const config = parseV4Config(env).config

test('V4 configuration never falls back to the legacy CA or chain', () => {
  assert.equal(parseV4Config({ VITE_TOKENCAST_ADDRESS: env.VITE_V4_TOKEN_ADDRESS }).config, null)
  for (const key of keys) assert.equal(parseV4Config({ ...env, ['VITE_V4_' + key + '_ADDRESS']: '' }).config, null)
  assert.equal(parseV4Config({ ...env, VITE_V4_CHAIN_ID: '1' }).config, null)
  assert.equal(parseV4Config({ ...env, VITE_V4_DAO_ADDRESS: env.VITE_V4_TOKEN_ADDRESS }).config, null)
  assert.equal(parseV4Config({ ...env, VITE_V4_RPC_URL: 'javascript:alert(1)' }).config, null)
  assert.equal(parseV4Config({ ...env, VITE_V4_RPC_URL: 'http://example.com' }).config, null)
  assert.ok(parseV4Config({ ...env, VITE_V4_RPC_URL: 'http://127.0.0.1:8545' }).config)
  assert.notEqual(deploymentKey(config), deploymentKey({ ...config, chainId: 8453 }))
})

test('session, report review, activation and expiry are separate phases', () => {
  const d = { day: 0n, claimed: false, claimEnd: 0n, amount: 0n, contested: false, end: 86400n,
    resultWindow: 8n * state.DAY, certifiedAt: 0n, reviewPeriod: 2n * state.DAY, published: 0n, leafCount: 2n }
  const session = { ends_at: new Date(100000 * 1000).toISOString() }
  assert.equal(state.miningPhase(d, 99999n, session), 'mining')
  assert.equal(state.miningPhase(d, 100000n, session), 'waiting')
  const cert = { ...d, certifiedAt: 200000n }
  assert.equal(state.miningPhase(cert, 200100n, session), 'publishing')
  const published = { ...cert, published: 2n }
  assert.equal(state.miningPhase(published, 200100n, session), 'review')
  assert.equal(state.miningPhase(published, 372800n, session), 'activate')
  assert.equal(state.miningPhase({ ...published, contested: true }, 372800n), 'contested')
  assert.equal(state.miningPhase(d, d.end + d.resultWindow), 'missed')
  const active = { ...published, claimEnd: 500000n, amount: 100n }
  assert.equal(state.miningPhase(active, 499999n), 'claimable')
  assert.equal(state.miningPhase(active, 500000n), 'expired')
  assert.equal(state.miningPhase({ ...active, claimed: true }, 500001n), 'claimed')
  assert.equal(state.miningPhase({ ...active, amount: 0n }, 499999n), 'excluded')
  assert.equal(state.phaseDeadline(active, 'claimable'), active.claimEnd)
})

test('countdown derives from timestamps after mobile sleep; UTC month and large amounts are exact', () => {
  assert.equal(state.countdown(86400n, 0n), '24:00:00')
  assert.equal(state.countdown(86400n, 86339n), '00:01:01')
  assert.equal(state.countdown(86400n, 90000n), '00:00:00')
  assert.equal(state.previousMonth(203001n), 202912n)
  assert.equal(state.monthAt(state.monthStart(203003n)), 203003n)
  assert.equal(state.validMonth('203013'), false)
  assert.equal(state.tokens(21000000000123456789123456789n), '21,000,000,000.12')
})

const pending = { hash: '0x' + 'a'.repeat(64), account: config.token, to: config.distributor, data: '0x1234', label: 'Mining claim' }
async function confirmation({ status = 'success', change, fail = false, replacement } = {}) {
  const updates = [], saved = []
  const client = {
    waitForTransactionReceipt: async options => {
      if (fail) throw Error('timeout')
      if (replacement) options.onReplaced(replacement)
      return { transactionHash: replacement?.transaction.hash ?? pending.hash, status }
    },
    getTransaction: async () => ({ from: pending.account, to: pending.to, input: pending.data, ...change }),
  }
  const result = await confirmV4Transaction(client, pending, x => updates.push(x), x => saved.push(x))
  return { result, updates, saved }
}
test('only the correct successful receipt reports confirmed', async () => {
  const r = await confirmation()
  assert.equal(r.result, true); assert.equal(r.updates.at(-1).status, 'confirmed'); assert.equal(r.saved.at(-1), null)
  for (const change of [{ to: config.dao }, { from: config.registry }, { input: '0x5678' }]) {
    const failed = await confirmation({ change }); assert.equal(failed.result, false); assert.equal(failed.updates.at(-1).status, 'error')
  }
  assert.equal((await confirmation({ status: 'reverted' })).result, false)
})
test('timeouts retain pending status and repricing does not masquerade as cancellation', async () => {
  const slow = await confirmation({ fail: true })
  assert.equal(slow.updates.at(-1).status, 'pending'); assert.equal(slow.saved.length, 0)
  const hash = '0x' + 'b'.repeat(64)
  const repriced = await confirmation({ replacement: { reason: 'repriced', transaction: { hash } } })
  assert.equal(repriced.result, true); assert.equal(repriced.saved[0].hash, hash)
  assert.equal((await confirmation({ replacement: { reason: 'cancelled', transaction: { hash } } })).result, false)
})
test('all action targets are V4 components and wallet cancellation is handled', () => {
  assert.equal(actionCall(config, { kind: 'claim', day: 7n }).address, config.distributor)
  assert.deepEqual(actionCall(config, { kind: 'claim', day: 7n }).args, [7n])
  assert.equal(actionCall(config, { kind: 'stake', amount: 1n }).address, config.staking)
  assert.equal(actionCall(config, { kind: 'vote', month: 203001n, yes: true }).address, config.dao)
  assert.throws(() => actionCall(config, { kind: 'stake', amount: 0n }))
  assert.equal(isRejection({ cause: { code: 4001 } }), true)
})
