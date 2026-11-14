import { fromUtf8, toBase64, utf8 } from '../bytes.ts'
import { SCOPE_PATTERN, type ScopeRoot } from '../vault.ts'

/** Mirrors the registry contract in contract/src/lib.rs. */
export interface Grant {
  app: string
  scopes: string[]
  write: boolean
  /** The app may receive the text of memories in these scopes (otherwise: TEE answers only). */
  reveal?: boolean
  created_at_ms: number
  expires_at_ms: number
}

export interface VaultRecord {
  owner: string
  check: string | null
  roots: Required<ScopeRoot>[]
  grants: Grant[]
}

export type RegistryCall =
  | { method: 'set_check'; args: { check: string } }
  | { method: 'set_root'; args: { scope: string; cid: string; count: number } }
  | { method: 'grant'; args: { app: string; scopes: string[]; write: boolean; ttl_minutes: number; reveal?: boolean } }
  | { method: 'revoke'; args: { app: string } }
  | { method: 'reset_vault'; args: Record<string, never> }

export interface Registry {
  readonly kind: 'near' | 'local'
  /** Contract id, or a note that this is the dev registry. */
  readonly label: string
  getVault(owner: string): Promise<VaultRecord | null>
  getGrant(owner: string, app: string): Promise<Grant | null>
  /** Sends the calls as one transaction signed by `owner`. */
  submit(owner: string, calls: RegistryCall[]): Promise<{ txHash?: string }>
}

export const RPC_URLS = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
} as const

export interface FunctionCallAction {
  type: 'FunctionCall'
  params: { methodName: string; args: object; gas: string; deposit: string }
}

/** Signs and sends one transaction to `receiverId` with the owner's wallet. */
export type SendTransaction = (receiverId: string, actions: FunctionCallAction[]) => Promise<{ txHash?: string }>

export class NearRegistry implements Registry {
  readonly kind = 'near' as const

  constructor(
    readonly contractId: string,
    private readonly rpcUrl: string,
    private readonly send: SendTransaction,
  ) {}

  get label(): string {
    return this.contractId
  }

  async view<T>(method: string, args: object): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'memory-wallet',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'optimistic',
          account_id: this.contractId,
          method_name: method,
          args_base64: toBase64(utf8(JSON.stringify(args))),
        },
      }),
    })
    const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } }
    if (body.error) throw new Error(`NEAR RPC: ${body.error.message ?? JSON.stringify(body.error.data)}`)
    if (body.result?.error) throw new Error(`NEAR RPC: ${body.result.error}`)
    return JSON.parse(fromUtf8(new Uint8Array(body.result?.result ?? []))) as T
  }

  getVault(owner: string): Promise<VaultRecord | null> {
    return this.view('get_vault', { owner })
  }

  getGrant(owner: string, app: string): Promise<Grant | null> {
    return this.view('get_grant', { owner, app })
  }

  submit(_owner: string, calls: RegistryCall[]): Promise<{ txHash?: string }> {
    if (calls.length > 10) throw new Error('at most 10 registry calls per transaction')
    return this.send(
      this.contractId,
      calls.map((c) => ({ type: 'FunctionCall', params: { methodName: c.method, args: c.args, gas: '25000000000000', deposit: '0' } })),
    )
  }
}

/**
 * Same rules as the contract, kept in this browser's localStorage. For local development and
 * the test suite only — nothing here is on-chain.
 */
export class LocalRegistry implements Registry {
  readonly kind = 'local' as const
  readonly label = 'dev registry (this browser only — not on NEAR)'

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly now: () => number = Date.now,
  ) {}

  private key(owner: string) {
    return `memory-wallet:dev-registry:${owner}`
  }

  private read(owner: string): VaultRecord | null {
    const raw = this.storage.getItem(this.key(owner))
    return raw ? (JSON.parse(raw) as VaultRecord) : null
  }

  async getVault(owner: string): Promise<VaultRecord | null> {
    const v = this.read(owner)
    return v && { ...v, grants: v.grants.filter((g) => g.expires_at_ms > this.now()) }
  }

  async getGrant(owner: string, app: string): Promise<Grant | null> {
    return (await this.getVault(owner))?.grants.find((g) => g.app === app) ?? null
  }

  async submit(owner: string, calls: RegistryCall[]): Promise<{ txHash?: string }> {
    const v: VaultRecord = this.read(owner) ?? { owner, check: null, roots: [], grants: [] }
    const now = this.now()
    for (const call of calls) {
      switch (call.method) {
        case 'set_check':
          if (v.check && v.check !== call.args.check) throw new Error('this vault already has a different key check; call reset_vault first')
          v.check = call.args.check
          break
        case 'set_root': {
          if (!SCOPE_PATTERN.test(call.args.scope)) throw new Error('scope must be 1-32 characters of a-z, 0-9, - or _')
          const root = { ...call.args, updated_at_ms: now }
          const i = v.roots.findIndex((r) => r.scope === call.args.scope)
          if (i >= 0) v.roots[i] = root
          else v.roots.push(root)
          break
        }
        case 'grant': {
          const { app, scopes, write, ttl_minutes } = call.args
          const reveal = call.args.reveal ?? false
          if (!/^https?:\/\/[a-z0-9.:-]+$/.test(app)) throw new Error('app must be a lowercase origin like https://app.example')
          v.grants = v.grants.filter((g) => g.app !== app && g.expires_at_ms > now)
          v.grants.push({ app, scopes: [...new Set(scopes)].sort(), write, reveal, created_at_ms: now, expires_at_ms: now + ttl_minutes * 60_000 })
          break
        }
        case 'revoke': {
          const before = v.grants.length
          v.grants = v.grants.filter((g) => g.app !== call.args.app)
          if (v.grants.length === before) throw new Error('no grant for this app')
          break
        }
        case 'reset_vault':
          this.storage.removeItem(this.key(owner))
          return {}
      }
    }
    this.storage.setItem(this.key(owner), JSON.stringify(v))
    return {}
  }
}
