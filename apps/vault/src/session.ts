import {
  LocalRegistry,
  NearRegistry,
  RPC_URLS,
  RelayBlobStore,
  Vault,
  attestModel,
  buildSystemPrompt,
  deriveVaultKeys,
  privateChat,
  selectMemories,
  type ChatMessage,
  type ModelAttestation,
  type QuoteVerifier,
  type Registry,
  type RegistryCall,
  type ScopedMemory,
  type VaultKeys,
  type VaultRecord,
} from '@memory-wallet/core'
import { config } from './config.ts'
import { embedder, embedQuery } from './embedder.ts'
import type { WalletSession } from './wallet.ts'

export interface Unlocked {
  wallet: WalletSession
  keys: VaultKeys
  vault: Vault
  registry: Registry
  record: VaultRecord | null
  loadErrors: { scope: string; error: string }[]
}

function registryFor(wallet: WalletSession): Registry {
  if (wallet.kind === 'near' && config.contractId) {
    return new NearRegistry(config.contractId, RPC_URLS[config.network], (receiverId, actions) => wallet.send(receiverId, actions))
  }
  return new LocalRegistry(localStorage)
}

/** One wallet signature → vault keys → the encrypted snapshots the registry points at. */
export async function unlock(wallet: WalletSession): Promise<Unlocked> {
  const signed = await wallet.signUnlock()
  if (signed.accountId !== wallet.accountId) throw new Error(`The wallet signed as ${signed.accountId}, not ${wallet.accountId}.`)
  const keys = deriveVaultKeys(signed)
  const registry = registryFor(wallet)
  const record = await registry.getVault(wallet.accountId)
  if (record?.check && record.check !== keys.check) {
    keys.wipe()
    throw new Error(
      'This wallet produced a different vault key than the one that created this vault (a different access key, or a wallet that signs non-deterministically), so it cannot open it.',
    )
  }
  const vault = new Vault(keys, new RelayBlobStore(config.relayUrl))
  const loadErrors = record ? await vault.load(record.roots) : []
  void embedder.warm(0) // start loading the embedding model in the background
  return { wallet, keys, vault, registry, record, loadErrors }
}

/**
 * Embeds new memories with Lighthouse Memory's embedder (on-device), seals changed scopes, uploads
 * them, and points the registry at them in one transaction. If the embedding model can't load,
 * memories are saved without vectors and recall falls back to keywords.
 */
export async function save(u: Unlocked): Promise<{ txHash?: string; scopes: string[]; embedded: number }> {
  const embedded = (await embedder.warm(15_000))
    ? await u.vault.embedMissing(embedder).catch((err) => {
        console.warn('Lighthouse Memory embedder failed; saving without vectors:', err)
        return 0
      })
    : 0
  const roots = await u.vault.prepareSave()
  const calls: RegistryCall[] = []
  if (!u.record?.check) calls.push({ method: 'set_check', args: { check: u.keys.check } })
  for (const r of roots) calls.push({ method: 'set_root', args: { scope: r.scope, cid: r.cid, count: r.count } })
  if (!calls.length) return { scopes: [], embedded }
  const res = await u.registry.submit(u.wallet.accountId, calls)
  u.vault.commit(roots)
  u.record = await u.registry.getVault(u.wallet.accountId)
  return { ...res, scopes: roots.map((r) => r.scope), embedded }
}

export async function refreshRecord(u: Unlocked): Promise<void> {
  u.record = await u.registry.getVault(u.wallet.accountId)
}

// ── Private inference ──────────────────────────────────────────────────────────

let verifier: Promise<QuoteVerifier | undefined> | null = null

/** Intel DCAP verification runs in the browser; if the module can't load, that check shows as skipped. */
function quoteVerifier(): Promise<QuoteVerifier | undefined> {
  verifier ??= import('@memory-wallet/core/dcap')
    .then((m) => m.dcapQuoteVerifier())
    .catch((err) => {
      console.warn('Intel quote verification unavailable in this browser:', err)
      return undefined
    })
  return verifier
}

let cached: ModelAttestation | null = null
const ATTESTATION_TTL_MS = 5 * 60_000

export async function attestation(force = false): Promise<ModelAttestation> {
  if (!force && cached && Date.now() - cached.fetchedAt < ATTESTATION_TTL_MS) return cached
  cached = await attestModel(config.attestationUrl, config.model, { quoteVerifier: await quoteVerifier() })
  return cached
}

export function lastAttestation(): ModelAttestation | null {
  return cached
}

/** Up to this many granted memories all go in; past it, recall picks the top RECALL_LIMIT. */
export const RECALL_ALL_BELOW = 8
export const RECALL_LIMIT = 8

/** Answers `messages` with the chosen memories, readable only inside the attested model TEE. */
export async function askPrivately(opts: { appName: string; appSystem?: string; memories: ScopedMemory[]; messages: ChatMessage[] }) {
  const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  // Lighthouse Memory recall, in this browser: only the most relevant memories are sent.
  const queryVector = opts.memories.length > RECALL_ALL_BELOW ? await embedQuery(lastUser) : null
  const chosen = selectMemories(lastUser, opts.memories, { allBelow: RECALL_ALL_BELOW, limit: RECALL_LIMIT, queryVector: queryVector ?? undefined })
  const system = buildSystemPrompt({ appName: opts.appName, appSystem: opts.appSystem, memories: chosen })
  const result = await privateChat({
    relayUrl: config.relayUrl,
    attestationUrl: config.attestationUrl,
    model: config.model,
    messages: [{ role: 'system', content: system }, ...opts.messages],
    attestation: await attestation(),
    maxTokens: 1500,
    reasoningEffort: 'low',
  })
  return { ...result, memoriesUsed: chosen.length }
}
