import { MAX_MEMORY_CHARS, rankMemories, SCOPE_PATTERN, isBridgeMessage, type AppToVault, type ChatMessage, type ConnectRequest, type Grant, type VaultToApp } from '@memory-wallet/core'
import { useEffect, useRef, useState } from 'react'
import { TopBar } from './Brand.tsx'
import { embedQuery } from './embedder.ts'
import { errorText, relative } from './format.ts'
import { toProof } from './Proof.tsx'
import { askPrivately, save, type Unlocked } from './session.ts'

type Phase = 'checking' | 'approve' | 'ready' | 'revoked' | 'invalid'

/** A recall waiting for the user: nothing is sent to the app until they pick what to share. */
interface ShareRequest {
  id: string
  query: string
  how: 'semantic' | 'keyword'
  hits: { scope: string; text: string; score: number; picked: boolean }[]
}

interface LogLine {
  at: number
  text: string
  ok: boolean
}

const TTL_CHOICES = [
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 60 * 24 },
  { label: '7 days', minutes: 60 * 24 * 7 },
]

const covers = (g: Grant | null, req: ConnectRequest) =>
  !!g && req.scopes.every((s) => g.scopes.includes(s)) && (!req.write || g.write) && (!req.reveal || !!g.reveal)

const MAX_IMPORT = 500

function validMessages(v: unknown): v is ChatMessage[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 30 &&
    v.every((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.length <= 8000)
  )
}

/**
 * The vault window an app opens. It answers only the granted origin, re-reads the grant from the
 * registry on every request (so a revoke bites immediately), and returns answers — never memories.
 */
export function ConnectScreen({ u, request }: { u: Unlocked; request: ConnectRequest | null }) {
  const [phase, setPhase] = useState<Phase>(request ? 'checking' : 'invalid')
  const [grant, setGrant] = useState<Grant | null>(null)
  const [ttl, setTtl] = useState(TTL_CHOICES[0]!.minutes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<LogLine[]>([])
  const [share, setShare] = useState<ShareRequest | null>(null)
  const owner = u.wallet.accountId
  const addLog = (text: string, ok = true) => setLog((l) => [{ at: Date.now(), text, ok }, ...l].slice(0, 30))

  const badScopes = request?.scopes.filter((s) => !SCOPE_PATTERN.test(s)) ?? []

  useEffect(() => {
    if (!request || badScopes.length) return setPhase('invalid')
    u.registry
      .getGrant(owner, request.app)
      .then((g) => {
        setGrant(g)
        setPhase(covers(g, request) ? 'ready' : 'approve')
      })
      .catch((err) => setError(errorText(err)))
  }, [])

  const approve = async () => {
    if (!request) return
    setBusy(true)
    setError('')
    try {
      await u.registry.submit(owner, [
        { method: 'grant', args: { app: request.app, scopes: request.scopes, write: request.write, ttl_minutes: ttl, reveal: !!request.reveal } },
      ])
      const g = await u.registry.getGrant(owner, request.app)
      setGrant(g)
      setPhase(covers(g, request) ? 'ready' : 'approve')
      if (!covers(g, request)) setError('The grant was sent but does not show up on the registry yet. Try again in a moment.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const handlerRef = useRef<(e: MessageEvent) => void>(() => {})
  handlerRef.current = async (event: MessageEvent) => {
    if (!request || !window.opener || event.origin !== request.app || event.source !== window.opener || !isBridgeMessage(event.data)) return
    const reply = (msg: VaultToApp) => window.opener?.postMessage(msg, request.app)
    const data = event.data as AppToVault

    const current = await u.registry.getGrant(owner, request.app).catch(() => null)
    if (!current) {
      setPhase('revoked')
      addLog(`Refused a request: no active grant for ${request.app}`, false)
      return reply({ type: 'mw:error', id: data.id, code: 'not-granted', message: 'The user has not granted (or has revoked) access for this app.' })
    }

    if (data.type === 'mw:chat') {
      if (!validMessages(data.messages) || (data.system !== undefined && (typeof data.system !== 'string' || data.system.length > 4000))) {
        return reply({ type: 'mw:error', id: data.id, code: 'failed', message: 'Malformed chat request.' })
      }
      addLog(`Question from ${request.name} — answering with ${current.scopes.join(', ')} memories`)
      try {
        const memories = u.vault.memories(current.scopes)
        const res = await askPrivately({ appName: request.name, appSystem: data.system, memories, messages: data.messages })
        const proof = toProof(res.attestation, { chatId: res.chatId, memoriesUsed: res.memoriesUsed, scopes: current.scopes, signature: res.signature })
        addLog(`Answered inside the TEE using ${res.memoriesUsed} memories · signature ${res.signature.status}`)
        reply({ type: 'mw:reply', id: data.id, content: res.content, proof })
      } catch (err) {
        addLog(`Failed: ${errorText(err)}`, false)
        reply({ type: 'mw:error', id: data.id, code: 'failed', message: errorText(err) })
      }
    } else if (data.type === 'mw:recall') {
      if (!current.reveal) {
        addLog(`Refused to share memory text with ${request.name}: the grant is answers-only`, false)
        return reply({ type: 'mw:error', id: data.id, code: 'not-granted', message: 'This grant does not include memory text.' })
      }
      const query = typeof data.query === 'string' ? data.query.slice(0, 2000) : ''
      const limit = Math.min(Math.max(Number(data.limit) || 6, 1), 20)
      const pool = u.vault.memories(current.scopes)
      const vector = query.trim() ? await embedQuery(query) : null
      const hits = query.trim() ? rankMemories(query, pool, vector ?? undefined) : pool.map((memory) => ({ memory, score: 0, how: 'keyword' as const }))
      const chosen = hits.slice(0, limit)
      // Nothing leaves yet: the user picks what to share in this window (the app's page would see
      // everything we post to it, so the choice has to happen here).
      addLog(`${request.name} asked for memories about “${query.slice(0, 60)}”`)
      setShare({
        id: data.id,
        query,
        how: vector ? 'semantic' : 'keyword',
        hits: chosen.map((h) => ({ scope: h.memory.scope, text: h.memory.text, score: Math.round(h.score * 1000) / 1000, picked: true })),
      })
      window.focus()
    } else if (data.type === 'mw:import') {
      if (!current.write || !current.scopes.includes(data.scope)) {
        addLog(`Refused an import into "${data.scope}": not granted`, false)
        return reply({ type: 'mw:error', id: data.id, code: 'scope-not-granted', message: `No write access to "${data.scope}".` })
      }
      if (!Array.isArray(data.texts) || data.texts.length > MAX_IMPORT) {
        return reply({ type: 'mw:error', id: data.id, code: 'failed', message: `Send 1 to ${MAX_IMPORT} memories at a time.` })
      }
      const existing = new Set(u.vault.memories([data.scope]).map((m) => m.text))
      let added = 0
      let skipped = 0
      for (const raw of data.texts) {
        const text = typeof raw === 'string' ? raw.trim().slice(0, MAX_MEMORY_CHARS) : ''
        if (!text || existing.has(text)) {
          skipped++
          continue
        }
        u.vault.remember(data.scope, text, { source: request.app })
        existing.add(text)
        added++
      }
      try {
        if (added) await save(u)
        addLog(`Imported ${added} ${data.label ? `${String(data.label).slice(0, 40)} ` : ''}memories from ${request.name} into ${data.scope}${skipped ? ` (${skipped} already there)` : ''}`)
        reply({ type: 'mw:imported', id: data.id, added, skipped })
      } catch (err) {
        addLog(`Could not save the import: ${errorText(err)}`, false)
        reply({ type: 'mw:error', id: data.id, code: 'failed', message: errorText(err) })
      }
    } else if (data.type === 'mw:remember') {
      if (!current.write || !current.scopes.includes(data.scope)) {
        addLog(`Refused a write to "${data.scope}": not granted`, false)
        return reply({ type: 'mw:error', id: data.id, code: 'scope-not-granted', message: `No write access to "${data.scope}".` })
      }
      try {
        u.vault.remember(data.scope, String(data.text ?? ''), { source: request.app })
        await save(u)
        addLog(`Saved a ${data.scope} memory from ${request.name}`)
        reply({ type: 'mw:remembered', id: data.id })
      } catch (err) {
        addLog(`Could not save: ${errorText(err)}`, false)
        reply({ type: 'mw:error', id: data.id, code: 'failed', message: errorText(err) })
      }
    }
  }

  const answerShare = async (approve: boolean) => {
    if (!share || !request) return
    const picked = approve ? share.hits.filter((h) => h.picked) : []
    setShare(null)
    const reply = (msg: VaultToApp) => window.opener?.postMessage(msg, request.app)
    const current = await u.registry.getGrant(owner, request.app).catch(() => null)
    if (!current?.reveal) {
      setPhase('revoked')
      return reply({ type: 'mw:error', id: share.id, code: 'not-granted', message: 'Access was revoked.' })
    }
    if (!approve) {
      addLog(`Declined to share memories with ${request.name}`, false)
      return reply({ type: 'mw:error', id: share.id, code: 'failed', message: 'You declined in your wallet.' })
    }
    addLog(`Shared ${picked.length} ${picked.length === 1 ? 'memory' : 'memories'} (text) with ${request.name}`)
    reply({ type: 'mw:memories', id: share.id, memories: picked.map(({ scope, text, score }) => ({ scope, text, score })), how: share.how })
  }

  useEffect(() => {
    if (phase !== 'ready' || !request || !grant) return
    const onMessage = (e: MessageEvent) => handlerRef.current(e)
    window.addEventListener('message', onMessage)
    window.opener?.postMessage(
      { type: 'mw:ready', accountId: owner, scopes: grant.scopes, write: grant.write, reveal: !!grant.reveal, expiresAt: grant.expires_at_ms, registry: u.registry.label } satisfies VaultToApp,
      request.app,
    )
    addLog(`Connected to ${request.name}`)
    return () => window.removeEventListener('message', onMessage)
  }, [phase, grant])

  if (phase === 'invalid' || !request) {
    return (
      <main className="connect">
        <h1>This connection request is not valid</h1>
        <p className="muted">{badScopes.length ? `Bad scopes: ${badScopes.join(', ')}` : 'An app must open this page with its origin and the scopes it wants.'}</p>
      </main>
    )
  }

  return (
    <main className="connect">
      <TopBar right={<span className="mono muted">{owner}</span>} />

      {phase === 'checking' && <p className="muted">Checking the registry…</p>}

      {phase === 'approve' && (
        <>
          <h1>{request.name} wants to use your memory</h1>
          <p className="origin mono">{request.app}</p>
          <ul className="ask">
            <li>
              Scopes: <b>{request.scopes.join(', ')}</b> ({request.scopes.map((s) => `${u.vault.memories([s]).length} in ${s}`).join(', ')})
            </li>
            <li>{request.write ? 'It can also add memories to these scopes.' : 'Read only.'}</li>
            {request.reveal ? (
              <li className="warn">
                <b>It will see the text</b> of the memories it recalls from these scopes. This app runs outside a TEE, so only allow it if you
                trust it. The grant says so publicly on NEAR.
              </li>
            ) : (
              <li>It gets answers computed inside NEAR AI's TEE — never the memories themselves.</li>
            )}
          </ul>
          <div className="ttl">
            {TTL_CHOICES.map((c) => (
              <label key={c.minutes}>
                <input type="radio" name="ttl" checked={ttl === c.minutes} onChange={() => setTtl(c.minutes)} /> {c.label}
              </label>
            ))}
          </div>
          <button disabled={busy} onClick={approve}>
            {busy ? 'Waiting for the wallet…' : u.registry.kind === 'near' ? 'Grant on NEAR' : 'Grant (dev registry)'}
          </button>
        </>
      )}

      {phase === 'ready' && grant && (
        <>
          <h1>Connected to {request.name}</h1>
          <p className="muted">
            {grant.scopes.join(', ')} · {grant.write ? 'read + write' : 'read only'}
            {grant.reveal ? ' · sees memory text' : ' · TEE answers only'} · expires {relative(grant.expires_at_ms)}. Keep this window open
            while you use the app.
          </p>
        </>
      )}

      {phase === 'revoked' && (
        <>
          <h1>Access revoked</h1>
          <p className="muted">{request.name} no longer has a grant. Its requests are refused.</p>
        </>
      )}

      {share && phase === 'ready' && (
        <div className="share">
          <h2>{request.name} asks for memories</h2>
          <p className="muted">
            For: “{share.query.slice(0, 140)}”. Recalled with Lighthouse Memory ({share.how === 'semantic' ? 'meaning + keywords' : 'keywords'}).
            Only what you tick is sent{grant?.reveal ? `, and ${request.name} will be able to read it` : ''}.
          </p>
          {share.hits.length === 0 && <p className="muted">No memories in the granted scopes match.</p>}
          <ul className="picks">
            {share.hits.map((h, i) => (
              <li key={i}>
                <label>
                  <input
                    type="checkbox"
                    checked={h.picked}
                    onChange={(e) => setShare({ ...share, hits: share.hits.map((x, j) => (j === i ? { ...x, picked: e.target.checked } : x)) })}
                  />
                  <span>
                    {h.text}
                    <small className="muted">
                      {h.scope} · {h.score.toFixed(2)}
                    </small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="actions-row">
            <button disabled={!share.hits.some((h) => h.picked)} onClick={() => answerShare(true)}>
              Share {share.hits.filter((h) => h.picked).length} with {request.name}
            </button>
            <button className="ghost" onClick={() => answerShare(false)}>
              Decline
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {log.length > 0 && (
        <ul className="log">
          {log.map((l) => (
            <li key={l.at + l.text} className={l.ok ? '' : 'bad'}>
              <time>{new Date(l.at).toLocaleTimeString()}</time> {l.text}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
