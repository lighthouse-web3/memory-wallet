import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, toHex, utf8 } from '../bytes.ts'
import { attestModel, type ModelAttestation, type QuoteVerifier } from './attestation.ts'
import { E2EEClientKey, encryptToEd25519 } from './e2ee.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface SignatureCheck {
  status: 'pass' | 'fail' | 'unavailable'
  kind?: string
  detail?: string
}

export interface PrivateChatResult {
  content: string
  reasoning?: string
  chatId: string
  model: string
  attestation: ModelAttestation
  signature: SignatureCheck
  /** Size of what left the browser — all of it ciphertext except the model id and roles. */
  requestBytes: number
}

export interface PrivateChatOptions {
  relayUrl: string
  /** Where attestation is fetched from, directly (no API key needed): https://cloud-api.near.ai */
  attestationUrl: string
  model: string
  messages: ChatMessage[]
  /** A recent attestation to reuse; a fresh one is fetched otherwise. */
  attestation?: ModelAttestation
  quoteVerifier?: QuoteVerifier
  maxTokens?: number
  /**
   * Sent as `reasoning_effort`. NEAR AI's reasoning models otherwise think for hundreds of tokens
   * before answering, which can use up `maxTokens` and leave no answer; 'low' answers in seconds.
   */
  reasoningEffort?: 'low' | 'medium' | 'high'
}

const hexSha256 = (s: string) => toHex(sha256(utf8(s)))

/**
 * One chat completion where the prompt (memories included) is readable only inside the attested
 * model TEE: every message is encrypted to the verified model key, the reply comes back encrypted
 * to a key made for this request, and the relay in between only adds the API key.
 */
export async function privateChat(opts: PrivateChatOptions): Promise<PrivateChatResult> {
  const attestation = opts.attestation ?? (await attestModel(opts.attestationUrl, opts.model, { quoteVerifier: opts.quoteVerifier }))
  const modelKey = attestation.chosen.signingPublicKey
  const client = E2EEClientKey.generate()

  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages.map((m) => ({ role: m.role, content: encryptToEd25519(m.content, modelKey) })),
    stream: false,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
  })

  const res = await fetch(`${opts.relayUrl}/nearai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signing-algo': 'ed25519',
      'x-client-pub-key': client.publicKeyHex,
      'x-model-pub-key': modelKey,
      'x-encryption-version': '2',
      'x-no-aliasing': 'true',
    },
    body,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(describeError(raw, res.status))

  const json = JSON.parse(raw) as {
    id: string
    choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string; reasoning?: string } }[]
  }
  const choice = json.choices?.[0]
  const msg = choice?.message ?? {}
  const content = msg.content ? client.decrypt(msg.content).trim() : ''
  const reasoningHex = msg.reasoning_content ?? msg.reasoning
  const reasoning = reasoningHex ? client.decrypt(reasoningHex) : undefined
  if (!content) {
    throw new Error(
      choice?.finish_reason === 'length'
        ? 'The model used its whole token budget before answering. Try again, or ask a shorter question.'
        : 'The model returned an empty answer. Try again.',
    )
  }

  const signature = await verifyResponseSignature({
    relayUrl: opts.relayUrl,
    chatId: json.id,
    model: opts.model,
    requestBody: body,
    responseBody: raw,
    attestation,
  })
  return { content, reasoning, chatId: json.id, model: opts.model, attestation, signature, requestBytes: utf8(body).length }
}

/**
 * Checks NEAR AI's signature over this exact request and response
 * (https://docs.near.ai/cloud/verification/cloud-api/response-signatures). A `provider_tee`
 * signature must come from the same key we verified and encrypted to.
 */
export async function verifyResponseSignature(args: {
  relayUrl: string
  chatId: string
  model: string
  requestBody: string
  responseBody: string
  attestation: ModelAttestation
  retries?: number
}): Promise<SignatureCheck> {
  const retries = args.retries ?? 4
  let sig: { text?: string; signature?: string; signing_address?: string; signing_algo?: string; signature_kind?: string; error_code?: string; message?: string } | undefined
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${args.relayUrl}/nearai/v1/signature/${encodeURIComponent(args.chatId)}?signing_algo=ed25519`)
    if (res.ok) {
      sig = await res.json()
      if (!sig?.error_code) break
    } else if (res.status !== 404) {
      return { status: 'unavailable', detail: `signature request failed (${res.status})` }
    }
    sig = undefined
    await new Promise((r) => setTimeout(r, 750))
  }
  if (!sig?.text || !sig.signature || !sig.signing_address) return { status: 'unavailable', detail: 'NEAR AI has no signature for this response yet' }

  const reqHash = hexSha256(args.requestBody)
  const resHash = hexSha256(args.responseBody)
  const kind = sig.signature_kind
  if (sig.signing_algo !== 'ed25519') return { status: 'fail', kind, detail: `unexpected algorithm ${sig.signing_algo}` }

  let expectedText: string
  if (kind === 'provider_tee') {
    expectedText = `${args.model}:${reqHash}:${resHash}`
    if (sig.signing_address.toLowerCase() !== args.attestation.chosen.signingAddress.toLowerCase()) {
      return { status: 'fail', kind, detail: 'signed by a key other than the attested model key' }
    }
  } else if (kind === 'gateway') {
    // We'd need the verified gateway report to accept this; the vault doesn't check it yet.
    return { status: 'unavailable', kind, detail: 'signed by the gateway, not the model TEE (gateway attestation not checked yet)' }
  } else {
    return { status: 'unavailable', kind, detail: 'unknown signature kind' }
  }

  if (sig.text !== expectedText) return { status: 'fail', kind, detail: 'signed text does not match this request and response' }
  try {
    const ok = ed25519.verify(fromHex(sig.signature), utf8(sig.text), fromHex(sig.signing_address))
    return ok ? { status: 'pass', kind, detail: 'model TEE signed this exact request and response' } : { status: 'fail', kind, detail: 'bad signature' }
  } catch (err) {
    return { status: 'fail', kind, detail: err instanceof Error ? err.message : String(err) }
  }
}

function describeError(raw: string, status: number): string {
  try {
    const body = JSON.parse(raw) as { error?: { message?: string } | string }
    const message = typeof body.error === 'string' ? body.error : body.error?.message
    if (message) return `${message} (${status})`
  } catch {
    /* fall through */
  }
  return `NEAR AI request failed (${status})`
}
