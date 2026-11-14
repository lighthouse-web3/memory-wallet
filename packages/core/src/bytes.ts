import { base58, base64 } from '@scure/base'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export const utf8 = (s: string): Uint8Array => encoder.encode(s)
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b)

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('not a hex string')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const toBase64 = (bytes: Uint8Array): string => base64.encode(bytes)
export const fromBase64 = (s: string): Uint8Array => base64.decode(s)

/** NEAR keys and signatures come as `ed25519:<base58>`; NEP-413 signatures usually as base64. */
export function decodeNearBytes(value: string): Uint8Array {
  if (value.startsWith('ed25519:')) return base58.decode(value.slice('ed25519:'.length))
  return base64.decode(value)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** WebCrypto wants an ArrayBuffer-backed view; this copies when a view is over something else. */
export function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes)
}
