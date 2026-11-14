import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  additionalData,
  DevSigner,
  deriveVaultKeys,
  fromRecord,
  LIGHTHOUSE_EMBEDDER_ID,
  open,
  rankMemories,
  RECORD_FORMAT,
  seal,
  toRecord,
  unlockParams,
  utf8,
  fromUtf8,
  Vault,
  type BlobStore,
  type Embedder,
} from '../src/index.ts'

class MemStore implements BlobStore {
  blobs = new Map<string, Uint8Array>()
  async put(sealed: Uint8Array) {
    const cid = `bafk${this.blobs.size}xxxxxxxx`
    this.blobs.set(cid, sealed)
    return cid
  }
  async get(cid: string) {
    return this.blobs.get(cid)!
  }
}

async function keysFor(account: string) {
  const signer = DevSigner.random(account)
  return deriveVaultKeys(await signer.signMessage(unlockParams(account)))
}

/** A stand-in for MiniLM: 2-d vectors, food-ish vs travel-ish. */
const fakeEmbedder: Embedder = {
  id: LIGHTHOUSE_EMBEDDER_ID,
  async embed(texts) {
    return texts.map((t) => (/veg|food|dinner|curry/i.test(t) ? [1, 0] : [0, 1]))
  },
}

test('memories round-trip through the SDK MemoryRecord shape', () => {
  const m = { id: 'a1', text: 'Vegetarian', tags: ['diet'], createdAt: 1_700_000_000_000, source: 'https://app.example', embedding: [0.1, 0.2], embeddingModel: LIGHTHOUSE_EMBEDDER_ID }
  const r = toRecord(m, 'food')
  assert.deepEqual(
    { v: r.v, namespace: r.namespace, agent: r.agent, content: r.content, origin: r.origin, createdAt: r.createdAt },
    { v: 1, namespace: 'food', agent: 'https://app.example', content: 'Vegetarian', origin: 'batched', createdAt: '2023-11-14T22:13:20.000Z' },
  )
  assert.deepEqual(fromRecord(r), m)
})

test('snapshots are sealed SDK records, embeddings included, and v1 snapshots still open', async () => {
  const keys = await keysFor('alice.testnet')
  const store = new MemStore()
  const vault = new Vault(keys, store)
  vault.remember('food', 'Vegetarian, loves curry')
  assert.equal(await vault.embedMissing(fakeEmbedder), 1)
  const [root] = await vault.prepareSave()

  const snapshot = JSON.parse(fromUtf8(await open(await keys.scopeKey('food'), store.blobs.get(root!.cid)!, additionalData('alice.testnet', 'food'))))
  assert.equal(snapshot.v, 2)
  assert.equal(snapshot.format, RECORD_FORMAT)
  assert.deepEqual(snapshot.records[0].embedding, [1, 0])
  assert.equal(snapshot.records[0].embeddingModel, LIGHTHOUSE_EMBEDDER_ID)

  // A blob written by the first version of the wallet.
  const v1 = { v: 1, owner: 'alice.testnet', scope: 'travel', updatedAt: 1, memories: [{ id: 'x', text: 'Window seat', tags: [], createdAt: 5, source: 'vault' }] }
  const v1Cid = await store.put(await seal(await keys.scopeKey('travel'), utf8(JSON.stringify(v1)), additionalData('alice.testnet', 'travel')))
  const reopened = new Vault(keys, store)
  assert.deepEqual(await reopened.load([root!, { scope: 'travel', cid: v1Cid, count: 1 }]), [])
  assert.deepEqual(reopened.memories().map((m) => m.text).sort(), ['Vegetarian, loves curry', 'Window seat'])
  assert.equal(reopened.unembedded(LIGHTHOUSE_EMBEDDER_ID), 1)
})

test('recall uses the SDK blend: 0.7·cosine + 0.3·keyword when the vectors match', () => {
  const mk = (id: string, text: string, embedding?: number[]) => ({ id, text, tags: [], createdAt: 1, source: 'vault', ...(embedding ? { embedding, embeddingModel: LIGHTHOUSE_EMBEDDER_ID } : {}) })
  const memories = [mk('t', 'Window seat, no red-eyes', [0, 1]), mk('f', 'Vegetarian', [1, 0]), mk('k', 'dinner plans are hard')]
  const hits = rankMemories('book me a dinner', memories, { vector: [1, 0], model: LIGHTHOUSE_EMBEDDER_ID })
  assert.equal(hits[0]!.memory.id, 'f')
  assert.equal(hits[0]!.how, 'semantic')
  assert.ok(Math.abs(hits[0]!.score - 0.7) < 1e-9)
  assert.equal(hits.find((h) => h.memory.id === 'k')!.how, 'keyword')
})
