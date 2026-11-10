import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { concatHex, createPublicClient, encodeAbiParameters, getAddress, http, keccak256, zeroHash } from 'viem'
import { allocate } from './allocation.mjs'
import { dailyEmissionForDay } from './emission.mjs'
import { nodeRoster } from './node/work.mjs'
import { readNodeReceipts } from './node/relay-report.mjs'

const fields = ['uint256', 'address', 'uint256', 'uint256', 'address', 'uint256'].map(type => ({ type }))

export function claimLeaf(chainId, distributor, day, fid, wallet, amount) {
  return keccak256(keccak256(encodeAbiParameters(fields, [chainId, distributor, day, BigInt(fid), wallet, amount])))
}

export function hashPair(a, b) {
  return keccak256(concatHex(a < b ? [a, b] : [b, a]))
}

// Use decimal strings for wei in JSON. Leaves are sorted by FID; odd nodes advance unchanged.
export function buildSnapshot({ chainId, distributor, day, poolWei, miners }, verifiedNodeWallets = new Map()) {
  const pool = BigInt(poolWei)
  if (pool !== dailyEmissionForDay(day)) throw Error('Pool does not match the V4 daily emission schedule')
  const { allocations, allocated } = allocate(pool, pool / 100n, miners, verifiedNodeWallets)
  const entries = allocations.filter(x => x.amount > 0n).sort((a, b) => a.fid - b.fid)
  const levels = [entries.map(x => claimLeaf(BigInt(chainId), distributor, BigInt(day), x.fid, x.wallet, x.amount))]
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1)
    const next = []
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? hashPair(current[i], current[i + 1]) : current[i])
    }
    levels.push(next)
  }
  return {
    root: levels.at(-1)[0] ?? zeroHash,
    allocated: allocated.toString(),
    claims: entries.map(({ fid, wallet, amount }, index) => {
      const proof = []
      for (const level of levels.slice(0, -1)) {
        const sibling = index % 2 === 0 ? index + 1 : index - 1
        if (sibling < level.length) proof.push(level[sibling])
        index = Math.floor(index / 2)
      }
      return { fid, wallet, amount: amount.toString(), proof }
    }),
  }
}

// The input evidence hash binds the authenticated Farcaster checkpoints and
// source archive. All workers publish the same pre-boost bytes regardless of their own FID.
export function buildWorkManifest(input) {
  if (!/^0x[0-9a-f]{64}$/i.test(input.evidenceHash) || input.evidenceHash.toLowerCase() === zeroHash) {
    throw Error('Missing source evidence hash')
  }
  const baseline = buildSnapshot(input)
  const miners = input.miners.map(({ fid, wallet, followers }) => ({ fid, wallet: wallet.toLowerCase(), followers }))
    .sort((a, b) => a.fid - b.fid)
  const manifest = { version: 1, chainId: BigInt(input.chainId).toString(), distributor: input.distributor.toLowerCase(),
    day: BigInt(input.day).toString(), poolWei: BigInt(input.poolWei).toString(), evidenceHash: input.evidenceHash.toLowerCase(),
    miners, baselineRoot: baseline.root, baselineAllocated: baseline.allocated }
  const bytes = Buffer.from(JSON.stringify(manifest))
  return { manifest, bytes, dataHash: keccak256(bytes) }
}

// expectedRosterHash must come from finalized Base state after the work window.
export function buildNodeRewardReport(rawManifest, receipts, expectedRosterHash) {
  const { manifest, bytes, dataHash } = buildWorkManifest(JSON.parse(rawManifest))
  if (!bytes.equals(rawManifest)) throw Error('Noncanonical or incorrect pre-boost manifest')
  const { commitment, walletsByFid } = nodeRoster(receipts)
  if (commitment !== expectedRosterHash) throw Error('Incomplete or incorrect Base work receipts')
  const eligible = new Map(manifest.miners.map(m => [m.fid, m.wallet]))
  for (const [fid, wallet] of walletsByFid) {
    if (eligible.get(fid) !== wallet) throw Error('Node receipt does not belong to an eligible miner')
  }
  return { dataHash, rosterHash: commitment, ...buildSnapshot(manifest, walletsByFid) }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [first, file, extra] = process.argv.slice(2)
  if (first === '--work') {
    const { bytes, dataHash } = buildWorkManifest(JSON.parse(await readFile(file)))
    await writeFile(extra, bytes, { flag: 'wx' })
    console.log(dataHash)
  } else if (first === '--final') {
    const raw = await readFile(file)
    const manifest = JSON.parse(raw)
    const rpc = process.env.BASE_SEPOLIA_RPC_URL
    const distributor = getAddress(process.env.V4_DISTRIBUTOR)
    if (!rpc || getAddress(manifest.distributor) !== distributor || BigInt(manifest.chainId) !== 84532n) {
      throw Error('Expected the configured V4 Base Sepolia deployment and RPC')
    }
    const client = createPublicClient({ transport: http(rpc) })
    if (await client.getChainId() !== 84532) throw Error('Wrong RPC network')
    const day = BigInt(manifest.day)
    const { receipts, rosterHash } = await readNodeReceipts(client, distributor, day, keccak256(raw), BigInt(extra))
    console.log(JSON.stringify(buildNodeRewardReport(raw, receipts, rosterHash), null, 2))
  } else {
    const raw = await readFile(first)
    console.log(JSON.stringify({ dataHash: keccak256(raw), ...buildSnapshot(JSON.parse(raw)) }, null, 2))
  }
}
