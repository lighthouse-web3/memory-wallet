import { DevSigner, Vault, deriveVaultKeys, encryptToEd25519, unlockParams } from '@memory-wallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRelay } from '../src/app.ts'
import { LocalSealedStore, cidV1Raw } from '../src/storage.ts'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const modelKey = hex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
const clientKey = hex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))

async function relay(opts: { apiKey?: string; upstream?: typeof fetch } = {}) {
  const store = new LocalSealedStore(await mkdtemp(join(tmpdir(), 'mw-relay-')))
  const calls: { url: string; init: RequestInit }[] = []
  const app = createRelay({
    store,
    corsOrigins: ['http://localhost:5173'],
    nearai: { baseUrl: 'https://nearai.test', apiKey: opts.apiKey ?? '' },
    log: () => {},
    fetchImpl:
      opts.upstream ??
      (async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return new Response('{"id":"chatcmpl-1","choices":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
      }),
  })
  return { app, calls }
}

const e2eeHeaders = {
  'content-type': 'application/json',
  'x-signing-algo': 'ed25519',
  'x-client-pub-key': clientKey,
  'x-model-pub-key': modelKey,
  'x-encryption-version': '2',
}

test('stores sealed blobs and gives back the same bytes', async () => {
  const { app } = await relay()
  const keys = deriveVaultKeys(DevSigner.random('alice.testnet').signMessage(unlockParams('alice.testnet')))
  let sealed: Uint8Array | undefined
  const vault = new Vault(keys, { put: async (b) => ((sealed = b), 'x'), get: async () => sealed! })
  vault.remember('travel', 'Window seat please.')
  await vault.prepareSave()

  const put = await app.request('/blobs', { method: 'POST', body: new Uint8Array(sealed!), headers: { 'content-type': 'application/octet-stream' } })
  assert.equal(put.status, 200)
  const { cid } = (await put.json()) as { cid: string }
  assert.match(cid, /^bafkrei/)

  const got = await app.request(`/blobs/${cid}`)
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), sealed)
})

test('refuses blobs that are not sealed', async () => {
  const { app } = await relay()
  const res = await app.request('/blobs', { method: 'POST', body: 'I am vegetarian and live in Bangalore', headers: { 'content-type': 'application/octet-stream' } })
  assert.equal(res.status, 400)
})

test('refuses plaintext chat and never forwards it', async () => {
  const { app, calls } = await relay({ apiKey: 'sk-test' })
  const res = await app.request('/nearai/v1/chat/completions', {
    method: 'POST',
    headers: e2eeHeaders,
    body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'my memories in plaintext' }] }),
  })
  assert.equal(res.status, 400)
  assert.match(((await res.json()) as { error: string }).error, /plaintext refused/)
  assert.equal(calls.length, 0)
})

test('forwards encrypted chat byte-for-byte with the API key', async () => {
  const { app, calls } = await relay({ apiKey: 'sk-test' })
  const body = JSON.stringify({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: encryptToEd25519('hi', modelKey) }], stream: false })
  const res = await app.request('/nearai/v1/chat/completions', { method: 'POST', headers: e2eeHeaders, body })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '{"id":"chatcmpl-1","choices":[]}')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'https://nearai.test/v1/chat/completions')
  assert.equal(calls[0]!.init.body, body)
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer sk-test')
  assert.equal(headers['x-model-pub-key'], modelKey)
})

test('without a NEAR AI key, chat is off', async () => {
  const { app } = await relay()
  const res = await app.request('/nearai/v1/chat/completions', { method: 'POST', headers: e2eeHeaders, body: '{}' })
  assert.equal(res.status, 503)
})

test('local CIDs are CIDv1 raw sha2-256', () => {
  assert.equal(cidV1Raw(new TextEncoder().encode('hello')), 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq')
})
