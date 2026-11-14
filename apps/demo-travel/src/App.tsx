import { connectUrl, isBridgeMessage, type AppToVault, type ChatMessage, type ReplyProof, type VaultToApp } from '@memory-wallet/core'
import { useEffect, useRef, useState } from 'react'
import { Rich } from './Rich.tsx'

/**
 * Wanderly: an ordinary third-party AI app. It never holds a key, a memory or a model API key.
 * It opens the user's Memory Wallet, asks for the travel + food scopes, and sends questions
 * through it. What comes back is an answer and a proof of where it was computed.
 */
const VAULT_URL = (import.meta.env.VITE_VAULT_URL as string | undefined) || 'http://localhost:5173'
const VAULT_ORIGIN = new URL(VAULT_URL).origin
const SCOPES = ['travel', 'food']
const SYSTEM =
  "You are Wanderly, a friendly trip planner. Give short, concrete plans: a few bullets per day, real places, and a one-line reason when you use one of the user's preferences."

interface Connection {
  accountId: string
  scopes: string[]
  write: boolean
  expiresAt: number
  registry: string
}

type Line = ChatMessage & { proof?: ReplyProof }

const newId = () => Math.random().toString(36).slice(2, 10)

export function App() {
  const popup = useRef<Window | null>(null)
  const [conn, setConn] = useState<Connection | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== VAULT_ORIGIN || e.source !== popup.current || !isBridgeMessage(e.data)) return
      const msg = e.data as VaultToApp
      if (msg.type === 'mw:ready') {
        setConn({ accountId: msg.accountId, scopes: msg.scopes, write: msg.write, expiresAt: msg.expiresAt, registry: msg.registry })
        setStatus({ ok: true, text: `Connected to ${msg.accountId}'s Memory Wallet` })
      } else if (msg.type === 'mw:reply') {
        setLines((l) => [...l, { role: 'assistant', content: msg.content, proof: msg.proof }])
        setBusy(false)
      } else if (msg.type === 'mw:remembered') {
        setStatus({ ok: true, text: 'Saved to your Memory Wallet (encrypted there, not here).' })
      } else if (msg.type === 'mw:error') {
        setBusy(false)
        setStatus({ ok: false, text: msg.message })
        if (msg.code === 'not-granted') setConn(null)
      }
    }
    window.addEventListener('message', onMessage)
    const poll = setInterval(() => {
      if (popup.current?.closed) {
        popup.current = null
        setConn(null)
        setBusy(false)
      }
    }, 1000)
    return () => {
      window.removeEventListener('message', onMessage)
      clearInterval(poll)
    }
  }, [])

  const connect = () => {
    const url = connectUrl(VAULT_URL, { app: location.origin, name: 'Wanderly', scopes: SCOPES, write: true })
    popup.current = window.open(url, 'memory-wallet', 'popup,width=500,height=780')
    setStatus(popup.current ? { ok: true, text: 'Approve Wanderly in the Memory Wallet window.' } : { ok: false, text: 'Allow pop-ups for this site to connect.' })
  }

  const post = (msg: AppToVault) => popup.current?.postMessage(msg, VAULT_ORIGIN)

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    const q = input.trim()
    if (!q || !conn) return
    const next: Line[] = [...lines, { role: 'user', content: q }]
    setLines(next)
    setInput('')
    setBusy(true)
    setStatus(null)
    post({ type: 'mw:chat', id: newId(), system: SYSTEM, messages: next.map(({ role, content }) => ({ role, content })) })
  }

  const remember = (e: React.FormEvent) => {
    e.preventDefault()
    if (!note.trim() || !conn) return
    post({ type: 'mw:remember', id: newId(), scope: 'travel', text: note.trim() })
    setNote('')
  }

  const lastProof = [...lines].reverse().find((l) => l.proof)?.proof

  return (
    <div className="page">
      <header>
        <span className="logo">Wanderly</span>
        {conn ? (
          <span className="pill ok">Memory: {conn.scopes.join(' + ')} · {conn.accountId}</span>
        ) : (
          <button onClick={connect}>Connect your Memory Wallet</button>
        )}
      </header>

      <main>
        <section className="chat">
          <h1>Where to next?</h1>
          <p className="sub">Plans that already know you — without Wanderly ever seeing what it knows.</p>
          <div className="lines">
            {lines.length === 0 && (
              <div className="hint">
                {conn ? 'Try: "Plan me 3 days in Lisbon in March."' : 'Connect your Memory Wallet so Wanderly can use your travel and food preferences.'}
              </div>
            )}
            {lines.map((l, i) => (
              <div key={i} className={`line ${l.role}`}>
                <Rich text={l.content} />
                {l.proof && (
                  <span className={`proof ${l.proof.attestation.accepted ? 'ok' : 'bad'}`}>
                    {l.proof.attestation.accepted ? 'Answered inside a verified NEAR AI TEE' : 'TEE not verified'} · used {l.proof.memoriesUsed} of your memories ·
                    signature {l.proof.signature.status}
                  </span>
                )}
              </div>
            ))}
            {busy && <div className="line assistant thinking">Asking privately…</div>}
          </div>
          <form onSubmit={send}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Plan me 3 days in Lisbon in March" disabled={!conn} />
            <button disabled={!conn || busy || !input.trim()}>Plan</button>
          </form>
          {conn?.write && (
            <form onSubmit={remember} className="remember">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell Wanderly to remember something (saved to your wallet)" />
              <button className="ghost">Remember</button>
            </form>
          )}
          {status && <p className={status.ok ? 'status' : 'status bad'}>{status.text}</p>}
        </section>

        <aside>
          <h2>What Wanderly can see</h2>
          <ul>
            <li>Your questions and the answers.</li>
            <li>Which scopes you granted, and until when.</li>
            <li>
              <b>Not</b> your memories, your keys, or the prompt sent to the model — that's encrypted in your wallet window to the enclave's key.
            </li>
          </ul>
          {conn && (
            <dl>
              <dt>Grant</dt>
              <dd>
                {conn.scopes.join(', ')} · {conn.write ? 'read + write' : 'read'}
              </dd>
              <dt>Expires</dt>
              <dd>{new Date(conn.expiresAt).toLocaleString()}</dd>
              <dt>Registry</dt>
              <dd>{conn.registry}</dd>
            </dl>
          )}
          {lastProof && (
            <>
              <h2>Last answer was computed in</h2>
              <ul className="checks">
                {lastProof.attestation.checks.map((c) => (
                  <li key={c.id} className={c.status}>
                    {c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '–'} {c.label}
                  </li>
                ))}
              </ul>
              <p className="mono">{lastProof.model}</p>
            </>
          )}
        </aside>
      </main>
    </div>
  )
}
