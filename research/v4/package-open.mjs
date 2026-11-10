// Offline build bundle only. No keys, RPC, wallet or broadcast capability.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { keccak256, toHex } from 'viem'
import { compileOpen } from './compile-open.mjs'
import { POLICY_HASH } from './open-report.mjs'

export const DEPLOY_NAMES = ['TokenCastOpenV4', 'MineCastOpenStakingV4', 'MineCastMonthlyDaoV4', 'MineCastNodeRegistryV4', 'MineCastOpenDistributorV4']
export function packageOpen(output = 'research/v4/build.local') {
  const build = compileOpen(), directory = path.resolve(output)
  fs.mkdirSync(directory, { recursive: true })
  const contracts = {}
  for (const [source, entries] of Object.entries(build.contracts)) for (const [name, artifact] of Object.entries(entries)) {
    if (!DEPLOY_NAMES.includes(name)) continue
    const compiled = { name, source, abi: artifact.abi, bytecode: '0x' + artifact.evm.bytecode.object,
      runtimeTemplate: '0x' + artifact.evm.deployedBytecode.object,
      immutableReferences: artifact.evm.deployedBytecode.immutableReferences, metadata: JSON.parse(artifact.metadata) }
    contracts[name] = compiled
    fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(compiled, null, 2) + '\n')
  }
  const standardInput = JSON.stringify(build.standardJsonInput, null, 2) + '\n'
  fs.writeFileSync(path.join(directory, 'standard-input.json'), standardInput)
  const manifest = { status: 'LOCAL_CANDIDATE_NOT_AUDITED_OR_DEPLOYED', compiler: build.compiler,
    settings: build.settings, openzeppelin: '5.6.1', policyHash: POLICY_HASH,
    inputHash: keccak256(toHex(standardInput)), sources: Object.fromEntries(Object.entries(build.standardJsonInput.sources)
      .map(([file, { content }]) => [file, keccak256(toHex(content))])),
    contracts: Object.fromEntries(Object.entries(contracts).map(([name, a]) => [name, {
      source: a.source, creationHash: keccak256(a.bytecode), runtimeBytes: (a.runtimeTemplate.length - 2) / 2,
    }])) }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { directory, manifest, contracts }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { directory, manifest } = packageOpen(process.argv[2])
  console.log(JSON.stringify({ directory, inputHash: manifest.inputHash, status: manifest.status }, null, 2))
}
