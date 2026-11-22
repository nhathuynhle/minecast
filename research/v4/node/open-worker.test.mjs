import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zeroAddress, zeroHash } from 'viem'
import { collect, commitmentOf, pickAnnouncement, prewarm, withinTolerance } from './open-worker.mjs'

const network = 'FARCASTER_NETWORK_MAINNET', distributor = '0x' + 'd1'.repeat(20), token = '0x' + 'a0'.repeat(20)
const launch = 1893456000n, day1 = launch + 86400n, at = day1 + 3600n, ft = unix => Number(unix) - 1609459200
const wallet = n => '0x' + String(n).padStart(2, '0').repeat(20)
const cast = n => '0x' + String(n).padStart(2, '0').repeat(20)
const session = (fid, w = fid, startedAt = at) => ({ fid: BigInt(fid), wallet: wallet(w), castHash: cast(fid), startedAt })
// fid 1 valid node operator, 2 cast deleted, 3 wallet unverified, 4 valid (also mined yesterday: sessions are
// whole UTC days, so they never overlap), 5 valid, 6 cast older than 24h, 7 absurd FID, 8 two wallets.
// Follower lists are [follower FID, follow age at session start].
const days = { 0: [session(4, 4, day1 - 3600n)], 1: [1, 2, 3, 4, 5, 6].map(f => session(f)).concat(
  [{ ...session(7), fid: 2n ** 63n }, session(8, 81, at + 10n), session(8, 80, at + 5n)]) }
// Day 1 is a Wednesday, so its tier week starts on Monday at day1 - 2 days; follows count up to 7 days before that.
const D = 86400n, good = n => Array.from({ length: n }, (_, i) => [1000 + i, 10n * D])
const followers = {
  1: [...good(9), [1100, 8n * D]], // 8 days old at the session but not 7 days before the week start: tier 0
  4: [],
  5: [...good(10), [1101, -10n]], // tier 10; a follow made after the session never counts
  8: [...good(9), [2500, 10n * D]], // FID 2500 registered 10 days ago: the 30-day account rule drops it
}
let ownCommit = true // whether the node key committed to yesterday's certified report on its own
const prevDigest = '0x' + 'ee'.repeat(32), nodeKey = '0x' + 'bb'.repeat(20), cutoff = launch + 2n * 86400n // day 1's cohort close

const client = { async readContract({ functionName, args }) {
  switch (functionName) {
    case 'token': return token
    case 'registry': return zeroAddress
    case 'distributorForDay': return distributor
    case 'sessionCount': return BigInt(days[args[0]].length)
    case 'sessionWallet': return days[args[0]][Number(args[1])].wallet
    case 'sessions': { const s = days[args[0]].find(x => x.wallet === args[1]); return [s.fid, s.castHash, s.startedAt, s.fid === 5n ? 3 : 0] }
    case 'sessionsHash': return '0x' + '5'.repeat(64)
    case 'dayInfo': return { digest: prevDigest }
    case 'certificate': return [1n, cutoff - 100n]
    case 'keysOf': return args[0] === wallet(1) ? [nodeKey] : []
    case 'signedAt': return args[1] === nodeKey ? cutoff - 50n : 0n
    case 'commitments': return args[1] === nodeKey && ownCommit ? commitmentOf(prevDigest, nodeKey) : zeroHash
  }
  throw Error('unexpected read ' + functionName)
} }

let castReads = 0
function snapchain(url) {
  const fid = Number(url.searchParams.get('fid') ?? url.searchParams.get('target_fid'))
  if (url.pathname === '/v1/castById') {
    castReads++
    if (fid === 2) return Response.json({ errCode: 'not_found' }, { status: 400 })
    return Response.json({ data: { fid, network, type: 'MESSAGE_TYPE_CAST_ADD', timestamp: ft(at - (fid === 6 ? 90000n : 60n)) } })
  }
  if (url.pathname === '/v1/verificationsByFid') return Response.json({ messages: fid === 3 ? [] : [{ data: { fid, network,
    type: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS', verificationAddAddressBody: { address: url.searchParams.get('address'), protocol: 'PROTOCOL_ETHEREUM' } } }] })
  // FIDs up to 2000 registered a year ago, 2001-3000 ten days ago, higher ones do not exist yet.
  if (url.pathname === '/v1/onChainEventsByFid') return Response.json({ events: fid > 3000 ? [] : [{ type: 'EVENT_TYPE_ID_REGISTER', fid,
    blockTimestamp: Number(fid > 2000 ? day1 - 10n * D : launch - 365n * D), idRegisterEventBody: { eventType: 'ID_REGISTER_EVENT_TYPE_REGISTER' } }] })
  if (!followers[fid]) return new Response('unavailable', { status: 500 })
  return Response.json({ messages: followers[fid].map(([follower, age]) => ({ data: { fid: follower, network,
    type: 'MESSAGE_TYPE_LINK_ADD', timestamp: ft(at - age), linkBody: { targetFid: fid, type: 'follow' } } })) })
}

test('collect keeps only onchain sessions the operator Snapchain proves, with the onchain node-work rule', async t => {
  t.mock.method(globalThis, 'fetch', async url => snapchain(new URL(url)))
  const input = await collect({ client, distributor, day: 1n, launchTime: launch })
  assert.deepEqual(input.entries.map(e => [Number(e.fid), e.wallet, e.followers, e.nodeWork, e.nodeKey, e.level]), [
    [1, wallet(1), 0, true, nodeKey, 0], [4, wallet(4), 0, false, zeroAddress, 0], [5, wallet(5), 10, false, zeroAddress, 3], [8, wallet(80), 0, false, zeroAddress, 0]])
  assert.equal(input.sourceHash, '0x' + '5'.repeat(64))
  ownCommit = false // signed yesterday's report but only copied it: no node bonus
  assert.equal((await collect({ client, distributor, day: 1n, launchTime: launch })).entries[0].nodeWork, false)
  ownCommit = true
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiers-')), args = { client, distributor, day: 1n, launchTime: launch, cacheDir }
  // While the cohort is open the node checks each cast once and warms tiers only for FIDs whose cast exists.
  const warm = { ...args, now: at + 3600n }
  await assert.rejects(prewarm(warm), /HTTP 500/) // fid 3's cast exists, but its follower list is unavailable
  followers[3] = []
  assert.deepEqual(await prewarm(warm), { casts: 0, fids: 1 }) // casts were all judged; tiers read before the failure were kept
  assert.deepEqual(await prewarm(warm), { casts: 0, fids: 0 })
  castReads = 0
  assert.deepEqual((await collect(args)).entries.map(e => e.followers), [0, 0, 10, 0])
  assert.equal(castReads, 6) // the deleted, too-old and absurd-FID sessions are not read again after the close
  followers[5] = undefined // the weekly tier is cached, so fid 5 is not read again this week
  assert.deepEqual((await collect(args)).entries.map(e => e.followers), [0, 0, 10, 0])
  followers[3] = undefined
  // without the cache, a broken Snapchain read must abort the day, never silently drop a miner
  await assert.rejects(collect({ client, distributor, day: 1n, launchTime: launch }), /HTTP 500/)
  assert.notEqual(prevDigest, zeroHash)
})

test('a node co-signs the earliest announcement within one follower tier, never anything further off', () => {
  const e = (n, followers, extra = {}) => ({ fid: BigInt(n), wallet: wallet(n), followers, nodeWork: false, castHash: cast(n),
    startedAt: at, nodeKey: zeroAddress, level: 0, ...extra })
  const mine = [e(1, 500), e(2, 0)]
  assert.equal(withinTolerance(mine, [e(2, 0), e(1, 1000)]), true) // one tier up, any order
  assert.equal(withinTolerance(mine, [e(1, 2000), e(2, 0)]), false) // two tiers
  assert.equal(withinTolerance(mine, [e(1, 600), e(2, 0)]), false) // not a tier floor
  assert.equal(withinTolerance(mine, [e(1, 500)]), false) // a miner missing
  assert.equal(withinTolerance(mine, [e(1, 500, { level: 1 }), e(2, 0)]), false) // anything onchain must match exactly
  const input = { day: 1n, launchTime: launch, entries: mine, sourceHash: '0x' + '5'.repeat(64) }
  const picked = pickAnnouncement(input, [[e(1, 5000), e(2, 0)], [e(1, 1000), e(2, 10)], [e(1, 500), e(2, 0)]], 31337, distributor)
  assert.deepEqual(picked.map(x => x.followers), [1000, 10])
  assert.equal(pickAnnouncement(input, [[e(1, 5000), e(2, 0)]], 31337, distributor), null)
})
