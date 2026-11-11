// Reader for a frozen, validated mainnet Snapchain view in the worker's private
// network namespace. Loopback on an ordinary operator-controlled host is NOT a trust anchor.
// Deliberately exposes no arbitrary URL, generic fetch or attestation operation.
import { isAddress } from 'viem'

export const FARCASTER_EPOCH = 1609459200 // Farcaster message timestamps count seconds from here.

function validFid(fid) {
  if (!Number.isSafeInteger(fid) || fid < 1) throw Error('Invalid Farcaster FID')
  return fid
}

async function* messages(method, query, expectedType) {
  const url = new URL('/v1/' + method, 'http://127.0.0.1:3381')
  url.search = new URLSearchParams({ ...query, pageSize: '500' }).toString()
  const seen = new Set()
  for (;;) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw Error('Snapchain ' + method + ': HTTP ' + response.status)
    const page = await response.json()
    if (!Array.isArray(page.messages) || (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string')) {
      throw Error('Incomplete Snapchain page')
    }
    for (const message of page.messages) {
      if (message.data?.network !== 'FARCASTER_NETWORK_MAINNET' || message.data.type !== expectedType) {
        throw Error('Unexpected Farcaster network or message type')
      }
      validFid(message.data.fid)
      yield message
    }
    if (!page.nextPageToken) return // Snapchain omits the optional cursor at EOF.
    if (seen.has(page.nextPageToken)) throw Error('Snapchain pagination loop')
    seen.add(page.nextPageToken)
    url.searchParams.set('pageToken', page.nextPageToken)
  }
}

// The parent URL is a public cast marker shared by every mini app, never fetched.
export async function* miningCasts(parentUrl) {
  for await (const message of messages('castsByParent', { url: parentUrl }, 'MESSAGE_TYPE_CAST_ADD')) {
    if (message.data.castAddBody?.parentUrl !== parentUrl) throw Error('Wrong cast parent')
    yield message
  }
}

// `before` (unix seconds) skips follows made later, so a count taken hours after the session matches.
export async function* followersOf(fid, before = Infinity) {
  const query = { target_fid: String(validFid(fid)), link_type: 'follow' }
  for await (const message of messages('linksByTargetFid', query, 'MESSAGE_TYPE_LINK_ADD')) {
    const link = message.data.linkBody
    if (link?.targetFid !== fid || link.type !== 'follow' || !Number.isSafeInteger(message.data.timestamp)) throw Error('Wrong follow target')
    if (FARCASTER_EPOCH + message.data.timestamp <= before) yield message.data.fid
  }
}

// null only when the node itself says the cast is absent (deleted or never existed); other failures throw.
export async function castById(fid, hash) {
  if (!/^0x[0-9a-f]{40}$/i.test(hash)) throw Error('Invalid cast hash')
  const url = new URL('/v1/castById', 'http://127.0.0.1:3381')
  url.search = new URLSearchParams({ fid: String(validFid(fid)), hash }).toString()
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) })
  const message = await response.json()
  if (!response.ok) {
    if (message?.errCode === 'not_found') return null
    throw Error('Snapchain castById: HTTP ' + response.status)
  }
  if (message.data?.network !== 'FARCASTER_NETWORK_MAINNET' || message.data.type !== 'MESSAGE_TYPE_CAST_ADD'
    || message.data.fid !== fid || !Number.isSafeInteger(message.data.timestamp)) throw Error('Unexpected cast message')
  return message
}

export async function hasVerifiedWallet(fid, wallet) {
  if (!isAddress(wallet)) throw Error('Invalid payout wallet')
  const query = { fid: String(validFid(fid)), address: wallet }
  for await (const { data } of messages('verificationsByFid', query, 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS')) {
    if (data.fid !== fid) throw Error('Wrong verification FID')
    const modern = data.verificationAddAddressBody
    if (modern && modern.protocol !== 'PROTOCOL_ETHEREUM') continue
    const verification = modern ?? data.verificationAddEthAddressBody
    if (verification?.address?.toLowerCase() === wallet.toLowerCase()) return true
  }
  return false
}
