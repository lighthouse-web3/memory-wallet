import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'
import { buf, concat, decodeNearBytes, toBase64, toHex, utf8 } from './bytes.ts'

/**
 * The vault key comes from one NEP-413 signature by the user's NEAR wallet.
 *
 * Ed25519 signatures are deterministic, so signing the same message with the same key always
 * yields the same 64 bytes — those bytes are the root of the vault key and never leave the
 * browser. The flip side: anyone who gets that signature can open the vault, so the message
 * says so, and the vault stores a check on-chain to notice a wallet that signs differently.
 */
export const UNLOCK_RECIPIENT = 'memory-wallet.lighthouse'
export const UNLOCK_NONCE: Uint8Array = sha256(utf8('lighthouse-memory-wallet/v1/unlock'))

export function unlockMessage(accountId: string): string {
  return [
    `Unlock Lighthouse Memory Wallet for ${accountId}.`,
    '',
    'This signature is the key to your encrypted memories.',
    'Only sign it on the Memory Wallet site.',
  ].join('\n')
}

export interface SignedMessage {
  accountId: string
  /** `ed25519:<base58>` */
  publicKey: string
  /** base64 (NEP-413) or `ed25519:<base58>` */
  signature: string
}

export interface Nep413Params {
  message: string
  recipient: string
  nonce: Uint8Array
  callbackUrl?: string
}

const NEP413_TAG = 2 ** 31 + 413

function borshString(s: string): Uint8Array {
  const bytes = utf8(s)
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, bytes.length, true)
  return concat(len, bytes)
}

/** SHA-256 of the borsh-serialised NEP-413 payload, which is what the wallet signs. */
export function nep413Hash({ message, recipient, nonce, callbackUrl }: Nep413Params): Uint8Array {
  if (nonce.length !== 32) throw new Error('NEP-413 nonce must be 32 bytes')
  const tag = new Uint8Array(4)
  new DataView(tag.buffer).setUint32(0, NEP413_TAG, true)
  const cb = callbackUrl === undefined ? new Uint8Array([0]) : concat(new Uint8Array([1]), borshString(callbackUrl))
  return sha256(concat(tag, borshString(message), nonce, borshString(recipient), cb))
}

export function verifyNep413(signed: SignedMessage, params: Nep413Params): boolean {
  if (!signed.publicKey.startsWith('ed25519:')) return false
  const publicKey = decodeNearBytes(signed.publicKey)
  const signature = decodeNearBytes(signed.signature)
  if (publicKey.length !== 32 || signature.length !== 64) return false
  return ed25519.verify(signature, nep413Hash(params), publicKey)
}

export function unlockParams(accountId: string): Nep413Params {
  return { message: unlockMessage(accountId), recipient: UNLOCK_RECIPIENT, nonce: UNLOCK_NONCE }
}

export class VaultKeys {
  private readonly scopeKeys = new Map<string, Promise<CryptoKey>>()

  constructor(
    readonly accountId: string,
    private readonly master: Uint8Array,
    /** 32 hex chars, stored on-chain; a different value at unlock means a different key. */
    readonly check: string,
  ) {}

  /** One AES-256-GCM key per scope, so a scope can later be shared without the others. */
  scopeKey(scope: string): Promise<CryptoKey> {
    let key = this.scopeKeys.get(scope)
    if (!key) {
      const raw = hkdf(sha256, this.master, undefined, utf8(`memory-wallet/v1/scope|${scope}`), 32)
      key = crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
      raw.fill(0)
      this.scopeKeys.set(scope, key)
    }
    return key
  }

  wipe(): void {
    this.master.fill(0)
    this.scopeKeys.clear()
  }

  static fromMaster(accountId: string, master: Uint8Array): VaultKeys {
    const check = toHex(hmac(sha256, master, utf8('memory-wallet/v1/check'))).slice(0, 32)
    return new VaultKeys(accountId, master, check)
  }
}

/** Verifies the unlock signature, then derives the vault keys from it. */
export function deriveVaultKeys(signed: SignedMessage): VaultKeys {
  const accountId = signed.accountId
  if (!verifyNep413(signed, unlockParams(accountId))) {
    throw new Error('The wallet signature does not verify for this account and unlock message.')
  }
  const ikm = decodeNearBytes(signed.signature)
  const master = hkdf(sha256, ikm, utf8('lighthouse-memory-wallet/v1'), utf8(`master|${accountId}`), 32)
  ikm.fill(0)
  return VaultKeys.fromMaster(accountId, master)
}

/**
 * A throwaway signer for local development and tests: a random Ed25519 key kept by the caller,
 * signing exactly like a wallet would. Never use it for real memories.
 */
export class DevSigner {
  readonly publicKey: string

  constructor(
    readonly accountId: string,
    private readonly secretKey: Uint8Array,
  ) {
    this.publicKey = `ed25519:${base58.encode(ed25519.getPublicKey(secretKey))}`
  }

  static random(accountId: string): DevSigner {
    return new DevSigner(accountId, ed25519.utils.randomSecretKey())
  }

  get secretHex(): string {
    return toHex(this.secretKey)
  }

  signMessage(params: Nep413Params): SignedMessage {
    const signature = ed25519.sign(nep413Hash(params), this.secretKey)
    return { accountId: this.accountId, publicKey: this.publicKey, signature: toBase64(signature) }
  }
}
