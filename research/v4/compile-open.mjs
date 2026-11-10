import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import solc from 'solc'

export const BUILD_SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' }
export function compileOpen(extraSources = {}) {
  if (!solc.version().startsWith('0.8.38+commit.1835d247.')) throw Error('Expected pinned Solidity 0.8.38')
  if (JSON.parse(fs.readFileSync('node_modules/@openzeppelin/contracts/package.json')).version !== '5.6.1') throw Error('Expected OpenZeppelin 5.6.1')
  const sources = { ...extraSources }
  for (const name of fs.readdirSync('contracts/v4/open').filter(x => x.endsWith('.sol'))) {
    const file = 'contracts/v4/open/' + name
    sources[file] = { content: fs.readFileSync(file, 'utf8') }
  }
  const resolvedSources = { ...sources }
  const input = { language: 'Solidity', sources, settings: { ...BUILD_SETTINGS,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'] } } } }
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import(file) {
    const resolved = [file, 'node_modules/' + file].find(x => fs.existsSync(x))
    if (!resolved) return { error: 'Missing import: ' + file }
    const contents = fs.readFileSync(resolved, 'utf8')
    resolvedSources[file] = { content: contents }
    return { contents }
  } }))
  const errors = (output.errors ?? []).filter(x => x.severity === 'error')
  if (errors.length) throw Error(errors.map(x => x.formattedMessage).join('\n'))
  for (const contracts of Object.values(output.contracts)) for (const [name, artifact] of Object.entries(contracts)) {
    if (artifact.evm.deployedBytecode.object.length / 2 > 24576) throw Error(name + ' exceeds EIP-170')
  }
  return { contracts: output.contracts, warnings: (output.errors ?? []).filter(x => x.severity !== 'error'),
    standardJsonInput: { ...input, sources: resolvedSources }, settings: BUILD_SETTINGS, compiler: solc.version() }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const compiled = compileOpen()
  for (const [source, contracts] of Object.entries(compiled.contracts)) {
    if (!source.startsWith('contracts/v4/')) continue
    for (const [name, artifact] of Object.entries(contracts)) {
      if (artifact.evm.bytecode.object) console.log(`${name}: ${artifact.evm.deployedBytecode.object.length / 2} runtime bytes`)
    }
  }
  for (const warning of compiled.warnings) console.log(warning.formattedMessage)
}
