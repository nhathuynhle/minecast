import assert from 'node:assert/strict'
import test from 'node:test'
import { followersOf, hasVerifiedWallet, miningCasts } from './farcaster-source.mjs'

const network = 'FARCASTER_NETWORK_MAINNET'
const link = fid => ({ data: { network, fid, timestamp: 0, type: 'MESSAGE_TYPE_LINK_ADD', linkBody: { targetFid: 7, type: 'follow' } } })

test('follower query stays on the private API across opaque cursors', async t => {
  const cursor = 'https://other.example/?x=a&b=1'
  const pages = [{ messages: [link(1)], nextPageToken: cursor }, { messages: [link(2)] }]
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'http://127.0.0.1:3381')
    assert.equal(url.pathname, '/v1/linksByTargetFid')
    assert.equal(url.searchParams.get('target_fid'), '7')
    assert.equal(url.searchParams.get('pageToken'), pages.length === 2 ? null : cursor)
    assert.equal(options.redirect, 'error')
    return Response.json(pages.shift())
  })
  assert.deepEqual(await Array.fromAsync(followersOf(7)), [1, 2])
})

test('incomplete or cross-network data aborts collection', async t => {
  const replies = [{ messages: [] , nextPageToken: 'a' }, { messages: [], nextPageToken: 'a' },
    { messages: [{ data: { ...link(2).data, network: 'FARCASTER_NETWORK_TESTNET' } }] }]
  t.mock.method(globalThis, 'fetch', async () => Response.json(replies.shift()))
  await assert.rejects(Array.fromAsync(followersOf(7)), /pagination loop/)
  await assert.rejects(Array.fromAsync(followersOf(7)), /network/)
})

test('cast discovery binds the parent, wallet verification binds the protocol', async t => {
  const wallet = '0x' + '11'.repeat(20)
  const replies = [
    { data: { fid: 7, network, type: 'MESSAGE_TYPE_CAST_ADD', castAddBody: { parentUrl: 'wrong' } } },
    { data: { fid: 7, network, type: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS',
      verificationAddAddressBody: { address: wallet, protocol: 'PROTOCOL_SOLANA' } } },
    { data: { fid: 7, network, type: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS',
      verificationAddAddressBody: { address: wallet, protocol: 'PROTOCOL_ETHEREUM' } } },
  ]
  t.mock.method(globalThis, 'fetch', async () => Response.json({ messages: [replies.shift()] }))
  await assert.rejects(Array.fromAsync(miningCasts('expected')), /Wrong cast parent/)
  assert.equal(await hasVerifiedWallet(7, wallet), false)
  assert.equal(await hasVerifiedWallet(7, wallet), true)
})
