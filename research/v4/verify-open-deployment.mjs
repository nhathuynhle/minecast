// Read-only deployment verification. No transaction or signature methods are used.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, zeroAddress } from 'viem'
import { DEPLOY_NAMES } from './package-open.mjs'

function maskImmutables(code, references) {
  let hex = code.toLowerCase().slice(2)
  for (const positions of Object.values(references)) for (const { start, length } of positions) {
    hex = hex.slice(0, start * 2) + '0'.repeat(length * 2) + hex.slice((start + length) * 2)
  }
  return hex
}
export async function verifyDeployment(client, plan, artifacts) {
  if (await client.getChainId() !== plan.chainId) throw Error('RPC chain ID differs from the reviewed deployment plan')
  const block = await client.getBlock({ blockTag: 'latest' })
  const blockNumber = block.number
  const read = (name, functionName, args = []) => client.readContract({ address: plan.addresses[name], abi: artifacts[name].abi,
    functionName, args, blockNumber })
  const same = (a, b, label) => { if (String(a).toLowerCase() !== String(b).toLowerCase()) throw Error(label + ' mismatch') }
  // Mask only compiler-declared immutable slots, then verify every address/time binding below.
  for (const name of DEPLOY_NAMES) {
    const artifact = artifacts[name]
    const code = await client.getCode({ address: plan.addresses[name], blockNumber })
    if (!code || code === '0x') throw Error(name + ' has no deployed code')
    same(maskImmutables(code, artifact.immutableReferences), maskImmutables(artifact.runtimeTemplate, artifact.immutableReferences), name + ' runtime')
  }
  const tokenName = 'TokenCastOpenV4', miningName = 'MineCastOpenDistributorV4', timelock = plan.addresses.TimelockController
  same(await read(tokenName, 'devWallet'), plan.devWallet, 'dev wallet')
  same(await read(tokenName, 'launchTime'), plan.launchTime, 'launch time')
  same(await read(tokenName, 'bootstrapAdmin'), zeroAddress, 'bootstrap removed')
  same(await read(tokenName, 'distributorForDay', [0n]), plan.addresses[miningName], 'distributor binding')
  same(await read(tokenName, 'governance'), timelock, 'token governance')
  for (const name of ['MineCastOpenStakingV4', 'MineCastOpenDaoV4', 'MineCastNodeRegistryV4', miningName]) same(await read(name, 'token'), plan.addresses[tokenName], name + ' token')
  same(await read('MineCastOpenStakingV4', 'launchTime'), plan.launchTime, 'staking launch')
  same(await read('MineCastOpenDaoV4', 'staking'), plan.addresses.MineCastOpenStakingV4, 'DAO staking')
  same(await read('MineCastOpenDaoV4', 'governance'), timelock, 'DAO governance')
  for (const [getter, name] of [['registry', 'MineCastNodeRegistryV4'], ['staking', 'MineCastOpenStakingV4'], ['treasury', 'MineCastOpenDaoV4']]) {
    same(await read(miningName, getter), plan.addresses[name], getter)
  }
  const governor = 'MineCastGovernorV4'
  same(await read(governor, 'token'), plan.addresses.MineCastOpenStakingV4, 'governor votes')
  same(await read(governor, 'timelock'), timelock, 'governor timelock')
  same(await read(governor, 'registry'), plan.addresses.MineCastNodeRegistryV4, 'governor registry')
  same(await read('TimelockController', 'getMinDelay'), plan.governanceDelay, 'timelock delay')
  same(await read(governor, 'votingDelay'), plan.votingDelay, 'voting delay')
  same(await read(governor, 'votingPeriod'), plan.votingPeriod, 'voting period')
  const role = name => read('TimelockController', name)
  for (const [roleName, account, expected] of [['PROPOSER_ROLE', plan.addresses[governor], true], ['CANCELLER_ROLE', plan.addresses[governor], true],
    ['EXECUTOR_ROLE', zeroAddress, true], ['DEFAULT_ADMIN_ROLE', plan.deployer, false], ['PROPOSER_ROLE', plan.deployer, false]]) {
    same(await read('TimelockController', 'hasRole', [await role(roleName), account]), expected, 'timelock ' + roleName)
  }
  const launch = BigInt(plan.launchTime), day = block.timestamp < launch ? 0n : (block.timestamp - launch) / 86400n
  const bond = await read('MineCastNodeRegistryV4', 'totalWeightAt', [day])
  const minimum = await read('MineCastNodeRegistryV4', 'MIN_TOTAL_BOND')
  return { chainId: plan.chainId, blockNumber: String(blockNumber), runtimeAndBindingsMatch: true,
    day: String(day), activeBondWei: String(bond), enoughActiveBond: bond >= minimum,
    note: 'This verifies deployed code/bindings and bond at one block; it does not prove source data, independent operators or mainnet readiness.' }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || !process.env.V4_READ_RPC_URL) throw Error('Set V4_READ_RPC_URL and pass the reviewed deployment-plan.json path')
  const file = path.resolve(process.argv[2]), plan = JSON.parse(fs.readFileSync(file, 'utf8'))
  const artifacts = Object.fromEntries(DEPLOY_NAMES.map(name => [name, JSON.parse(fs.readFileSync(path.join(path.dirname(file), name + '.json'), 'utf8'))]))
  console.log(JSON.stringify(await verifyDeployment(createPublicClient({ transport: http(process.env.V4_READ_RPC_URL) }), plan, artifacts), null, 2))
}
