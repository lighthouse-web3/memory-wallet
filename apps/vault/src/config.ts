const env = import.meta.env
const network = (env.VITE_NEAR_NETWORK || 'testnet') as 'testnet' | 'mainnet'

/** The registry deployed for the hackathon (contract/). Set VITE_CONTRACT_ID to use your own. */
const DEPLOYED_REGISTRY = { testnet: 'lighthouse-memory-wallet.testnet', mainnet: '' }

export const config = {
  network,
  /** NEAR wallets keep grants and roots here. The dev key can't send transactions, so it always uses a registry in this browser. */
  contractId: (env.VITE_CONTRACT_ID as string | undefined) || DEPLOYED_REGISTRY[network],
  relayUrl: (env.VITE_RELAY_URL as string | undefined) || 'http://localhost:8787',
  model: (env.VITE_NEARAI_MODEL as string | undefined) || 'z-ai/glm-5.3-flash',
  attestationUrl: (env.VITE_NEARAI_ATTESTATION_URL as string | undefined) || 'https://cloud-api.near.ai',
}

export const SUGGESTED_SCOPES = ['travel', 'food', 'health', 'work', 'preferences']
