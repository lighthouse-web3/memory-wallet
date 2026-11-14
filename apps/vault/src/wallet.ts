import { NearConnector, type NearWalletBase } from '@hot-labs/near-connect'
import { DevSigner, fromHex, randomBytes, toHex, unlockParams, type FunctionCallAction, type SignedMessage } from '@memory-wallet/core'
import { config } from './config.ts'

/** What the vault needs from a wallet: who you are, one unlock signature, and transactions. */
export interface WalletSession {
  kind: 'near' | 'dev'
  accountId: string
  signUnlock(): Promise<SignedMessage>
  send(receiverId: string, actions: FunctionCallAction[]): Promise<{ txHash?: string }>
  disconnect(): Promise<void>
}

let connector: NearConnector | null = null
const getConnector = () => (connector ??= new NearConnector({ network: config.network }))

function nearSession(wallet: NearWalletBase, accountId: string): WalletSession {
  return {
    kind: 'near',
    accountId,
    async signUnlock() {
      const p = unlockParams(accountId)
      const signed = await wallet.signMessage({ message: p.message, recipient: p.recipient, nonce: p.nonce, signerId: accountId, network: config.network })
      return { accountId: signed.accountId || accountId, publicKey: signed.publicKey, signature: signed.signature }
    },
    async send(receiverId, actions) {
      const outcome = await wallet.signAndSendTransaction({ receiverId, actions, signerId: accountId, network: config.network })
      return { txHash: outcome?.transaction?.hash }
    },
    async disconnect() {
      await getConnector().disconnect(wallet)
    },
  }
}

export async function connectNear(): Promise<WalletSession> {
  const wallet = await getConnector().connect()
  const accountId = (await wallet.getAccounts({ network: config.network }))[0]?.accountId
  if (!accountId) throw new Error('The wallet did not return an account.')
  localStorage.setItem(KIND_KEY, 'near')
  return nearSession(wallet, accountId)
}

const KIND_KEY = 'memory-wallet:session-kind'
const DEV_KEY = 'memory-wallet:dev-signer'

/**
 * A throwaway key in this browser, for trying the vault without a NEAR account. It signs the
 * unlock message exactly like a wallet, but can't send transactions, so the dev registry is used.
 */
export function devSession(): WalletSession {
  let saved = JSON.parse(localStorage.getItem(DEV_KEY) ?? 'null') as { accountId: string; secret: string } | null
  if (!saved) {
    const signer = DevSigner.random(`dev-${toHex(randomBytes(3))}.testnet`)
    saved = { accountId: signer.accountId, secret: signer.secretHex }
    localStorage.setItem(DEV_KEY, JSON.stringify(saved))
  }
  const signer = new DevSigner(saved.accountId, fromHex(saved.secret))
  localStorage.setItem(KIND_KEY, 'dev')
  return {
    kind: 'dev',
    accountId: signer.accountId,
    signUnlock: async () => signer.signMessage(unlockParams(signer.accountId)),
    send: async () => {
      throw new Error('The dev key cannot send NEAR transactions.')
    },
    disconnect: async () => localStorage.removeItem(KIND_KEY),
  }
}

/** Reconnects whichever wallet this browser used last, without prompting. */
export async function restoreWallet(): Promise<WalletSession | null> {
  const kind = localStorage.getItem(KIND_KEY)
  if (kind === 'dev') return devSession()
  if (kind !== 'near') return null
  try {
    const wallet = await getConnector().wallet()
    const accountId = (await wallet.getAccounts({ network: config.network }))[0]?.accountId
    return accountId ? nearSession(wallet, accountId) : null
  } catch {
    return null
  }
}
