import dcap from '@phala/dcap-qvl'
import { Buffer } from 'buffer'
import type { QuoteVerifier } from './attestation.ts'

/**
 * Intel DCAP verification of a TDX quote with @phala/dcap-qvl (pure JS, runs in the browser).
 * Collateral (Intel-signed TCB info, QE identity, CRLs) comes from Phala's PCCS, which allows
 * browser requests. The collateral is signed by Intel, so the PCCS can't forge a verdict; the
 * verifier checks the chain to Intel's root CA, which it ships.
 */
export const PHALA_PCCS_URL = 'https://pccs.phala.network'

export function dcapQuoteVerifier(opts: { pccsUrl?: string; now?: () => number } = {}): QuoteVerifier {
  return async (quote) => {
    const raw = Buffer.from(quote)
    const collateral = await dcap.getCollateral(opts.pccsUrl ?? PHALA_PCCS_URL, raw)
    const verified = dcap.QuoteVerifier.newWithRootCa(dcap.constants.TRUSTED_ROOT_CA_DER).verify(
      raw,
      collateral,
      Math.floor((opts.now ?? Date.now)() / 1000),
    )
    return { status: verified.status, advisoryIds: verified.advisory_ids }
  }
}
