import { fromUtf8, randomBytes, toHex, utf8 } from './bytes.ts'
import { additionalData, open, seal } from './envelope.ts'
import type { VaultKeys } from './keys.ts'
import { fromRecord, RECORD_FORMAT, toRecord, type Embedder, type MemoryRecord } from './lighthouse-memory.ts'

export interface Memory {
  id: string
  text: string
  tags: string[]
  createdAt: number
  /** Who wrote it: "vault" or an app origin. */
  source: string
  /** Lighthouse Memory embedding, computed in the browser and sealed with the memory. */
  embedding?: number[]
  embeddingModel?: string
}

export interface ScopedMemory extends Memory {
  scope: string
}

/** What one encrypted blob holds: every memory in one scope, as Lighthouse Memory records. */
export interface ScopeSnapshot {
  v: 2
  owner: string
  scope: string
  updatedAt: number
  format: typeof RECORD_FORMAT
  records: MemoryRecord[]
}

/** The first format (still readable). */
interface ScopeSnapshotV1 {
  v: 1
  owner: string
  scope: string
  updatedAt: number
  memories: Memory[]
}

/** A scope's pointer as the registry contract stores it. */
export interface ScopeRoot {
  scope: string
  cid: string
  count: number
  updated_at_ms?: number
}

export interface BlobStore {
  put(sealed: Uint8Array): Promise<string>
  get(cid: string): Promise<Uint8Array>
  /** Where anyone can fetch the (encrypted) blob, for showing it's ciphertext. */
  publicUrl?(cid: string): string
}

export const SCOPE_PATTERN = /^[a-z0-9_-]{1,32}$/
export const MAX_MEMORY_CHARS = 2000

interface ScopeState {
  memories: Memory[]
  cid?: string
  dirty: boolean
}

export class Vault {
  private readonly scopes = new Map<string, ScopeState>()

  constructor(
    readonly keys: VaultKeys,
    private readonly store: BlobStore,
  ) {}

  get owner(): string {
    return this.keys.accountId
  }

  /** Fetches and decrypts every scope the registry points at. One bad scope doesn't block the rest. */
  async load(roots: ScopeRoot[]): Promise<{ scope: string; error: string }[]> {
    const failed: { scope: string; error: string }[] = []
    await Promise.all(
      roots.map(async (root) => {
        try {
          const sealed = await this.store.get(root.cid)
          const key = await this.keys.scopeKey(root.scope)
          const snapshot = JSON.parse(fromUtf8(await open(key, sealed, additionalData(this.owner, root.scope)))) as ScopeSnapshot | ScopeSnapshotV1
          if (snapshot.owner !== this.owner || snapshot.scope !== root.scope) throw new Error('snapshot header mismatch')
          let memories: Memory[]
          if (snapshot.v === 2 && snapshot.format === RECORD_FORMAT) memories = snapshot.records.map(fromRecord)
          else if (snapshot.v === 1) memories = snapshot.memories
          else throw new Error('unknown snapshot format')
          this.scopes.set(root.scope, { memories, cid: root.cid, dirty: false })
        } catch (err) {
          failed.push({ scope: root.scope, error: err instanceof Error ? err.message : String(err) })
        }
      }),
    )
    return failed
  }

  remember(scope: string, text: string, opts: { tags?: string[]; source?: string } = {}): Memory {
    if (!SCOPE_PATTERN.test(scope)) throw new Error('scope must be 1-32 characters of a-z, 0-9, - or _')
    const clean = text.trim()
    if (!clean) throw new Error('a memory needs some text')
    if (clean.length > MAX_MEMORY_CHARS) throw new Error(`a memory is at most ${MAX_MEMORY_CHARS} characters`)
    const memory: Memory = {
      id: toHex(randomBytes(8)),
      text: clean,
      tags: (opts.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
      createdAt: Date.now(),
      source: opts.source ?? 'vault',
    }
    const state = this.scopes.get(scope) ?? { memories: [], dirty: true }
    state.memories.push(memory)
    state.dirty = true
    this.scopes.set(scope, state)
    return memory
  }

  forget(scope: string, id: string): boolean {
    const state = this.scopes.get(scope)
    if (!state) return false
    const before = state.memories.length
    state.memories = state.memories.filter((m) => m.id !== id)
    state.dirty ||= state.memories.length !== before
    return state.memories.length !== before
  }

  scopeNames(): string[] {
    return [...this.scopes.keys()].sort()
  }

  memories(scopes?: string[]): ScopedMemory[] {
    const wanted = scopes ? new Set(scopes) : null
    const out: ScopedMemory[] = []
    for (const [scope, state] of this.scopes) {
      if (wanted && !wanted.has(scope)) continue
      for (const m of state.memories) out.push({ ...m, scope })
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  cid(scope: string): string | undefined {
    return this.scopes.get(scope)?.cid
  }

  dirtyScopes(): string[] {
    return [...this.scopes].filter(([, s]) => s.dirty).map(([scope]) => scope)
  }

  /** How many memories have no embedding from this embedder yet. */
  unembedded(embedderId: string): number {
    let n = 0
    for (const state of this.scopes.values()) for (const m of state.memories) if (m.embeddingModel !== embedderId) n++
    return n
  }

  /**
   * Embeds every memory that has no vector from `embedder` yet (in this browser), and marks those
   * scopes changed so the vectors get sealed and saved with them. Returns how many were embedded.
   */
  async embedMissing(embedder: Embedder): Promise<number> {
    let count = 0
    for (const state of this.scopes.values()) {
      const todo = state.memories.filter((m) => m.embeddingModel !== embedder.id)
      if (!todo.length) continue
      const vectors = await embedder.embed(todo.map((m) => m.text))
      todo.forEach((m, i) => {
        m.embedding = vectors[i]
        m.embeddingModel = embedder.id
      })
      state.dirty = true
      count += todo.length
    }
    return count
  }

  /**
   * Encrypts and uploads every changed scope. Returns the new roots for the registry; call
   * `commit` once the registry transaction lands, so a failed transaction leaves them dirty.
   */
  async prepareSave(): Promise<ScopeRoot[]> {
    const roots: ScopeRoot[] = []
    for (const scope of this.dirtyScopes()) {
      const state = this.scopes.get(scope)!
      const snapshot: ScopeSnapshot = {
        v: 2,
        owner: this.owner,
        scope,
        updatedAt: Date.now(),
        format: RECORD_FORMAT,
        records: state.memories.map((m) => toRecord(m, scope)),
      }
      const key = await this.keys.scopeKey(scope)
      const sealed = await seal(key, utf8(JSON.stringify(snapshot)), additionalData(this.owner, scope))
      roots.push({ scope, cid: await this.store.put(sealed), count: state.memories.length })
    }
    return roots
  }

  commit(roots: ScopeRoot[]): void {
    for (const root of roots) {
      const state = this.scopes.get(root.scope)
      if (state) {
        state.cid = root.cid
        state.dirty = false
      }
    }
  }
}

/** Talks to the relay, which stores sealed blobs on Lighthouse and refuses anything else. */
export class RelayBlobStore implements BlobStore {
  constructor(private readonly relayUrl: string) {}

  async put(sealed: Uint8Array): Promise<string> {
    const res = await fetch(`${this.relayUrl}/blobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Blob([new Uint8Array(sealed)]),
    })
    const body = (await res.json().catch(() => ({}))) as { cid?: string; error?: string }
    if (!res.ok || !body.cid) throw new Error(body.error ?? `upload failed (${res.status})`)
    return body.cid
  }

  async get(cid: string): Promise<Uint8Array> {
    const res = await fetch(`${this.relayUrl}/blobs/${encodeURIComponent(cid)}`)
    if (!res.ok) throw new Error(`could not fetch ${cid} (${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  }

  publicUrl(cid: string): string {
    return `${this.relayUrl}/blobs/${encodeURIComponent(cid)}/public`
  }
}
