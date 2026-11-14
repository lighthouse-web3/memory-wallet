/**
 * Lighthouse Memory, run on-device.
 *
 * The wallet keeps memories in the Lighthouse Memory SDK's record format (`MemoryRecord` from
 * `@lighthouse-ai/core`), embeds them with the SDK's default embedder (MiniLM, same model, dtype
 * and rounding as `@lighthouse-ai/embed-local`, so vectors are interchangeable), and recalls them
 * with the SDK's own scoring (`@lighthouse-ai/core` scoring + the batched engine's 0.7/0.3 blend).
 *
 * The difference from the hosted service: all of this happens in the browser, over memories that
 * were decrypted here. Records and their embeddings are sealed before they leave (embeddings leak
 * meaning), and Lighthouse storage only ever receives ciphertext.
 */
import type { Embedder, MemoryRecord } from '@lighthouse-ai/core'
import { cosine, keywordScore } from '@lighthouse-ai/core/dist/scoring.js'
import type { Memory } from './vault.ts'

/** `@lighthouse-ai/embed-local`'s id for its default model. */
export const LIGHTHOUSE_EMBEDDER_ID = 'local:Xenova/all-MiniLM-L6-v2'
export const LIGHTHOUSE_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'
/** What a v2 snapshot holds. */
export const RECORD_FORMAT = 'lighthouse-memory/MemoryRecord@1'

export type { Embedder, MemoryRecord }

export function toRecord(m: Memory, scope: string): MemoryRecord {
  return {
    v: 1,
    id: m.id,
    namespace: scope,
    agent: m.source,
    content: m.text,
    tags: m.tags,
    metadata: {},
    createdAt: new Date(m.createdAt).toISOString(),
    ...(m.embedding ? { embedding: m.embedding, embeddingModel: m.embeddingModel } : {}),
    origin: 'batched',
  }
}

export function fromRecord(r: MemoryRecord): Memory {
  const createdAt = Date.parse(r.createdAt)
  return {
    id: r.id,
    text: r.content,
    tags: r.tags ?? [],
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    source: r.agent || 'vault',
    ...(r.embedding ? { embedding: r.embedding, embeddingModel: r.embeddingModel } : {}),
  }
}

export interface QueryVector {
  vector: number[]
  model: string
}

export interface RecallHit<T> {
  memory: T
  score: number
  /** 'semantic' = cosine + keyword (the vectors matched); 'keyword' = keyword score alone. */
  how: 'semantic' | 'keyword'
}

/**
 * Lighthouse Memory's recall ranking (engine-batched): `0.7·max(0, cosine) + 0.3·min(1, keyword)`
 * when the memory and the query were embedded by the same model, keyword score alone otherwise.
 */
export function rankMemories<T extends Memory>(query: string, memories: T[], q?: QueryVector): RecallHit<T>[] {
  return memories
    .map((memory) => {
      const kw = keywordScore(query, memory.text, memory.tags)
      if (q && memory.embedding && memory.embeddingModel === q.model) {
        return { memory, score: 0.7 * Math.max(0, cosine(q.vector, memory.embedding)) + 0.3 * Math.min(1, kw), how: 'semantic' as const }
      }
      return { memory, score: kw, how: 'keyword' as const }
    })
    .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
}
