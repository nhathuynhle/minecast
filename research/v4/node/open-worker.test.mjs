import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress, zeroHash } from 'viem'
import { collect } from './open-worker.mjs'

const network = 'FARCASTER_NETWORK_MAINNET', distributor = '0x' + 'd1'.repeat(20), token = '0x' + 'a0'.repeat(20)
const launch = 1893456000n, day1 = launch + 86400n, at = day1 + 3600n, ft = unix => Number(unix) - 1609459200
const wallet = n => '0x' + String(n).padStart(2, '0').repeat(20)
const cast = n => '0x' + String(n).padStart(2, '0').repeat(20)
const session = (fid, w = fid, startedAt = at) => ({ fid: BigInt(fid), wallet: wallet(w), castHash: cast(fid), startedAt })
// fid 1 valid node operator (12 followers), 2 cast deleted, 3 wallet unverified, 4 overlaps yesterday,
// 5 valid (9 followers before its start, 5 after), 6 cast older than 24h, 7 absurd FID, 8 two wallets.
const days = { 0: [session(4, 4, day1 - 3600n)], 1: [1, 2, 3, 4, 5, 6].map(f => session(f)).concat(
  [{ ...session(7), fid: 2n ** 63n }, session(8, 81, at + 10n), session(8, 80, at + 5n)]) }
const followers = { 1: [12, 0], 5: [9, 5], 8: [0, 0] }
const prevDigest = '0x' + 'ee'.repeat(32), nodeKey = '0x' + 'bb'.repeat(20), cutoff = launch + 3n * 86400n + 6n * 3600n

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
  }
  throw Error('unexpected read ' + functionName)
} }

function snapchain(url) {
  const fid = Number(url.searchParams.get('fid') ?? url.searchParams.get('target_fid'))
  if (url.pathname === '/v1/castById') {
    if (fid === 2) return Response.json({ errCode: 'not_found' }, { status: 400 })
    return Response.json({ data: { fid, network, type: 'MESSAGE_TYPE_CAST_ADD', timestamp: ft(at - (fid === 6 ? 90000n : 60n)) } })
  }
  if (url.pathname === '/v1/verificationsByFid') return Response.json({ messages: fid === 3 ? [] : [{ data: { fid, network,
    type: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS', verificationAddAddressBody: { address: url.searchParams.get('address'), protocol: 'PROTOCOL_ETHEREUM' } } }] })
  if (!followers[fid]) return new Response('unavailable', { status: 500 })
  const [before, after] = followers[fid]
  return Response.json({ messages: Array.from({ length: before + after }, (_, i) => ({ data: { fid: 1000 + i, network,
    type: 'MESSAGE_TYPE_LINK_ADD', timestamp: ft(i < before ? at - 10n : at + 10n), linkBody: { targetFid: fid, type: 'follow' } } })) })
}

test('collect keeps only onchain sessions the operator Snapchain proves, with the onchain node-work rule', async t => {
  t.mock.method(globalThis, 'fetch', async url => snapchain(new URL(url)))
  const input = await collect({ client, distributor, day: 1n, launchTime: launch })
  assert.deepEqual(input.entries.map(e => [Number(e.fid), e.wallet, e.followers, e.nodeWork, e.nodeKey, e.level]), [
    [1, wallet(1), 10, true, nodeKey, 0], [5, wallet(5), 0, false, zeroAddress, 3], [8, wallet(80), 0, false, zeroAddress, 0]])
  assert.equal(input.sourceHash, '0x' + '5'.repeat(64))
  followers[5] = undefined // a broken Snapchain read must abort the day, never silently drop a miner
  await assert.rejects(collect({ client, distributor, day: 1n, launchTime: launch }), /HTTP 500/)
  assert.notEqual(prevDigest, zeroHash)
})
