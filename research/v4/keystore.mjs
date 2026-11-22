// Encrypted wallet key files (Web3 Secret Storage v3: the JSON that MetaMask, Rabby, geth and Foundry import),
// so deploy and governance keys never sit on disk in plain text. The password is asked for, hidden, at use.
//   node research/v4/keystore.mjs new C:\minecast-keys\mainnet-deployer.json      # fresh random key
//   node research/v4/keystore.mjs import C:\minecast-keys\deployer.json           # type/paste a key (hidden)
//   node research/v4/keystore.mjs import C:\minecast-keys\deployer.json C:\minecast-deploy\deployer.key
//   node research/v4/keystore.mjs address C:\minecast-keys\deployer.json
// Back up the file and its password in different places: either one alone cannot spend from the wallet.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { bytesToHex, getAddress, hexToBytes, keccak256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const STANDARD = { n: 262144, r: 8, p: 1 } // geth "standard" scrypt cost, ~1 s per unlock

function derive(password, { n, r, p, dklen, salt }) {
  if (dklen !== 32) throw Error('Unsupported keystore: dklen must be 32')
  return crypto.scryptSync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'hex'), dklen, { N: n, r, p, maxmem: 128 * n * r * p + 64 * 1024 * 1024 })
}
const macOf = (key, ciphertext) => Buffer.from(keccak256(Buffer.concat([key.subarray(16, 32), ciphertext])).slice(2), 'hex')

export function encryptKeystore(privateKey, password, cost = STANDARD) {
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(16)
  const kdfparams = { dklen: 32, ...cost, salt: salt.toString('hex') }
  const key = derive(password, kdfparams), cipher = crypto.createCipheriv('aes-128-ctr', key.subarray(0, 16), iv)
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(privateKey)), cipher.final()])
  return { version: 3, id: crypto.randomUUID(), address: privateKeyToAccount(privateKey).address.slice(2).toLowerCase(),
    crypto: { cipher: 'aes-128-ctr', cipherparams: { iv: iv.toString('hex') }, ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt', kdfparams, mac: macOf(key, ciphertext).toString('hex') } }
}

export function decryptKeystore(json, password) {
  const c = json.crypto ?? json.Crypto
  if (json.version !== 3 || c?.cipher !== 'aes-128-ctr' || c.kdf !== 'scrypt') throw Error('Unsupported keystore: need v3, scrypt, aes-128-ctr')
  const key = derive(password, c.kdfparams), ciphertext = Buffer.from(c.ciphertext, 'hex'), mac = Buffer.from(c.mac, 'hex')
  const expected = macOf(key, ciphertext)
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) throw Error('Wrong password for this keystore')
  const decipher = crypto.createDecipheriv('aes-128-ctr', key.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex'))
  const privateKey = bytesToHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  if (json.address && privateKeyToAccount(privateKey).address.slice(2).toLowerCase() !== json.address.replace(/^0x/, '').toLowerCase()) throw Error('Keystore address does not match its key')
  return privateKey
}

/** Prompt without echoing what is typed or pasted. */
export function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(question) }
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer) })
  })
}

export async function keystoreAccount(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  return privateKeyToAccount(decryptKeystore(json, await ask(`Password for ${path.basename(file)}: `)))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, file, source] = process.argv.slice(2)
  if (!['new', 'import', 'address'].includes(command) || !file) {
    console.log('Usage: node research/v4/keystore.mjs new|import|address <keystore.json> [plain key file to import]')
    process.exit(1)
  }
  if (command === 'address') console.log(getAddress('0x' + JSON.parse(fs.readFileSync(file, 'utf8')).address.replace(/^0x/, '')))
  else {
    if (fs.existsSync(file)) throw Error(file + ' already exists; refusing to overwrite a key')
    const raw = command === 'new' ? generatePrivateKey() : (source ? fs.readFileSync(source, 'utf8') : await ask('Private key (hidden): ')).trim()
    const privateKey = raw.startsWith('0x') ? raw : '0x' + raw
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw Error('A private key is 64 hex characters, optionally prefixed with 0x')
    const password = await ask('New password, 12+ characters (hidden): ')
    if (password.length < 12) throw Error('Use a password of at least 12 characters')
    if (password !== await ask('Repeat the password: ')) throw Error('The passwords differ; nothing was written')
    const json = encryptKeystore(privateKey, password)
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.log('Saved ' + file + ' for wallet ' + getAddress('0x' + json.address))
    console.log('Back up the file and the password in different places.' + (source ? ' Then delete ' + source + '.' : ''))
  }
}
