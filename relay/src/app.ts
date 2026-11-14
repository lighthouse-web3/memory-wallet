import { MAX_SEALED_BYTES, looksE2EE, looksSealed } from '@memory-wallet/core'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { LocalSealedStore, type SealedStore } from './storage.ts'

/**
 * The relay holds the two secrets a browser shouldn't: the Lighthouse API key and the NEAR AI
 * API key. It is built so that holding them never means seeing a memory:
 *  - POST /blobs accepts only Memory Wallet sealed blobs (AES-GCM, keyed in the user's browser);
 *  - POST /nearai/v1/chat/completions forwards only requests whose every message is E2EE
 *    ciphertext for an attested model key, and passes the bytes through untouched so NEAR AI's
 *    response signature still verifies in the browser.
 * It never logs bodies.
 */

export interface RelayConfig {
  store: SealedStore
  corsOrigins: string[]
  nearai: { baseUrl: string; apiKey: string }
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

const CID = /^[a-zA-Z0-9]{8,100}$/
const HEX32 = /^[0-9a-f]{64}$/i
const FORWARDED_E2EE_HEADERS = ['x-signing-algo', 'x-client-pub-key', 'x-model-pub-key', 'x-encryption-version'] as const

export function createRelay(cfg: RelayConfig) {
  const app = new Hono()
  const upstream = cfg.fetchImpl ?? fetch
  const log = cfg.log ?? ((line: string) => console.log(line))

  app.use('*', cors({ origin: cfg.corsOrigins, allowHeaders: ['content-type', 'x-no-aliasing', ...FORWARDED_E2EE_HEADERS], maxAge: 600 }))
  app.use('*', async (c, next) => {
    const started = Date.now()
    await next()
    log(`${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - started}ms`)
  })

  app.get('/health', (c) => c.json({ ok: true, storage: cfg.store.name, nearai: Boolean(cfg.nearai.apiKey) }))

  app.post('/blobs', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (declared > MAX_SEALED_BYTES) return c.json({ error: 'blob too large' }, 413)
    const body = new Uint8Array(await c.req.arrayBuffer())
    if (!looksSealed(body)) return c.json({ error: 'only Memory Wallet sealed blobs are accepted' }, 400)
    try {
      return c.json({ cid: await cfg.store.put(body) })
    } catch (err) {
      return c.json({ error: `storage failed: ${err instanceof Error ? err.message : String(err)}` }, 502)
    }
  })

  app.get('/blobs/:cid', async (c) => {
    const cid = c.req.param('cid')
    if (!CID.test(cid)) return c.json({ error: 'bad cid' }, 400)
    try {
      const bytes = await cfg.store.get(cid)
      return c.body(new Uint8Array(bytes), 200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' })
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
  })

  /** Shows the stored document exactly as anyone on IPFS would see it. */
  app.get('/blobs/:cid/public', async (c) => {
    const cid = c.req.param('cid')
    if (!CID.test(cid)) return c.json({ error: 'bad cid' }, 400)
    const url = cfg.store.publicUrl(cid)
    if (url) return c.redirect(url, 302)
    if (cfg.store instanceof LocalSealedStore) {
      try {
        return c.body(await cfg.store.readDocument(cid), 200, { 'content-type': 'application/json' })
      } catch {
        return c.json({ error: 'not found' }, 404)
      }
    }
    return c.json({ error: 'no public url' }, 404)
  })

  app.post('/nearai/v1/chat/completions', async (c) => {
    if (!cfg.nearai.apiKey) return c.json({ error: 'This relay has no NEARAI_API_KEY, so private inference is off.' }, 503)

    if (c.req.header('x-encryption-version') !== '2' || c.req.header('x-signing-algo') !== 'ed25519') {
      return c.json({ error: 'plaintext refused: send X-Encryption-Version: 2 and X-Signing-Algo: ed25519' }, 400)
    }
    if (!HEX32.test(c.req.header('x-client-pub-key') ?? '') || !HEX32.test(c.req.header('x-model-pub-key') ?? '')) {
      return c.json({ error: 'plaintext refused: X-Client-Pub-Key and X-Model-Pub-Key must be 32-byte hex keys' }, 400)
    }

    const raw = await c.req.text()
    let body: { messages?: { content?: unknown }[]; stream?: unknown; tools?: unknown; functions?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) return c.json({ error: 'messages required' }, 400)
    if (!body.messages.every((m) => looksE2EE(m?.content))) {
      return c.json({ error: 'plaintext refused: every message content must be E2EE ciphertext' }, 400)
    }
    if (body.tools || body.functions) return c.json({ error: 'tools are not encrypted in this mode; refused' }, 400)
    if (body.stream) return c.json({ error: 'streaming is not supported by this relay yet' }, 400)

    const headers: Record<string, string> = {
      authorization: `Bearer ${cfg.nearai.apiKey}`,
      'content-type': 'application/json',
      'accept-encoding': 'identity',
      'x-no-aliasing': 'true',
    }
    for (const h of FORWARDED_E2EE_HEADERS) headers[h] = c.req.header(h)!

    const res = await upstream(`${cfg.nearai.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: raw })
    return new Response(await res.arrayBuffer(), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
  })

  app.get('/nearai/v1/signature/:id', async (c) => {
    if (!cfg.nearai.apiKey) return c.json({ error: 'no NEARAI_API_KEY' }, 503)
    const id = c.req.param('id')
    if (!/^[\w.:-]{1,200}$/.test(id)) return c.json({ error: 'bad id' }, 400)
    const res = await upstream(`${cfg.nearai.baseUrl}/v1/signature/${encodeURIComponent(id)}?signing_algo=ed25519`, {
      headers: { authorization: `Bearer ${cfg.nearai.apiKey}`, accept: 'application/json' },
    })
    return new Response(await res.arrayBuffer(), { status: res.status, headers: { 'content-type': 'application/json' } })
  })

  return app
}
