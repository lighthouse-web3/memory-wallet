import { rankMemories, RelayBlobStore, type ChatMessage, type RecallHit, type ReplyProof, type ScopedMemory } from '@memory-wallet/core'
import { useMemo, useReducer, useState } from 'react'
import { Footer, TopBar } from './Brand.tsx'
import { config, SUGGESTED_SCOPES } from './config.ts'
import { embedder, embedQuery } from './embedder.ts'
import { errorText, relative, short } from './format.ts'
import { ProofPanel, toProof } from './Proof.tsx'
import { Rich } from './Rich.tsx'
import { askPrivately, attestation, refreshRecord, save, type Unlocked } from './session.ts'

type Tab = 'memories' | 'apps' | 'chat'

export function Home({ u, onLock }: { u: Unlocked; onLock: () => void }) {
  const [tab, setTab] = useState<Tab>('memories')
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  return (
    <div className="shell">
      <TopBar
        right={
          <div className="who">
            <span className="mono">{u.wallet.accountId}</span>
            <button className="ghost small" onClick={onLock}>
              Lock
            </button>
          </div>
        }
      >
        <nav>
          {(['memories', 'apps', 'chat'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t === 'memories' ? 'Memories' : t === 'apps' ? 'Apps' : 'Private chat'}
            </button>
          ))}
        </nav>
      </TopBar>
      <div className="page-head">
        <h1>
          {HEADINGS[tab].title} <span className="gradient">{HEADINGS[tab].accent}</span>
        </h1>
      <p className="registry-line">
        Registry: {u.registry.kind === 'near' ? <a href={`https://${config.network === 'testnet' ? 'testnet.' : ''}nearblocks.io/address/${u.registry.label}`} target="_blank" rel="noreferrer">{u.registry.label}</a> : u.registry.label}
        {' · '}Storage: relay at {config.relayUrl}
      </p>
      </div>
      {u.loadErrors.length > 0 && (
        <p className="error">Could not open: {u.loadErrors.map((e) => `${e.scope} (${e.error})`).join('; ')}</p>
      )}
      {tab === 'memories' && <Memories u={u} onChange={rerender} />}
      {tab === 'apps' && <Apps u={u} onChange={rerender} />}
      {tab === 'chat' && <PrivateChat u={u} />}
      <Footer />
    </div>
  )
}

const HEADINGS: Record<Tab, { title: string; accent: string }> = {
  memories: { title: 'Your memories,', accent: 'encrypted before they leave.' },
  apps: { title: 'Apps you let in,', accent: 'revocable any time.' },
  chat: { title: 'Ask privately,', accent: 'verified in your browser.' },
}

function Memories({ u, onChange }: { u: Unlocked; onChange: () => void }) {
  const [scope, setScope] = useState('travel')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const store = useMemo(() => new RelayBlobStore(config.relayUrl), [])
  const scopes = [...new Set([...u.vault.scopeNames(), ...SUGGESTED_SCOPES])]
  const dirty = u.vault.dirtyScopes()
  const unembedded = u.vault.unembedded(embedder.id)
  const all = u.vault.memories()

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    try {
      u.vault.remember(scope.trim().toLowerCase(), text)
      setText('')
      setStatus(null)
      onChange()
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) })
    }
  }

  const doSave = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const res = await save(u)
      const embedded = res.embedded ? ` · ${res.embedded} embedded with Lighthouse Memory on this device` : ''
      setStatus({ ok: true, text: `Saved ${res.scopes.join(', ') || 'key check'}${embedded}${res.txHash ? ` · tx ${short(res.txHash)}` : ''}` })
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) })
    } finally {
      setBusy(false)
      onChange()
    }
  }

  return (
    <section className="panel">
      <form className="add" onSubmit={add}>
        <input list="scopes" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope" className="scope-input" />
        <datalist id="scopes">
          {scopes.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Something worth remembering — e.g. I'm vegetarian and avoid red-eye flights" aria-label="Memory" />
        <button type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>

      <div className="savebar">
        <span>
          {dirty.length
            ? `${dirty.length} scope${dirty.length > 1 ? 's' : ''} not saved yet: ${dirty.join(', ')}`
            : unembedded
              ? `${unembedded} ${unembedded === 1 ? 'memory has' : 'memories have'} no Lighthouse Memory embedding yet.`
              : 'Everything is saved and embedded.'}
        </span>
        <button disabled={busy || (!dirty.length && !unembedded)} onClick={doSave}>
          {busy ? (embedder.status === 'loading' ? 'Loading the embedding model…' : 'Embedding, encrypting, saving…') : u.registry.kind === 'near' ? 'Encrypt, upload and save on NEAR' : 'Encrypt, upload and save'}
        </button>
      </div>
      {status && <p className={status.ok ? 'ok-text' : 'error'}>{status.text}</p>}

      {all.length > 0 && <Recall u={u} />}

      {u.vault.scopeNames().length === 0 && <p className="empty">No memories yet. Add a few, then save — each scope becomes one encrypted blob.</p>}
      {u.vault.scopeNames().map((s) => {
        const cid = u.vault.cid(s)
        const items = all.filter((m) => m.scope === s)
        return (
          <div className="scope" key={s}>
            <div className="scope-head">
              <h3>{s}</h3>
              <span className="muted">
                {items.length} {items.length === 1 ? 'memory' : 'memories'}
              </span>
              {cid ? (
                <a className="mono" href={store.publicUrl(cid)} target="_blank" rel="noreferrer" title="Open the stored blob — it's ciphertext">
                  {short(cid, 10, 6)} ↗
                </a>
              ) : (
                <span className="muted">not uploaded yet</span>
              )}
            </div>
            <ul className="memories">
              {items.map((m) => (
                <li key={m.id}>
                  <span>{m.text}</span>
                  <small className="muted">{m.source === 'vault' ? relative(m.createdAt) : `from ${m.source}`}</small>
                  <button
                    className="ghost small"
                    aria-label="Forget"
                    onClick={() => {
                      u.vault.forget(s, m.id)
                      onChange()
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

/** Lighthouse Memory recall over the decrypted memories, entirely in this browser. */
function Recall({ u }: { u: Unlocked }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<RecallHit<ScopedMemory>[] | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    const vector = await embedQuery(query)
    setHits(rankMemories(query, u.vault.memories(), vector ?? undefined).slice(0, 5))
    setBusy(false)
  }

  return (
    <div className="recall">
      <div className="recall-head">
        <b>Recall</b>
        <span className="muted">Lighthouse Memory SDK · MiniLM embeddings and ranking, run on this device</span>
      </div>
      <form className="add" onSubmit={run}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Plan my flight to Europe" aria-label="Recall query" />
        <button className="ghost" type="submit" disabled={busy || !query.trim()}>
          {busy ? (embedder.status === 'loading' ? 'Loading model…' : 'Recalling…') : 'Recall'}
        </button>
      </form>
      {hits && (
        <ol className="hits">
          {hits.map((h) => (
            <li key={h.memory.id}>
              <span>{h.memory.text}</span>
              <small className="muted">
                {h.memory.scope} · {h.how === 'semantic' ? 'meaning + keywords' : 'keywords only (not embedded yet)'} · {h.score.toFixed(2)}
              </small>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Apps({ u, onChange }: { u: Unlocked; onChange: () => void }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const grants = u.record?.grants ?? []

  const revoke = async (app: string) => {
    setBusy(app)
    setError('')
    try {
      await u.registry.submit(u.wallet.accountId, [{ method: 'revoke', args: { app } }])
      await refreshRecord(u)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
      onChange()
    }
  }

  return (
    <section className="panel">
      <div className="savebar">
        <span>Apps you've let in. Each grant is public on the registry, and a revoke takes effect on the app's next request.</span>
        <button className="ghost" onClick={async () => (await refreshRecord(u), onChange())}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {grants.length === 0 && <p className="empty">No apps yet. Open the demo app and connect it to see a grant here.</p>}
      <ul className="grants">
        {grants.map((g) => (
          <li key={g.app}>
            <div>
              <b>{g.app}</b>
              <span className="muted">
                {g.scopes.join(', ')} · {g.write ? 'read + write' : 'read only'} · {g.reveal ? 'sees memory text' : 'TEE answers only'} · expires{' '}
                {relative(g.expires_at_ms)}
              </span>
            </div>
            <button className="danger" disabled={busy === g.app} onClick={() => revoke(g.app)}>
              {busy === g.app ? 'Revoking…' : 'Revoke'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function PrivateChat({ u }: { u: Unlocked }) {
  const scopes = u.vault.scopeNames()
  const [selected, setSelected] = useState<string[]>(scopes)
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<(ChatMessage & { proof?: ReplyProof })[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [check, setCheck] = useState<ReplyProof | null>(null)

  const verify = async () => {
    setBusy('verify')
    setError('')
    try {
      setCheck(toProof(await attestation(true)))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const question = input.trim()
    if (!question) return
    const messages: ChatMessage[] = [...history.map(({ role, content }) => ({ role, content })), { role: 'user', content: question }]
    setHistory(messages)
    setInput('')
    setBusy('chat')
    setError('')
    try {
      const res = await askPrivately({ appName: 'Memory Wallet', memories: u.vault.memories(selected), messages })
      const proof = toProof(res.attestation, { chatId: res.chatId, memoriesUsed: res.memoriesUsed, scopes: selected, signature: res.signature })
      setHistory([...messages, { role: 'assistant', content: res.content, proof }])
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="panel">
      <div className="savebar">
        <span>
          Ask {config.model} about your memories. The prompt is encrypted here to the model's attested key; the relay and NEAR AI's gateway only
          see ciphertext.
        </span>
        <button className="ghost" disabled={busy === 'verify'} onClick={verify}>
          {busy === 'verify' ? 'Checking…' : 'Check the TEE now'}
        </button>
      </div>
      {check && <ProofPanel proof={check} title="Fresh attestation, checked in this browser" />}
      <div className="scope-picks">
        {scopes.map((s) => (
          <label key={s}>
            <input type="checkbox" checked={selected.includes(s)} onChange={(e) => setSelected(e.target.checked ? [...selected, s] : selected.filter((x) => x !== s))} />
            {s}
          </label>
        ))}
      </div>
      <div className="chat">
        {history.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            <Rich text={m.content} />
            {m.proof && <ProofPanel proof={m.proof} />}
          </div>
        ))}
        {busy === 'chat' && <div className="bubble assistant muted">Verifying the enclave and asking privately…</div>}
      </div>
      {error && <p className="error">{error}</p>}
      <form className="add" onSubmit={send}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="What do you know about my travel preferences?" />
        <button type="submit" disabled={busy === 'chat' || !input.trim()}>
          Ask privately
        </button>
      </form>
    </section>
  )
}
