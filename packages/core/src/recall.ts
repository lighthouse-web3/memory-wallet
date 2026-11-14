import { rankMemories, type QueryVector } from './lighthouse-memory.ts'
import type { Memory } from './vault.ts'

/**
 * Picks the memories to put in front of the model.
 *
 * Grants are the real filter: when the granted scopes hold only a few memories, all of them go in
 * (no ranking would put "I'm vegetarian" first for "plan my trip", and the model needs it). Past
 * `allBelow`, Lighthouse Memory's recall ranking picks the top `limit` — semantic when the query
 * comes with a vector from the same embedder, keyword otherwise — so only what's relevant leaves
 * the browser.
 */
export function selectMemories<T extends Memory>(
  query: string,
  memories: T[],
  opts: { limit?: number; allBelow?: number; queryVector?: QueryVector } = {},
): T[] {
  const limit = opts.limit ?? 12
  const allBelow = opts.allBelow ?? 12
  if (memories.length <= allBelow) return [...memories].sort((a, b) => b.createdAt - a.createdAt)
  return rankMemories(query, memories, opts.queryVector)
    .slice(0, limit)
    .map((hit) => hit.memory)
}
