import test from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { decryptKeystore, encryptKeystore } from './keystore.mjs'

// Throwaway key written by Foundry `cast wallet new` (password below): proves the file format interoperates.
const foundry = {"crypto": {"cipher": "aes-128-ctr", "cipherparams": {"iv": "ee6776134adbb0415ab42469a524c204"}, "ciphertext": "ad5796e009fdf35085e17801b7456e20d6f6ffd977ccbe8958ee129e0d1fcba1", "kdf": "scrypt", "kdfparams": {"dklen": 32, "n": 8192, "p": 1, "r": 8, "salt": "8ae2205a73bea907ae637384570b975cb4fa9e83f89985e211b4fa6cb1191494"}, "mac": "7bf464c95454dfdb86a5df83535220b4293bea5835a31e252ea42559ad17e492"}, "id": "9871363e-dda2-4405-a940-13df41bda662", "version": 3}

test('reads keystores written by Foundry', () => {
  assert.equal(privateKeyToAccount(decryptKeystore(foundry, 'minecast-test-password')).address, '0x976EFdd7d9574DB5EBd5053e8dfd7E158b2f3061')
})

test('round trip, wrong password and tampering are rejected', () => {
  const key = generatePrivateKey(), json = encryptKeystore(key, 'correct horse battery', { n: 1024, r: 8, p: 1 })
  assert.equal(decryptKeystore(json, 'correct horse battery'), key)
  assert.equal('0x' + json.address, privateKeyToAccount(key).address.toLowerCase())
  assert.throws(() => decryptKeystore(json, 'correct horse battery!'), /Wrong password/)
  const flipped = json.crypto.ciphertext.replace(/^./, c => c === '0' ? '1' : '0')
  assert.throws(() => decryptKeystore({ ...json, crypto: { ...json.crypto, ciphertext: flipped } }, 'correct horse battery'), /Wrong password/)
  assert.throws(() => decryptKeystore({ ...json, address: 'ab'.repeat(20) }, 'correct horse battery'), /does not match/)
})
