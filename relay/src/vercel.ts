/**
 * The relay as one Vercel function, mounted at /api on the same domain as the vault
 * (so the vault calls it without CORS). Bundled by scripts/vercel-build.mjs.
 */
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { createRelay } from './app.ts'
import { LighthouseSealedStore, type SealedStore } from './storage.ts'

const env = process.env

/** Vercel functions have no lasting disk, so without a Lighthouse key saving is off (and says so). */
const noStore: SealedStore = {
  name: 'none',
  put: async () => {
    throw new Error('this deployment has no LIGHTHOUSE_API_KEY')
  },
  get: async () => {
    throw new Error('this deployment has no LIGHTHOUSE_API_KEY')
  },
  publicUrl: () => null,
}

const relay = createRelay({
  store: env.LIGHTHOUSE_API_KEY ? new LighthouseSealedStore(env.LIGHTHOUSE_API_KEY, env.LIGHTHOUSE_NETWORK || 'ipfs-filecoin') : noStore,
  corsOrigins: (env.RELAY_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  nearai: { baseUrl: env.NEARAI_BASE_URL || 'https://cloud-api.near.ai', apiKey: env.NEARAI_API_KEY ?? '' },
  limits: {
    models: (env.NEARAI_MODELS || 'z-ai/glm-5.3-flash').split(',').map((s) => s.trim()),
    maxTokens: 2000,
    maxChatBytes: 256 * 1024,
    chatPerMinute: Number(env.RELAY_CHAT_PER_MINUTE || 20),
    blobsPerMinute: Number(env.RELAY_BLOBS_PER_MINUTE || 60),
  },
})

const app = new Hono().route('/api', relay)

export default getRequestListener(app.fetch)
