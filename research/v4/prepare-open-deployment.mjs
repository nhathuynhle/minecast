// Generate unsigned transactions for review. Does not sign, broadcast or contact any network.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeDeployData, encodeFunctionData, getAddress, getContractAddress, zeroAddress } from 'viem'
import { packageOpen, DEPLOY_NAMES } from './package-open.mjs'

export function prepareDeployment(config, contracts, currentTime = Math.floor(Date.now() / 1000)) {
  if (![31337, 84532, 8453].includes(config.chainId)) throw Error('Expected local Anvil, Base Sepolia or Base mainnet chain ID')
  const deployer = getAddress(config.deployer), devWallet = getAddress(config.devWallet)
  if (deployer === zeroAddress || devWallet === zeroAddress) throw Error('Set explicit nonzero deployer and devWallet')
  if (!Number.isSafeInteger(config.pendingNonce) || config.pendingNonce < 0) throw Error('Set pendingNonce from the intended chain immediately before deployment')
  if (!Number.isSafeInteger(config.launchTime) || config.launchTime < currentTime + 8 * 86400) throw Error('Leave at least 8 days to register and activate the first validator before launch')
  const addresses = Object.fromEntries(DEPLOY_NAMES.map((name, i) => [name, getContractAddress({ from: deployer, nonce: BigInt(config.pendingNonce + i) })]))
  const token = addresses.TokenCastOpenV4, staking = addresses.MineCastOpenStakingV4
  const args = {
    TokenCastOpenV4: [devWallet, deployer, BigInt(config.launchTime)],
    MineCastOpenStakingV4: [token], MineCastMonthlyDaoV4: [token, staking],
    MineCastNodeRegistryV4: [token],
    MineCastOpenDistributorV4: [token, addresses.MineCastNodeRegistryV4, staking, addresses.MineCastMonthlyDaoV4],
  }
  const transactions = DEPLOY_NAMES.map((name, i) => ({ action: 'Deploy ' + name, chainId: config.chainId,
    from: deployer, nonce: config.pendingNonce + i, value: '0', expectedAddress: addresses[name], constructorArgs: args[name],
    data: encodeDeployData({ abi: contracts[name].abi, bytecode: contracts[name].bytecode, args: args[name] }),
  }))
  transactions.push({ action: 'AFTER independent address/bytecode verification: irreversibly finalize distributor',
    chainId: config.chainId, from: deployer, nonce: config.pendingNonce + 5, to: token, value: '0',
    data: encodeFunctionData({ abi: contracts.TokenCastOpenV4.abi, functionName: 'finalizeDistributor', args: [addresses.MineCastOpenDistributorV4] }) })
  return { status: 'UNSIGNED_PLAN_NOT_DEPLOYED', chainId: config.chainId, deployer, devWallet,
    launchTime: config.launchTime, addresses, transactions,
    constraints: ['Use one deployer and consecutive nonces; any unrelated transaction invalidates predicted addresses.',
      'Verify chain ID, pending nonce and block time against your RPC before signing.',
      'Estimate gas after each dependency deployment; do not blindly send this file.',
      'Review code and bindings before irreversible finalization; token() alone is not a safety proof.',
      'Dev then approves and registers at least 1M TOKENCAST to a separate validator signing key; wait 7 days and activate before launch.',
      'No DEX liquidity, node process, UI migration or mainnet approval is created by this plan.'] }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw Error('Usage: npm run v4:plan -- path/to/config.local.json')
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const bundle = packageOpen()
  const plan = prepareDeployment(config, bundle.contracts)
  const output = path.join(bundle.directory, 'deployment-plan.json')
  fs.writeFileSync(output, JSON.stringify(plan, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n')
  console.log('Unsigned review plan only: ' + output)
}
