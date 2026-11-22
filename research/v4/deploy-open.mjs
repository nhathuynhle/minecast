// Base Sepolia rehearsal: sign and send the Open V4 plan, finalize, verify, then bond the first node.
//   $env:V4_RPC_URL = "https://sepolia.base.org"
//   $env:DEPLOYER_KEYSTORE = "C:\minecast-keys\deployer.json"   # encrypted key (research/v4/keystore.mjs); asks its password
//   # or $env:DEPLOYER_PRIVATE_KEY = "0x..."  # plain key, testnet only; the deployer is also the dev wallet
//   $env:NODE_SIGNING_ADDRESS = "0x..."        # address of the worker's NODE_SIGNING_KEY (a different key)
//   node research/v4/deploy-open.mjs            # deploy (launch = next 00:00 UTC unless V4_LAUNCH_TIME is set)
//   node research/v4/deploy-open.mjs activate   # 7 days later: activate the node
// shortcut: testnet only; mainnet needs independent verification between deploy and finalize.
import fs from 'node:fs'
import path from 'node:path'
import { createWalletClient, encodeFunctionData, getAddress, http, parseAbi, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { packageOpen } from './package-open.mjs'
import { keystoreAccount } from './keystore.mjs'
import { prepareDeployment } from './prepare-open-deployment.mjs'
import { verifyDeployment } from './verify-open-deployment.mjs'

const env = process.env, BOND = 1_000_000n * 10n ** 18n
const planFile = path.resolve('research/v4/build.local/deployment-plan.json')
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n'
const registryAbi = parseAbi(['function registerNode(address signingKey, uint256 amount)', 'function activateNode(address signingKey)',
  'function nodes(address) view returns (address operator, uint64 readyAt, uint64 startDay, uint64 endDay, uint208 weight, bool activated, bool slashed, bool withdrawn)'])
const tokenAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

if (!env.V4_RPC_URL || !(env.DEPLOYER_KEYSTORE || env.DEPLOYER_PRIVATE_KEY)) throw Error('Set V4_RPC_URL and DEPLOYER_KEYSTORE (or DEPLOYER_PRIVATE_KEY)')
const account = env.DEPLOYER_KEYSTORE ? await keystoreAccount(env.DEPLOYER_KEYSTORE) : privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY.trim())
const client = createWalletClient({ account, chain: baseSepolia, transport: http(env.V4_RPC_URL) }).extend(publicActions)
if (await client.getChainId() !== baseSepolia.id) throw Error('RPC is not Base Sepolia (84532)')
const nodeKey = env.NODE_SIGNING_ADDRESS && getAddress(env.NODE_SIGNING_ADDRESS.trim())
if (nodeKey === account.address) throw Error('NODE_SIGNING_ADDRESS must be a different key from the deployer')

async function send(label, request) {
  const gas = await client.estimateGas({ account, ...request })
  const hash = await client.sendTransaction({ ...request, gas: gas + gas / 5n })
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw Error(label + ' reverted: ' + hash)
  console.log('ok  ' + label + '  ' + hash)
  return receipt
}

if (process.argv[2] === 'activate') {
  if (!nodeKey) throw Error('Set NODE_SIGNING_ADDRESS')
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')), registry = plan.addresses.MineCastNodeRegistryV4
  const [, readyAt] = await client.readContract({ address: registry, abi: registryAbi, functionName: 'nodes', args: [nodeKey] })
  const { timestamp } = await client.getBlock()
  if (timestamp < readyAt) throw Error('Node is ready at ' + new Date(Number(readyAt) * 1000).toISOString())
  await send('activateNode', { to: registry, data: encode(registryAbi, 'activateNode', [nodeKey]) })
  process.exit(0)
}

const now = Math.floor(Date.now() / 1000)
const config = { chainId: baseSepolia.id, deployer: account.address, devWallet: getAddress(env.V4_DEV_WALLET?.trim() || account.address),
  launchTime: Number(env.V4_LAUNCH_TIME || (Math.floor(now / 86400) + 1) * 86400),
  pendingNonce: await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) }
if (config.launchTime - now < 1800) throw Error('Launch is under 30 minutes away; set V4_LAUNCH_TIME to a later 00:00 UTC')
const bundle = packageOpen(), plan = prepareDeployment(config, bundle.contracts, now)
fs.writeFileSync(planFile, json(plan))
console.log('Launch ' + new Date(config.launchTime * 1000).toISOString() + ', deployer ' + account.address + ', nonce ' + config.pendingNonce)

for (const tx of plan.transactions) {
  const receipt = await send(tx.action.replace(/^AFTER.*: /, ''), { to: tx.to, data: tx.data, nonce: tx.nonce, value: 0n })
  if (tx.expectedAddress && getAddress(receipt.contractAddress) !== tx.expectedAddress) throw Error(tx.action + ' landed at an unexpected address')
}
console.log(json(await verifyDeployment(client, plan, bundle.contracts)))

const a = plan.addresses
if (nodeKey && config.devWallet === account.address) {
  await send('approve 1M bond', { to: a.TokenCastOpenV4, data: encode(tokenAbi, 'approve', [a.MineCastNodeRegistryV4, BOND]) })
  await send('registerNode', { to: a.MineCastNodeRegistryV4, data: encode(registryAbi, 'registerNode', [nodeKey, BOND]) })
  const [, readyAt] = await client.readContract({ address: a.MineCastNodeRegistryV4, abi: registryAbi, functionName: 'nodes', args: [nodeKey] })
  console.log('Node can be activated after ' + new Date(Number(readyAt) * 1000).toISOString() + ': node research/v4/deploy-open.mjs activate')
} else console.log('Node not registered: set NODE_SIGNING_ADDRESS (dev wallet must be the deployer) or register it from the dev wallet.')

console.log(`\n# App (Vercel preview)\nVITE_MINING_PROTOCOL=v4\nVITE_V4_CHAIN_ID=84532\nVITE_V4_RPC_URL=${env.V4_RPC_URL}
VITE_V4_TOKEN_ADDRESS=${a.TokenCastOpenV4}\nVITE_V4_DISTRIBUTOR_ADDRESS=${a.MineCastOpenDistributorV4}\nVITE_V4_STAKING_ADDRESS=${a.MineCastOpenStakingV4}
VITE_V4_DAO_ADDRESS=${a.MineCastOpenDaoV4}\nVITE_V4_REGISTRY_ADDRESS=${a.MineCastNodeRegistryV4}\nVITE_V4_GOVERNOR_ADDRESS=${a.MineCastGovernorV4}
# Worker\nV4_CHAIN_ID=84532\nV4_DISTRIBUTOR_ADDRESS=${a.MineCastOpenDistributorV4}\nV4_RPC_URL=${env.V4_RPC_URL}
# Also: governor ${a.MineCastGovernorV4}, timelock ${a.TimelockController}`)

function encode(abi, functionName, args) { return encodeFunctionData({ abi, functionName, args }) }
