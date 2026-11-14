import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DevSigner,
  LocalRegistry,
  Vault,
  additionalData,
  deriveVaultKeys,
  open,
  seal,
  selectMemories,
  unlockParams,
  utf8,
  type BlobStore,
} from '../src/index.ts'

class MemoryStore implements BlobStore {
  blobs = new Map<string, Uint8Array>()
  async put(sealed: Uint8Array) {
    const cid = `bafk${this.blobs.size}test${Math.random().toString(36).slice(2, 8)}`
    this.blobs.set(cid, sealed)
    return cid
  }
  async get(cid: string) {
    const b = this.blobs.get(cid)
    if (!b) throw new Error('missing')
    return b
  }
}

class MapStorage {
  m = new Map<string, string>()
  getItem = (k: string) => this.m.get(k) ?? null
  setItem = (k: string, v: string) => void this.m.set(k, v)
  removeItem = (k: string) => void this.m.delete(k)
}

const keysFor = (signer: DevSigner) => deriveVaultKeys(signer.signMessage(unlockParams(signer.accountId)))

test('memories round-trip through sealed snapshots and the registry', async () => {
  const signer = DevSigner.random('alice.testnet')
  const store = new MemoryStore()
  const registry = new LocalRegistry(new MapStorage())

  const vault = new Vault(keysFor(signer), store)
  vault.remember('travel', 'Prefers window seats and no red-eye flights.')
  vault.remember('food', 'Vegetarian; loves South Indian food.')
  const roots = await vault.prepareSave()
  await registry.submit('alice.testnet', roots.map((r) => ({ method: 'set_root' as const, args: { ...r } })))
  vault.commit(roots)
  assert.deepEqual(vault.dirtyScopes(), [])

  for (const blob of store.blobs.values()) {
    assert.equal(new TextDecoder().decode(blob).includes('window seats'), false, 'blobs hold no plaintext')
  }

  const reopened = new Vault(keysFor(signer), store)
  const record = await registry.getVault('alice.testnet')
  assert.deepEqual(await reopened.load(record!.roots), [])
  assert.deepEqual(reopened.scopeNames(), ['food', 'travel'])
  assert.equal(reopened.memories(['travel'])[0]!.text, 'Prefers window seats and no red-eye flights.')
})

test('a different wallet cannot open the snapshots', async () => {
  const store = new MemoryStore()
  const vault = new Vault(keysFor(DevSigner.random('alice.testnet')), store)
  vault.remember('health', 'Allergic to penicillin.')
  const roots = await vault.prepareSave()

  const intruder = new Vault(keysFor(DevSigner.random('alice.testnet')), store)
  const failed = await intruder.load(roots)
  assert.equal(failed.length, 1)
  assert.match(failed[0]!.error, /could not decrypt/)
})

test('a sealed blob is bound to its owner and scope', async () => {
  const keys = keysFor(DevSigner.random('alice.testnet'))
  const key = await keys.scopeKey('travel')
  const sealed = await seal(key, utf8('hello'), additionalData('alice.testnet', 'travel'))
  await assert.rejects(open(key, sealed, additionalData('alice.testnet', 'health')), /could not decrypt/)
  await assert.rejects(open(key, sealed, additionalData('bob.testnet', 'travel')), /could not decrypt/)
  const tampered = sealed.slice()
  tampered[tampered.length - 1]! ^= 1
  await assert.rejects(open(key, tampered, additionalData('alice.testnet', 'travel')), /could not decrypt/)
})

test('dev registry enforces grant expiry and revocation like the contract', async () => {
  let now = 1_000
  const registry = new LocalRegistry(new MapStorage(), () => now)
  const app = 'http://localhost:5174'
  await registry.submit('alice.testnet', [{ method: 'grant', args: { app, scopes: ['travel', 'food'], write: false, ttl_minutes: 5 } }])
  assert.deepEqual((await registry.getGrant('alice.testnet', app))?.scopes, ['food', 'travel'])
  now += 5 * 60_000
  assert.equal(await registry.getGrant('alice.testnet', app), null)

  await registry.submit('alice.testnet', [{ method: 'grant', args: { app, scopes: ['travel'], write: false, ttl_minutes: 5 } }])
  await registry.submit('alice.testnet', [{ method: 'revoke', args: { app } }])
  assert.equal(await registry.getGrant('alice.testnet', app), null)
  await assert.rejects(registry.submit('alice.testnet', [{ method: 'set_check', args: { check: 'a'.repeat(32) } }, { method: 'set_check', args: { check: 'b'.repeat(32) } }]), /different key check/)
})

test('small grants send every memory; large ones rank by overlap', () => {
  const mk = (i: number, text: string) => ({ id: String(i), text, tags: [], createdAt: i, source: 'vault', scope: 'travel' })
  const few = [mk(1, 'Vegetarian'), mk(2, 'Window seat')]
  assert.equal(selectMemories('plan a trip to Goa', few).length, 2)

  const many = Array.from({ length: 60 }, (_, i) => mk(i, `filler memory number ${i}`))
  many.push(mk(100, 'Loves beaches in Goa'))
  const picked = selectMemories('plan a trip to Goa', many, { limit: 5 })
  assert.equal(picked[0]!.text, 'Loves beaches in Goa')
})
