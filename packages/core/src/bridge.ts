import type { Check } from './nearai/attestation.ts'
import type { ChatMessage, SignatureCheck } from './nearai/client.ts'

/**
 * postMessage protocol between an app and the vault window it opened.
 *
 * The vault only answers messages whose `event.origin` is the app origin the user granted
 * on-chain, and only posts back to that origin. By default memories never cross this channel:
 * the app sends a question, the vault adds the granted memories inside an encrypted request to
 * the attested model, and returns the model's answer plus the proof of where it was computed.
 *
 * A grant with `reveal` (shown to the user, and public on-chain) also lets the app recall the
 * text of memories in its scopes — for chat apps outside a TEE that the user chooses to trust,
 * like ChatGPT through the browser extension.
 */

export interface ConnectRequest {
  /** The app's origin, e.g. http://localhost:5174 — must equal the opener's real origin. */
  app: string
  name: string
  scopes: string[]
  write: boolean
  /** Ask to receive memory text, not just TEE answers. */
  reveal?: boolean
}

export interface RevealedMemory {
  scope: string
  text: string
  /** Lighthouse Memory recall score for the query. */
  score: number
}

export type AppToVault =
  | { type: 'mw:chat'; id: string; system?: string; messages: ChatMessage[] }
  | { type: 'mw:remember'; id: string; scope: string; text: string }
  /** Needs a reveal grant. Lighthouse Memory recall over the granted scopes, in the vault. */
  | { type: 'mw:recall'; id: string; query: string; limit?: number }
  /** Needs a write grant. Adds many memories to one scope and saves once (e.g. a Venice import). */
  | { type: 'mw:import'; id: string; scope: string; texts: string[]; label?: string }

export interface ReplyProof {
  model: string
  chatId: string
  memoriesUsed: number
  scopes: string[]
  attestation: {
    accepted: boolean
    signingAddress: string
    appName?: string
    composeHash?: string
    checks: Check[]
  }
  signature: SignatureCheck
}

export type BridgeErrorCode = 'not-granted' | 'scope-not-granted' | 'locked' | 'failed'

export type VaultToApp =
  | { type: 'mw:ready'; accountId: string; scopes: string[]; write: boolean; reveal: boolean; expiresAt: number; registry: string }
  | { type: 'mw:reply'; id: string; content: string; proof: ReplyProof }
  | { type: 'mw:remembered'; id: string }
  | { type: 'mw:memories'; id: string; memories: RevealedMemory[]; how: 'semantic' | 'keyword' }
  | { type: 'mw:imported'; id: string; added: number; skipped: number }
  | { type: 'mw:error'; id?: string; code: BridgeErrorCode; message: string }

export function isBridgeMessage(data: unknown): data is { type: `mw:${string}` } {
  return typeof data === 'object' && data !== null && typeof (data as { type?: unknown }).type === 'string' && (data as { type: string }).type.startsWith('mw:')
}

export function connectUrl(vaultUrl: string, req: ConnectRequest): string {
  const q = new URLSearchParams({ app: req.app, name: req.name, scopes: req.scopes.join(','), write: req.write ? '1' : '0' })
  if (req.reveal) q.set('reveal', '1')
  return `${vaultUrl}/#/connect?${q}`
}

export function parseConnectRequest(hash: string): ConnectRequest | null {
  const query = hash.split('?')[1]
  if (!query) return null
  const q = new URLSearchParams(query)
  const app = q.get('app') ?? ''
  const scopes = (q.get('scopes') ?? '').split(',').filter(Boolean)
  if (!/^https?:\/\/[a-z0-9.:-]+$/.test(app) || !scopes.length) return null
  return { app, name: (q.get('name') ?? app).slice(0, 60), scopes, write: q.get('write') === '1', reveal: q.get('reveal') === '1' }
}
