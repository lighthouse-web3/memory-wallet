import { buf, concat, equal, randomBytes, utf8 } from './bytes.ts'

/**
 * Sealed blob: "MW1" | version (1) | IV (12) | AES-256-GCM ciphertext + tag.
 * The additional data binds a blob to its owner and scope, so a snapshot can't be replayed
 * under another account or scope; tampering anywhere fails the GCM tag.
 */
const MAGIC = utf8('MW1')
const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
export const MIN_SEALED_BYTES = MAGIC.length + 1 + IV_BYTES + TAG_BYTES
export const MAX_SEALED_BYTES = 2 * 1024 * 1024

export const additionalData = (owner: string, scope: string) => utf8(`memory-wallet/v1|${owner}|${scope}`)

export async function seal(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(plaintext))
  return concat(MAGIC, new Uint8Array([VERSION]), iv, new Uint8Array(ct))
}

export async function open(key: CryptoKey, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (!looksSealed(sealed)) throw new Error('not a Memory Wallet sealed blob')
  const iv = sealed.slice(MAGIC.length + 1, MAGIC.length + 1 + IV_BYTES)
  const ct = sealed.slice(MAGIC.length + 1 + IV_BYTES)
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(ct))
    return new Uint8Array(pt)
  } catch {
    throw new Error('could not decrypt: wrong key, wrong owner/scope, or the blob was changed')
  }
}

/** Shape check only — it can't prove the bytes are ciphertext, just that they're framed as ours. */
export function looksSealed(bytes: Uint8Array): boolean {
  return (
    bytes.length >= MIN_SEALED_BYTES &&
    bytes.length <= MAX_SEALED_BYTES &&
    equal(bytes.subarray(0, MAGIC.length), MAGIC) &&
    bytes[MAGIC.length] === VERSION
  )
}

/** How a sealed blob is stored on Lighthouse (the SDK stores JSON documents). */
export const SEALED_FORMAT = 'memory-wallet/sealed-v1'
export interface SealedDocument {
  format: typeof SEALED_FORMAT
  data: string
}
