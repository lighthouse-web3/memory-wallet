import { LIGHTHOUSE_EMBED_MODEL, LIGHTHOUSE_EMBEDDER_ID, type Embedder, type QueryVector } from '@memory-wallet/core'

type FeatureExtraction = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>

/**
 * `@lighthouse-ai/embed-local`'s LocalEmbedder, running in this browser: same model, q8 weights,
 * mean pooling, normalized and rounded to 1e-5, so the vectors match what the SDK produces. The
 * model downloads once (about 23 MB) and every embedding is computed on-device.
 */
class BrowserEmbedder implements Embedder {
  readonly id = LIGHTHOUSE_EMBEDDER_ID
  status: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private pipe: Promise<FeatureExtraction> | null = null

  private load(): Promise<FeatureExtraction> {
    this.pipe ??= (async () => {
      this.status = 'loading'
      try {
        const { pipeline } = await import('@huggingface/transformers')
        const pipe = (await (pipeline as (...args: unknown[]) => Promise<unknown>)('feature-extraction', LIGHTHOUSE_EMBED_MODEL, {
          dtype: 'q8',
        })) as FeatureExtraction
        this.status = 'ready'
        return pipe
      } catch (err) {
        this.status = 'failed'
        this.pipe = null
        throw err
      }
    })()
    return this.pipe
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return []
    const pipe = await this.load()
    const out = await pipe(texts, { pooling: 'mean', normalize: true })
    return out.tolist().map((v) => v.map((x) => Math.round(x * 1e5) / 1e5))
  }
}

export const embedder = new BrowserEmbedder()

/** A query vector, or null when the model can't load (offline): recall then ranks by keywords. */
export async function embedQuery(text: string): Promise<QueryVector | null> {
  try {
    const [vector] = await embedder.embed([text])
    return vector ? { vector, model: embedder.id } : null
  } catch {
    return null
  }
}
