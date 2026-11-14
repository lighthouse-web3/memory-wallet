import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, fromHex, fromUtf8, randomBytes, toHex, utf8 } from '../bytes.ts'

/**
 * NEAR AI Cloud end-to-end encryption, v2 (Ed25519 keys), per
 * https://docs.near.ai/cloud/guides/e2ee-chat-completions:
 *   X25519 ECDH (Ed25519 keys converted to Montgomery form) → HKDF-SHA256, no salt,
 *   info "ed25519_encryption" → XChaCha20-Poly1305.
 *   Wire format, hex: ephemeral X25519 public key (32) | nonce (24) | ciphertext + tag.
 * Requests are encrypted to the model's attested key; the model encrypts its reply to ours.
 */
const INFO = utf8('ed25519_encryption')

function deriveKey(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, INFO, 32)
}

export function encryptToEd25519(plaintext: string, recipientEd25519PubHex: string): string {
  const recipient = fromHex(recipientEd25519PubHex)
  if (recipient.length !== 32) throw new Error('recipient key must be a 32-byte Ed25519 public key')
  const recipientX = ed25519.utils.toMontgomery(recipient)
  const ephSecret = x25519.utils.randomSecretKey()
  const ephPublic = x25519.getPublicKey(ephSecret)
  const key = deriveKey(x25519.getSharedSecret(ephSecret, recipientX))
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8(plaintext))
  return toHex(concat(ephPublic, nonce, ct))
}

export function decryptWithX25519(ciphertextHex: string, x25519Secret: Uint8Array): string {
  const data = fromHex(ciphertextHex)
  if (data.length < 32 + 24 + 16) throw new Error('E2EE ciphertext is too short')
  const ephPublic = data.subarray(0, 32)
  const nonce = data.subarray(32, 56)
  const ct = data.subarray(56)
  const key = deriveKey(x25519.getSharedSecret(x25519Secret, ephPublic))
  return fromUtf8(xchacha20poly1305(key, nonce).decrypt(ct))
}

/** A fresh client key pair per request: its public half goes in `X-Client-Pub-Key`. */
export class E2EEClientKey {
  readonly publicKeyHex: string
  private readonly x25519Secret: Uint8Array

  private constructor(secret: Uint8Array) {
    this.publicKeyHex = toHex(ed25519.getPublicKey(secret))
    this.x25519Secret = ed25519.utils.toMontgomerySecret(secret)
    secret.fill(0)
  }

  static generate(): E2EEClientKey {
    return new E2EEClientKey(ed25519.utils.randomSecretKey())
  }

  decrypt(ciphertextHex: string): string {
    return decryptWithX25519(ciphertextHex, this.x25519Secret)
  }
}

/** True when a string has the shape of a v2 ciphertext; the relay uses it to refuse plaintext. */
export function looksE2EE(value: unknown): boolean {
  return typeof value === 'string' && value.length >= (32 + 24 + 16) * 2 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)
}
