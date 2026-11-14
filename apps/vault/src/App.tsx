import { parseConnectRequest } from '@memory-wallet/core'
import { useEffect, useState } from 'react'
import { Backdrop } from './Brand.tsx'
import { ConnectScreen } from './Connect.tsx'
import { Home } from './Home.tsx'
import type { Unlocked } from './session.ts'
import { UnlockScreen } from './Unlock.tsx'
import { restoreWallet, type WalletSession } from './wallet.ts'

export function App() {
  const [hash, setHash] = useState(location.hash)
  const [wallet, setWallet] = useState<WalletSession | null>(null)
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null)

  useEffect(() => {
    const onHash = () => setHash(location.hash)
    window.addEventListener('hashchange', onHash)
    restoreWallet().then((w) => w && setWallet((current) => current ?? w))
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const request = hash.startsWith('#/connect') ? parseConnectRequest(hash) : null

  let screen
  if (!unlocked) {
    screen = <UnlockScreen wallet={wallet} onWallet={setWallet} onUnlocked={setUnlocked} forApp={request?.name} />
  } else if (hash.startsWith('#/connect')) {
    screen = <ConnectScreen u={unlocked} request={request} />
  } else {
    screen = (
      <Home
        u={unlocked}
        onLock={() => {
          unlocked.keys.wipe()
          setUnlocked(null)
        }}
      />
    )
  }
  return (
    <>
      <Backdrop />
      {screen}
    </>
  )
}
