import { sha256, sha384 } from '@noble/hashes/sha2.js'
import { concat, equal, fromHex, randomBytes, toHex, utf8 } from '../bytes.ts'

/**
 * Checks a NEAR AI model-attestation report before any memory is encrypted to its key.
 * Follows https://docs.near.ai/cloud/verification/cloud-api/model-attestations:
 *   1. the report echoes our fresh nonce;
 *   2. the TDX quote's report_data = signing key (32) | our nonce (32);
 *   3. MRCONFIGID = 0x01 | SHA-256(app_compose) | 15 zero bytes;
 *   4. replaying the event log gives the quote's RTMR3;
 *   5. Intel's signature chain over the quote and the platform's TCB status (pluggable: the
 *      vault runs @phala/dcap-qvl in the browser, see dcap.ts);
 *   6. NVIDIA GPU evidence — present, but not verified here yet (TODO: NRAS).
 * A report is accepted when every check that ran passed and checks 1–5 all ran.
 */

export interface LogEvent {
  imr: number
  event_type: number
  digest?: string
  event?: string
  event_payload?: string
}

export interface NearModelReport {
  model_name?: string
  signing_address: string
  signing_algo: string
  signing_public_key?: string
  request_nonce: string
  intel_quote: string
  nvidia_payload?: string
  event_log: string | LogEvent[]
  info?: unknown
}

export interface AttestationResponse {
  gateway_attestation: Record<string, unknown>
  model_attestations?: NearModelReport[]
}

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface Check {
  id: 'nonce' | 'signer' | 'quote' | 'report-data' | 'config' | 'rtmr3' | 'intel' | 'gpu'
  label: string
  status: CheckStatus
  detail?: string
}

export interface QuoteVerdict {
  status: string
  advisoryIds?: string[]
}

/** Verifies Intel's signature chain over a quote and returns the platform's TCB status. */
export type QuoteVerifier = (quote: Uint8Array) => Promise<QuoteVerdict>

export interface ModelVerdict {
  model: string
  signingAddress: string
  signingPublicKey: string
  accepted: boolean
  checks: Check[]
  measurements: {
    mrtd?: string
    rtmr0?: string
    rtmr1?: string
    rtmr2?: string
    rtmr3?: string
    composeHash?: string
    appId?: string
    appName?: string
  }
}

export interface TdxQuote {
  version: number
  teeType: number
  mrTd: Uint8Array
  mrConfigId: Uint8Array
  rtMr0: Uint8Array
  rtMr1: Uint8Array
  rtMr2: Uint8Array
  rtMr3: Uint8Array
  reportData: Uint8Array
}

const TDX_TEE_TYPE = 0x81
const RUNTIME_EVENT = 0x08000001

/** Reads the fields we compare from a TDX v4 quote (48-byte header, then the TD10 report body). */
export function parseTdxQuote(quote: Uint8Array): TdxQuote {
  if (quote.length < 632) throw new Error('quote is too short for a TDX v4 quote')
  const view = new DataView(quote.buffer, quote.byteOffset, quote.byteLength)
  const at = (offset: number, len: number) => quote.slice(offset, offset + len)
  return {
    version: view.getUint16(0, true),
    teeType: view.getUint32(4, true),
    mrTd: at(184, 48),
    mrConfigId: at(232, 48),
    rtMr0: at(376, 48),
    rtMr1: at(424, 48),
    rtMr2: at(472, 48),
    rtMr3: at(520, 48),
    reportData: at(568, 64),
  }
}

function eventDigest(e: LogEvent): Uint8Array {
  if (e.digest) return fromHex(e.digest)
  if (e.event_type !== RUNTIME_EVENT) throw new Error(`event ${e.event ?? e.event_type} has no digest`)
  const type = new Uint8Array(4)
  new DataView(type.buffer).setUint32(0, e.event_type, true)
  return sha384(concat(type, utf8(':'), utf8(e.event ?? ''), utf8(':'), fromHex(e.event_payload ?? '')))
}

export function replayRtmr(events: LogEvent[], imr: number): Uint8Array {
  let mr: Uint8Array = new Uint8Array(48)
  for (const e of events.filter((x) => x.imr === imr)) {
    let d = eventDigest(e)
    if (d.length < 48) d = concat(d, new Uint8Array(48 - d.length))
    mr = sha384(concat(mr, d))
  }
  return mr
}

const parseMaybeJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v)

function tcbInfo(report: NearModelReport): { app_compose?: string; compose_hash?: string } & Record<string, unknown> {
  const info = (parseMaybeJson(report.info) ?? {}) as Record<string, unknown>
  return (parseMaybeJson(info.tcb_info) ?? {}) as Record<string, unknown>
}

export function newNonce(): string {
  return toHex(randomBytes(32))
}

export async function checkModelReport(
  report: NearModelReport,
  nonce: string,
  opts: { quoteVerifier?: QuoteVerifier; acceptedTcbStatuses?: string[] } = {},
): Promise<ModelVerdict> {
  const checks: Check[] = []
  const add = (id: Check['id'], label: string, status: CheckStatus, detail?: string) => checks.push({ id, label, status, detail })
  const info = (parseMaybeJson(report.info) ?? {}) as Record<string, unknown>
  const verdict: ModelVerdict = {
    model: report.model_name ?? '',
    signingAddress: report.signing_address,
    signingPublicKey: report.signing_public_key ?? '',
    accepted: false,
    checks,
    measurements: { appId: info.app_id as string | undefined, appName: info.app_name as string | undefined },
  }

  add('nonce', 'Fresh nonce echoed', report.request_nonce?.toLowerCase() === nonce.toLowerCase() ? 'pass' : 'fail')

  const signerOk =
    report.signing_algo === 'ed25519' &&
    /^[0-9a-f]{64}$/i.test(report.signing_address) &&
    report.signing_public_key?.toLowerCase() === report.signing_address.toLowerCase()
  add('signer', 'Ed25519 signing key is the E2EE key', signerOk ? 'pass' : 'fail')

  let quoteBytes: Uint8Array | undefined
  let quote: TdxQuote | undefined
  try {
    quoteBytes = fromHex(report.intel_quote)
    quote = parseTdxQuote(quoteBytes)
    const ok = quote.version === 4 && quote.teeType === TDX_TEE_TYPE
    add('quote', 'Intel TDX quote (v4)', ok ? 'pass' : 'fail', ok ? undefined : `version ${quote.version}, TEE type 0x${quote.teeType.toString(16)}`)
  } catch (err) {
    add('quote', 'Intel TDX quote (v4)', 'fail', err instanceof Error ? err.message : String(err))
  }

  if (quote) {
    verdict.measurements = {
      ...verdict.measurements,
      mrtd: toHex(quote.mrTd),
      rtmr0: toHex(quote.rtMr0),
      rtmr1: toHex(quote.rtMr1),
      rtmr2: toHex(quote.rtMr2),
      rtmr3: toHex(quote.rtMr3),
    }
    let expected: Uint8Array | undefined
    try {
      expected = concat(fromHex(report.signing_address), fromHex(nonce))
    } catch {
      /* reported as a failure below */
    }
    add('report-data', 'Quote binds the signing key and our nonce', expected && equal(quote.reportData, expected) ? 'pass' : 'fail')

    const tcb = tcbInfo(report)
    if (typeof tcb.app_compose === 'string') {
      const composeHash = sha256(utf8(tcb.app_compose))
      verdict.measurements.composeHash = toHex(composeHash)
      const expectedConfig = concat(new Uint8Array([1]), composeHash, new Uint8Array(15))
      add('config', 'App configuration is the measured one', equal(quote.mrConfigId, expectedConfig) ? 'pass' : 'fail')
    } else {
      add('config', 'App configuration is the measured one', 'fail', 'report has no app_compose')
    }

    try {
      const events = parseMaybeJson(report.event_log) as LogEvent[]
      if (!Array.isArray(events)) throw new Error('event log is not a list')
      add('rtmr3', 'Event log replays to RTMR3', equal(replayRtmr(events, 3), quote.rtMr3) ? 'pass' : 'fail')
    } catch (err) {
      add('rtmr3', 'Event log replays to RTMR3', 'fail', err instanceof Error ? err.message : String(err))
    }
  }

  if (!opts.quoteVerifier) {
    add('intel', "Intel's signature over the quote", 'skipped', 'no DCAP verifier configured')
  } else if (!quoteBytes || !quote) {
    add('intel', "Intel's signature over the quote", 'fail', 'no parsable quote')
  } else {
    try {
      const v = await opts.quoteVerifier(quoteBytes)
      const allowed = opts.acceptedTcbStatuses ?? ['UpToDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded']
      const ok = allowed.includes(v.status)
      const advisories = v.advisoryIds?.length ? ` (${v.advisoryIds.join(', ')})` : ''
      add('intel', "Intel's signature over the quote", ok ? 'pass' : 'fail', `TCB ${v.status}${advisories}`)
    } catch (err) {
      add('intel', "Intel's signature over the quote", 'fail', err instanceof Error ? err.message : String(err))
    }
  }

  add(
    'gpu',
    'NVIDIA GPU evidence',
    'skipped',
    report.nvidia_payload ? 'present; not verified in this build (TODO: NVIDIA NRAS)' : 'not included in this report',
  )

  const required: Check['id'][] = ['nonce', 'signer', 'quote', 'report-data', 'config', 'rtmr3']
  verdict.accepted =
    checks.every((c) => c.status !== 'fail') && required.every((id) => checks.find((c) => c.id === id)?.status === 'pass')
  return verdict
}

export async function fetchAttestation(baseUrl: string, model: string, nonce: string): Promise<AttestationResponse> {
  const params = new URLSearchParams({
    model,
    provider: 'near',
    signing_algo: 'ed25519',
    include_tls_fingerprint: 'false',
    nonce,
  })
  const res = await fetch(`${baseUrl}/v1/attestation/report?${params}`, {
    headers: { accept: 'application/json', 'x-no-aliasing': 'true' },
  })
  if (!res.ok) throw new Error(`attestation request failed (${res.status})`)
  return (await res.json()) as AttestationResponse
}

export interface ModelAttestation {
  model: string
  nonce: string
  fetchedAt: number
  verdicts: ModelVerdict[]
  /** The verified key every request is encrypted to. */
  chosen: ModelVerdict
}

/** Fetches fresh evidence for `model` and returns the verified key to encrypt to, or throws. */
export async function attestModel(
  baseUrl: string,
  model: string,
  opts: { quoteVerifier?: QuoteVerifier; acceptedTcbStatuses?: string[] } = {},
): Promise<ModelAttestation> {
  const nonce = newNonce()
  const response = await fetchAttestation(baseUrl, model, nonce)
  const reports = response.model_attestations ?? []
  if (!reports.length) throw new Error(`NEAR AI returned no model attestation for ${model}`)
  const verdicts = await Promise.all(reports.map((r) => checkModelReport(r, nonce, opts)))
  const accepted = verdicts.filter((v) => v.accepted && v.model === model)
  const keys = new Set(accepted.map((v) => v.signingPublicKey.toLowerCase()))
  if (!accepted.length) {
    const failed = verdicts.flatMap((v) => v.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}${c.detail ? `: ${c.detail}` : ''}`))
    throw Object.assign(new Error(`No attestation for ${model} passed: ${[...new Set(failed)].join('; ')}`), { verdicts })
  }
  if (keys.size > 1) throw Object.assign(new Error(`Verified reports for ${model} name different keys`), { verdicts })
  return { model, nonce, fetchedAt: Date.now(), verdicts, chosen: accepted[0]! }
}
