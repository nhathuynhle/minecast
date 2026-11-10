// Outside the enclave: the fee payer can inspect/relay the packet but cannot alter it.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, parseAbiItem } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

const abi = parseAbi([
  'struct NodeProof { bytes tbs; bytes signature; bytes hints; }',
  'function bond() view returns (uint256)',
  'function dayEnd(uint256 day) view returns (uint256)',
  'function WORK_WINDOW() view returns (uint256)',
  'function workRosterHash(uint256 day, bytes32 dataHash) view returns (bytes32)',
  'function recordNodeWork(uint256 day, bytes32 dataHash, uint256 fid, NodeProof proof)',
  'function submit(uint256 day, bytes32 root, uint256 allocated, bytes32 dataHash, string dataURI, NodeProof proof) payable returns (uint256)',
])

export async function prepareSubmission(client, distributor, reporter, packet) {
  const contract = { address: getAddress(distributor), abi }
  if (packet.kind === 'work') {
    const args = [BigInt(packet.day), packet.dataHash, BigInt(packet.fid), packet.proof]
    const { request } = await client.simulateContract({
      ...contract, functionName: 'recordNodeWork', args, account: reporter,
    })
    return request
  }
  const value = await client.readContract({ ...contract, functionName: 'bond' })
  const args = [BigInt(packet.day), packet.root, BigInt(packet.allocated), packet.dataHash, packet.dataURI, packet.proof]
  const { request } = await client.simulateContract({
    ...contract, functionName: 'submit', args, account: reporter, value,
  })
  return request
}

export async function readNodeReceipts(client, address, day, dataHash, fromBlock, blockTag = 'finalized') {
  const block = await client.getBlock({ blockTag })
  const context = { address, abi, blockNumber: block.number }
  const [end, window, rosterHash] = await Promise.all([
    client.readContract({ ...context, functionName: 'dayEnd', args: [day] }),
    client.readContract({ ...context, functionName: 'WORK_WINDOW' }),
    client.readContract({ ...context, functionName: 'workRosterHash', args: [day, dataHash] }),
  ])
  if (block.timestamp < end + window) throw Error('Node work window is still open')
  const event = parseAbiItem('event NodeWorkRecorded(uint256 indexed day, bytes32 indexed dataHash, uint256 indexed fid, address wallet)')
  const logs = await client.getLogs({ address, event, args: { day, dataHash }, fromBlock, toBlock: block.number, strict: true })
  logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1)
  return { receipts: logs.map(log => log.args), rosterHash }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [file, mode] = process.argv.slice(2)
  if (!file || (mode && mode !== '--send')) throw Error('Usage: node relay-report.mjs packet.json [--send]')
  const packet = JSON.parse(await readFile(file, 'utf8'))
  const chain = baseSepolia
  const transport = http(process.env.BASE_SEPOLIA_RPC_URL)
  const client = createPublicClient({ chain, transport })
  if (await client.getChainId() !== chain.id) throw Error('Expected Base Sepolia')
  const account = mode ? privateKeyToAccount(process.env.NODE_RELAYER_KEY) : getAddress(packet.reporter)
  if (mode && account.address !== getAddress(packet.reporter)) throw Error('Wrong fee payer for this packet')
  const request = await prepareSubmission(client, process.env.V4_DISTRIBUTOR, account, packet)
  if (mode) {
    const wallet = createWalletClient({ chain, transport, account })
    const hash = await wallet.writeContract(request)
    console.log(hash)
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw Error('Report transaction reverted')
  } else {
    console.log('Packet accepted in simulation; bond (wei):', (request.value ?? 0n).toString())
  }
}
