import { LighthouseStorageAdapter } from '@lighthouse-ai/store-lighthouse'
import { SEALED_FORMAT, fromBase64, looksSealed, toBase64, type SealedDocument } from '@memory-wallet/core'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where sealed blobs go. Both backends only ever hold ciphertext. */
export interface SealedStore {
  readonly name: string
  put(sealed: Uint8Array): Promise<string>
  get(cid: string): Promise<Uint8Array>
  /** A public URL for the stored document, to show anyone it's ciphertext. */
  publicUrl(cid: string): string | null
}

const toDocument = (sealed: Uint8Array): SealedDocument => ({ format: SEALED_FORMAT, data: toBase64(sealed) })

function fromDocument(doc: unknown): Uint8Array {
  const d = doc as Partial<SealedDocument>
  if (d?.format !== SEALED_FORMAT || typeof d.data !== 'string') throw new Error('not a Memory Wallet document')
  const sealed = fromBase64(d.data)
  if (!looksSealed(sealed)) throw new Error('document does not hold a sealed blob')
  return sealed
}

/** Lighthouse IPFS + Filecoin (or Walrus), through the published @lighthouse-ai SDK. */
export class LighthouseSealedStore implements SealedStore {
  private readonly adapter: LighthouseStorageAdapter

  constructor(apiKey: string, network = 'ipfs-filecoin') {
    this.adapter = new LighthouseStorageAdapter(apiKey, network)
  }

  get name() {
    return this.adapter.name
  }

  async put(sealed: Uint8Array): Promise<string> {
    const up = await this.adapter.uploadJson(toDocument(sealed), `memory-wallet-${Date.now()}.json`)
    return up.cid
  }

  async get(cid: string): Promise<Uint8Array> {
    return fromDocument(await this.adapter.fetchJson(cid))
  }

  publicUrl(cid: string): string {
    return this.adapter.gatewayUrl(cid)
  }
}

/** Local folder, for development without a Lighthouse key. CIDs are CIDv1 raw sha2-256. */
export class LocalSealedStore implements SealedStore {
  readonly name = 'local-dev'

  constructor(private readonly dir: string) {}

  async put(sealed: Uint8Array): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(toDocument(sealed)))
    const cid = cidV1Raw(bytes)
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, `${cid}.json`), bytes)
    return cid
  }

  async get(cid: string): Promise<Uint8Array> {
    return fromDocument(JSON.parse(await readFile(join(this.dir, `${cid}.json`), 'utf8')))
  }

  publicUrl(): null {
    return null
  }

  async readDocument(cid: string): Promise<string> {
    return readFile(join(this.dir, `${cid}.json`), 'utf8')
  }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function cidV1Raw(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest()
  return `b${base32(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]))}`
}
