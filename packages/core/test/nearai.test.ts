import { ed25519 } from '@noble/curves/ed25519.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  E2EEClientKey,
  checkModelReport,
  decryptWithX25519,
  encryptToEd25519,
  fromHex,
  looksE2EE,
  parseTdxQuote,
  toHex,
  type AttestationResponse,
} from '../src/index.ts'

// A real report from cloud-api.near.ai for z-ai/glm-5.3-flash, fetched with the nonce below.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/glm-5.3-flash-attestation.json', import.meta.url), 'utf8')) as AttestationResponse
const NONCE = 'd759647f8776e500fbb1912362bd58339df8e4c6997294d63bc2ede61fc92f98'
const report = fixture.model_attestations![0]!

test('E2EE v2 round trip: client → model key, model → client key', () => {
  // Stand-in for the model TEE: an Ed25519 key whose public half we "attested".
  const modelSecret = ed25519.utils.randomSecretKey()
  const modelPub = toHex(ed25519.getPublicKey(modelSecret))
  const wire = encryptToEd25519('I am vegetarian. Plan Goa.', modelPub)
  assert.ok(looksE2EE(wire))
  assert.equal(decryptWithX25519(wire, ed25519.utils.toMontgomerySecret(modelSecret)), 'I am vegetarian. Plan Goa.')

  const client = E2EEClientKey.generate()
  const reply = encryptToEd25519('Here is a veg-friendly Goa plan.', client.publicKeyHex)
  assert.equal(client.decrypt(reply), 'Here is a veg-friendly Goa plan.')
  assert.throws(() => E2EEClientKey.generate().decrypt(reply))
})

test('wire format: ephemeral key (32) | nonce (24) | ciphertext + tag', () => {
  const pub = toHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
  const wire = fromHex(encryptToEd25519('abc', pub))
  assert.equal(wire.length, 32 + 24 + 3 + 16)
  assert.equal(looksE2EE('hello, plaintext'), false)
})

test('TDX quote fields parse from a real NEAR AI report', () => {
  const q = parseTdxQuote(fromHex(report.intel_quote))
  assert.equal(q.version, 4)
  assert.equal(q.teeType, 0x81)
  assert.equal(toHex(q.reportData), report.signing_address + NONCE)
})

test('a real model report passes every local check', async () => {
  const v = await checkModelReport(report, NONCE)
  const byId = Object.fromEntries(v.checks.map((c) => [c.id, c.status]))
  assert.deepEqual(byId, { nonce: 'pass', signer: 'pass', quote: 'pass', 'report-data': 'pass', config: 'pass', rtmr3: 'pass', intel: 'skipped', gpu: 'skipped' })
  assert.equal(v.accepted, true)
  assert.equal(v.signingPublicKey, report.signing_address)
})

test('a stale nonce or a swapped key is refused', async () => {
  const stale = await checkModelReport(report, 'ab'.repeat(32))
  assert.equal(stale.accepted, false)
  assert.equal(stale.checks.find((c) => c.id === 'report-data')?.status, 'fail')

  const otherKey = toHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
  const swapped = await checkModelReport({ ...report, signing_address: otherKey, signing_public_key: otherKey }, NONCE)
  assert.equal(swapped.accepted, false)
})

test('a quote verifier verdict is applied', async () => {
  const ok = await checkModelReport(report, NONCE, { quoteVerifier: async () => ({ status: 'UpToDate' }) })
  assert.equal(ok.checks.find((c) => c.id === 'intel')?.status, 'pass')
  const revoked = await checkModelReport(report, NONCE, { quoteVerifier: async () => ({ status: 'Revoked' }) })
  assert.equal(revoked.accepted, false)
})
