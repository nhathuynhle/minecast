import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export async function loadModule(entry, mocks = {}) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in mocks ? { path, namespace: 'test' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }))
    } }],
  })
  const contents = result.outputFiles[0].text
  const directory = path.resolve('tests/build.local')
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, createHash('sha256').update(contents).digest('hex') + '.mjs')
  fs.writeFileSync(file, contents)
  return import(pathToFileURL(file).href)
}
