import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevSigner, deriveVaultKeys, unlockParams, verifyNep413 } from '../src/index.ts'

test('a wallet signature verifies and derives the same keys every time', () => {
  const signer = DevSigner.random('alice.testnet')
  const a = deriveVaultKeys(signer.signMessage(unlockParams('alice.testnet')))
  const b = deriveVaultKeys(signer.signMessage(unlockParams('alice.testnet')))
  assert.equal(a.check, b.check)
  assert.match(a.check, /^[0-9a-f]{32}$/)
})

test('another wallet key gives another check', () => {
  const a = deriveVaultKeys(DevSigner.random('alice.testnet').signMessage(unlockParams('alice.testnet')))
  const b = deriveVaultKeys(DevSigner.random('alice.testnet').signMessage(unlockParams('alice.testnet')))
  assert.notEqual(a.check, b.check)
})

test('a signature for a different message or account is refused', () => {
  const signer = DevSigner.random('alice.testnet')
  const wrongMessage = signer.signMessage({ ...unlockParams('alice.testnet'), message: 'something else' })
  assert.throws(() => deriveVaultKeys(wrongMessage), /does not verify/)
  const otherAccount = { ...signer.signMessage(unlockParams('alice.testnet')), accountId: 'mallory.testnet' }
  assert.throws(() => deriveVaultKeys(otherAccount), /does not verify/)
})

test('NEP-413 verification rejects a flipped signature byte', () => {
  const signer = DevSigner.random('alice.testnet')
  const params = unlockParams('alice.testnet')
  const signed = signer.signMessage(params)
  assert.ok(verifyNep413(signed, params))
  const bytes = Buffer.from(signed.signature, 'base64')
  bytes[0] = bytes[0]! ^ 1
  assert.equal(verifyNep413({ ...signed, signature: bytes.toString('base64') }, params), false)
})
