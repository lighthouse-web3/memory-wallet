import { useState } from 'react'
import { ExtensionCard, Footer, TopBar } from './Brand.tsx'
import { config } from './config.ts'
import { errorText } from './format.ts'
import { unlock, type Unlocked } from './session.ts'
import { connectNear, devSession, type WalletSession } from './wallet.ts'

export function UnlockScreen(props: {
  wallet: WalletSession | null
  onWallet: (w: WalletSession | null) => void
  onUnlocked: (u: Unlocked) => void
  forApp?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="unlock">
      <TopBar />
      <section className="hero">
      {props.forApp ? (
        <h1>
          {props.forApp} wants
          <br />
          <span className="gradient">to use your memory.</span>
        </h1>
      ) : (
        <h1>
          Your AI memory,
          <br />
          <span className="gradient">in your hands.</span>
        </h1>
      )}
      <p className="lede">
        Memories are encrypted in this browser with a key only your NEAR wallet can produce, stored on Lighthouse, recalled here with
        Lighthouse Memory, and shared with AI apps only through grants on NEAR that you can revoke. Private answers come from NEAR AI's
        attested TEEs.
      </p>

      {!props.wallet ? (
        <div className="actions">
          <button disabled={busy} onClick={() => run(async () => props.onWallet(await connectNear()))}>
            Connect NEAR wallet ({config.network})
          </button>
          <button className="ghost" disabled={busy} onClick={() => run(async () => props.onWallet(devSession()))}>
            Try with a dev key
          </button>
        </div>
      ) : (
        <div className="actions">
          <button disabled={busy} onClick={() => run(async () => props.onUnlocked(await unlock(props.wallet!)))}>
            {busy ? 'Waiting for the wallet…' : `Unlock as ${props.wallet.accountId}`}
          </button>
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await props.wallet!.disconnect()
                props.onWallet(null)
              })
            }
          >
            Use another account
          </button>
        </div>
      )}

      {props.wallet?.kind === 'dev' && (
        <p className="note">Dev key: a throwaway key in this browser. Grants and pointers go to a dev registry here, not to NEAR.</p>
      )}
      {error && <p className="error">{error}</p>}
      </section>

      <ol className="how">
        <li>
          <b>Unlock.</b> Your wallet signs one fixed message. That signature becomes your vault key, here, and is never sent anywhere.
        </li>
        <li>
          <b>Store.</b> Each scope (travel, health…) is sealed with its own AES-256-GCM key and uploaded to Lighthouse as ciphertext.
        </li>
        <li>
          <b>Share.</b> Apps get a scope for a while through a grant on NEAR that anyone can audit and you can revoke.
        </li>
        <li>
          <b>Compute.</b> Answers come from a model in an Intel TDX + NVIDIA TEE. This browser checks its attestation, then encrypts the
          prompt to that enclave's key.
        </li>
      </ol>
      {!props.forApp && <ExtensionCard />}
      <Footer />
    </main>
  )
}
