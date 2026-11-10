import fs from 'node:fs'
import { compileOpen } from './compile-open.mjs'
const names = { TokenCastOpenV4: 'tokenAbi', MineCastOpenDistributorV4: 'distributorAbi',
  MineCastOpenStakingV4: 'stakingAbi', MineCastMonthlyDaoV4: 'daoAbi', MineCastNodeRegistryV4: 'registryAbi' }
const artifacts = Object.assign({}, ...Object.values(compileOpen().contracts))
const output = '// Generated from the Open V4 Solidity build. Regenerate with research/v4/export-app-abi.mjs.\n' +
  Object.entries(names).map(([contract, name]) => `export const ${name} = ${JSON.stringify(artifacts[contract].abi)} as const\n`).join('')
fs.mkdirSync('src/lib/v4', { recursive: true })
fs.writeFileSync('src/lib/v4/abi.ts', output)
console.log('Updated Open V4 app ABI from compiled Solidity')
