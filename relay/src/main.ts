import { serve } from '@hono/node-server'
import { resolve } from 'node:path'
import { createRelay } from './app.ts'
import { LighthouseSealedStore, LocalSealedStore } from './storage.ts'

const env = process.env
const port = Number(env.RELAY_PORT ?? 8787)

const store = env.LIGHTHOUSE_API_KEY
  ? new LighthouseSealedStore(env.LIGHTHOUSE_API_KEY, env.LIGHTHOUSE_NETWORK || 'ipfs-filecoin')
  : new LocalSealedStore(resolve(import.meta.dirname, '../../.data/blobs'))

const app = createRelay({
  store,
  corsOrigins: (env.RELAY_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174').split(',').map((s) => s.trim()).filter(Boolean),
  nearai: { baseUrl: env.NEARAI_BASE_URL || 'https://cloud-api.near.ai', apiKey: env.NEARAI_API_KEY ?? '' },
})

serve({ fetch: app.fetch, port }, () => {
  console.log(`relay on http://localhost:${port}`)
  console.log(`  storage: ${store.name}${store instanceof LocalSealedStore ? ' (set LIGHTHOUSE_API_KEY to store on Lighthouse)' : ''}`)
  console.log(`  NEAR AI: ${env.NEARAI_API_KEY ? 'key set — private inference on' : 'no NEARAI_API_KEY — private inference off'}`)
})
