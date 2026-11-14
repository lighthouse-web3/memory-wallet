import type { ModelAttestation, ReplyProof, SignatureCheck } from '@memory-wallet/core'
import { config } from './config.ts'
import { short } from './format.ts'

export function toProof(a: ModelAttestation, extra: { chatId?: string; memoriesUsed?: number; scopes?: string[]; signature?: SignatureCheck } = {}): ReplyProof {
  return {
    model: a.model,
    chatId: extra.chatId ?? '',
    memoriesUsed: extra.memoriesUsed ?? 0,
    scopes: extra.scopes ?? [],
    attestation: {
      accepted: a.chosen.accepted,
      signingAddress: a.chosen.signingAddress,
      appName: a.chosen.measurements.appName,
      composeHash: a.chosen.measurements.composeHash,
      checks: a.chosen.checks,
    },
    signature: extra.signature ?? { status: 'unavailable', detail: 'no response yet' },
  }
}

const mark = { pass: '✓', fail: '✕', skipped: '–', unavailable: '–' } as const

/** Where an answer was computed, and what this browser checked about it. */
export function ProofPanel({ proof, title = 'Where this was computed' }: { proof: ReplyProof; title?: string }) {
  const a = proof.attestation
  return (
    <details className="proof" open>
      <summary>
        <span className={`badge ${a.accepted ? 'ok' : 'bad'}`}>{a.accepted ? 'TEE verified' : 'Not verified'}</span>
        <span>{title}</span>
      </summary>
      <dl>
        <dt>Model</dt>
        <dd>
          {proof.model} on NEAR AI Cloud ({config.attestationUrl.replace('https://', '')})
        </dd>
        <dt>Model key</dt>
        <dd className="mono">{short(a.signingAddress, 10, 8)}</dd>
        {a.composeHash && (
          <>
            <dt>Measured app</dt>
            <dd className="mono">
              {a.appName ?? 'app'} · compose {short(a.composeHash, 10, 6)}
            </dd>
          </>
        )}
        {proof.chatId && (
          <>
            <dt>Memories sent</dt>
            <dd>
              {proof.memoriesUsed} {proof.scopes.length ? `from ${proof.scopes.join(', ')}` : ''} — encrypted to the model key
            </dd>
          </>
        )}
      </dl>
      <ul className="checks">
        {a.checks.map((c) => (
          <li key={c.id} className={c.status}>
            <span className="mark">{mark[c.status]}</span>
            <span>{c.label}</span>
            {c.detail && <small>{c.detail}</small>}
          </li>
        ))}
        {proof.chatId && (
          <li className={proof.signature.status === 'pass' ? 'pass' : proof.signature.status === 'fail' ? 'fail' : 'skipped'}>
            <span className="mark">{mark[proof.signature.status]}</span>
            <span>Model TEE signed this request and response</span>
            {proof.signature.detail && <small>{proof.signature.detail}</small>}
          </li>
        )}
      </ul>
    </details>
  )
}
