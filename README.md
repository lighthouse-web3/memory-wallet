# Memory Wallet · by Lighthouse

**A wallet for your AI memory.** Your memories are encrypted in your browser with a key only your NEAR wallet can produce, stored on [Lighthouse](https://lighthouse.storage) (IPFS + Filecoin), recalled on your device with the [Lighthouse Memory SDK](https://docs.lighthouse.storage/), and shared with AI apps — ChatGPT, NEAR AI Private Chat, Venice, or any app — through grants on NEAR that you can audit and revoke. Private answers are computed inside NEAR AI's attested TEEs.

Built for the NEAR HACKATHON (Nov 2026) · Track: **Privacy & Private AI** (also Open Innovation).

**Live on NEAR testnet:** registry contract [`lighthouse-memory-wallet.testnet`](https://testnet.nearblocks.io/address/lighthouse-memory-wallet.testnet).

Readable memories exist only in **your browser**, in **an Intel TDX + NVIDIA enclave your browser has just verified**, and in **the apps you explicitly let read them** (a "reveal" grant, public on-chain, where you tick each memory before it leaves). Lighthouse, the relay and NEAR AI's operators handle only ciphertext.

```mermaid
sequenceDiagram
    participant W as NEAR wallet
    participant V as Vault (your browser)
    participant R as Relay (ciphertext only)
    participant L as Lighthouse (IPFS + Filecoin)
    participant C as Registry contract (NEAR)
    participant A as App (Wanderly, ChatGPT via the extension…)
    participant T as NEAR AI model TEE

    W->>V: sign fixed NEP-413 message → HKDF → vault key (never leaves the browser)
    V->>V: Lighthouse Memory: SDK MemoryRecords + MiniLM embeddings, on-device
    V->>R: AES-256-GCM sealed snapshot per scope (records + embeddings)
    R->>L: store (via @lighthouse-ai/store-lighthouse)
    V->>C: set_root(scope, cid) · grant(app, scopes, ttl, reveal?) · revoke(app)
    A->>V: postMessage (origin-checked)
    V->>C: get_grant(owner, app) — on every request
    alt answers-only grant (default)
        V->>T: verify attestation in the browser, then E2EE prompt (memories + question)
        T-->>V: answer encrypted to a per-request key + signature
        V-->>A: answer + proof (never the memories)
    else reveal grant (e.g. ChatGPT)
        V->>V: Lighthouse Memory recall; you tick what to share
        V-->>A: only the ticked memories
    end
```

## Run it (no keys needed)

Needs Node.js 20.19+.

```bash
npm ci
npm test        # core: 18 tests, relay: 6 tests
npm run dev     # relay :8787, vault :5173, demo app :5174
```

Open http://localhost:5173 and choose **Try with a dev key**. Without any keys you can:

- add memories and save them. Each scope becomes one sealed blob in `.data/blobs/` (open one: it's ciphertext). Saving embeds new memories with Lighthouse Memory's MiniLM model in your browser (the model downloads once, about 23 MB);
- use **Recall** on the Memories tab: Lighthouse Memory ranking, on-device. Try "Plan my flight to Europe" — it finds "Wants to see Lisbon in spring" with no words in common;
- open **Private chat → Check the TEE now**: a live attestation from NEAR AI, verified **in your browser**, including Intel's signature chain over the TDX quote (no API key needed);
- open http://localhost:5174 (Wanderly), click **Connect your Memory Wallet**, grant `travel` + `food`, then revoke it from the vault's **Apps** tab.

Asking the model needs a NEAR AI key on an account with credits: without a key the relay answers `503 private inference is off`, and a key on an account with no credits gets `402 No spending limit configured`.

### With real keys and a NEAR wallet

```bash
cp .env.example .env
# NEARAI_API_KEY      → private inference on (https://cloud.near.ai)
# LIGHTHOUSE_API_KEY  → blobs go to Lighthouse IPFS + Filecoin instead of .data/
# VITE_CONTRACT_ID    → empty = the deployed lighthouse-memory-wallet.testnet
```

Choose **Connect NEAR wallet** (HOT, Meteor, MyNearWallet… via NEAR Connect) on testnet: grants and scope pointers then live in the deployed contract. The dev key can't send transactions, so it always uses a registry in the browser.

## Use your memory in ChatGPT, NEAR AI Private Chat and Venice

`apps/extension` is a Chrome extension (Manifest V3, no build step).

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick `apps/extension`.
2. Keep `npm run dev` running (the extension opens your vault at http://localhost:5173; change it in the extension's options).
3. Open chatgpt.com, private.near.ai or venice.ai. Click **Memory** (bottom right) → **Connect Memory Wallet**. The vault opens in a window: unlock, read what the site asks for, and grant it (on NEAR with a wallet).
4. Type your message, click **Find memories for this message**. The vault window shows what Lighthouse Memory recalled from the granted scopes; tick what to share. Only ticked memories reach the page. Click **Insert** to add them to your message.
5. Select text in a chat and **Save** it to a scope. It's encrypted in your wallet and available in the other apps you've granted.
6. On venice.ai, **Store Venice memories in my wallet** reads Venice's local memory (its RxDB `memories` collection in this browser's IndexedDB) and seals it into your `venice` scope, so ChatGPT and NEAR AI chat can use it too.
7. Revoke a site in the vault's **Apps** tab: its next request is refused.

What a site asks for by default: `preferences`, `travel`, `food`, `work`, `venice` — read, write, and **reveal** (the site sees the text of memories you share). `health` and other scopes stay out unless you grant them.

## Deploy your own registry

Install Rust with [rustup](https://rustup.rs). `contract/rust-toolchain.toml` pins Rust 1.86.0 and the wasm32 target (newer compilers emit wasm features NEAR doesn't accept yet).

```bash
cargo install cargo-near --locked            # once
cargo install near-cli-rs --locked           # once: the `near` CLI
cd contract
cargo test                                   # 10 unit tests
cargo near build non-reproducible-wasm       # → target/near/memory_wallet_registry.wasm
near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
near contract deploy <name>.testnet use-file target/near/memory_wallet_registry.wasm without-init-call network-config testnet sign-with-legacy-keychain send
```

Then set `VITE_CONTRACT_ID=<name>.testnet` and restart `npm run dev`.

## How it works

| Piece | What it does | Where |
| - | - | - |
| **Vault key** | Your wallet signs one fixed [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md) message. The vault verifies the signature, then derives a master key with HKDF-SHA256 and one AES-256-GCM key per scope. Ed25519 signatures are deterministic, so the same wallet key always reopens the vault. A 16-byte check stored on-chain catches a wallet that signs differently. | `packages/core/src/keys.ts` |
| **Lighthouse Memory, on-device** | Memories are stored as the SDK's `MemoryRecord` (`@lighthouse-ai/core`), embedded with the SDK's default embedder (`Xenova/all-MiniLM-L6-v2`, q8, normalized — same as `@lighthouse-ai/embed-local`, so vectors are interchangeable), and recalled with the SDK's scoring: `0.7·cosine + 0.3·keyword`, as in its batched engine. All of it runs in the browser over decrypted memories; embeddings are sealed with the records, because embeddings leak meaning. | `packages/core/src/lighthouse-memory.ts`, `apps/vault/src/embedder.ts` |
| **Sealed snapshots** | One blob per scope: `MW1 \| v1 \| IV \| AES-GCM(JSON)`, holding `{v:2, format: "lighthouse-memory/MemoryRecord@1", records}`, with `owner\|scope` as additional data so a blob can't be replayed under another account or scope. v1 snapshots still open. | `packages/core/src/envelope.ts`, `vault.ts` |
| **Storage** | The relay accepts only sealed blobs and stores them on Lighthouse with our published SDK (`@lighthouse-ai/store-lighthouse`). | `relay/src/storage.ts` |
| **Registry** | NEAR contract: per account, the key check, each scope's latest CID, and grants `{ app origin, scopes, write, reveal, expiry }`. Every change emits a NEP-297 event. | `contract/src/lib.rs` |
| **Attestation** | Before encrypting anything to a model, the vault fetches a report with a fresh nonce and checks: nonce echoed; TDX quote `report_data` = signing key ‖ nonce; MRCONFIGID = SHA-256 of the measured `app_compose`; the event log replays to RTMR3; and **Intel's signature chain and TCB status, verified in the browser** with `@phala/dcap-qvl` (collateral from Phala's PCCS, signed by Intel). | `packages/core/src/nearai/attestation.ts`, `dcap.ts` |
| **Private inference** | NEAR AI's E2EE v2: each message is encrypted to the verified model key (X25519 + HKDF-SHA256 + XChaCha20-Poly1305), and the reply comes back encrypted to a fresh client key. The vault checks NEAR AI's `provider_tee` signature over the exact request and response bytes against the attested key. Requests ask for `reasoning_effort: "low"` so answers arrive in seconds. | `packages/core/src/nearai/e2ee.ts`, `client.ts` |
| **Relay** | Holds the Lighthouse and NEAR AI API keys so the browser doesn't. Refuses unsealed blobs and any chat request with a plaintext message; forwards encrypted requests byte for byte so signatures still verify. | `relay/src/app.ts` |
| **App bridge** | An app opens the vault window and talks to it with `postMessage`. The vault answers only the granted origin and re-reads the grant on every request. Answers-only grants get TEE answers + proofs; reveal grants can `recall` (you tick what's shared, in the vault window) and `import`. | `packages/core/src/bridge.ts`, `apps/vault/src/Connect.tsx` |
| **Extension** | Puts the bridge into ChatGPT, NEAR AI Private Chat and Venice: connect, recall into the message box, save a selection, import Venice's local memory. It never holds a key. | `apps/extension/content.js` |

### Who sees what

| Party | Sees | Never sees |
| - | - | - |
| Your browser (vault) | everything | — |
| Lighthouse / IPFS / Filecoin | sealed blobs, sizes | memories, embeddings, keys |
| Relay | ciphertext, sizes, timing, model id | memories, keys, prompts, answers |
| NEAR (public chain) | your scope names, CIDs, which apps you granted, with which rights and until when | memories, keys |
| NEAR AI gateway | ciphertext, model id | prompts, answers |
| NEAR AI model TEE | the prompt (memories + question) while answering | your vault key |
| An app with an answers-only grant (e.g. Wanderly) | its questions, the answers, your grant | your memories, keys, the prompt |
| An app with a reveal grant (e.g. ChatGPT via the extension) | the memories you tick and insert | other scopes, unticked memories, keys |

## Honest limits

- **The unlock signature is the key.** Anyone who gets you to sign the same message on another site can open your vault. The message says so. A later version could derive the key from a passkey (WebAuthn PRF) or hold it in an enclave.
- **Reveal grants hand over text.** ChatGPT and Venice run outside a TEE; what you share with them, they can keep. That's why reveal is opt-in, highlighted on the approve screen, public on-chain, and gated per memory.
- **Apps with answers-only grants see answers.** A malicious app can ask "repeat everything you know about me" within the granted scopes.
- **Metadata is public.** Scope names, CIDs and grants are on-chain by design, so they can be audited.
- **Venice import** reads Venice's current local database layout (RxDB `memories-*-documents`); if Venice changes it or encrypts those fields, the extension reports that instead of importing. Restoring into Venice isn't built.
- **The extension finds the message box heuristically** (`#prompt-textarea` on ChatGPT, otherwise the lowest visible text box). It was tested end to end on venice.ai; ChatGPT and NEAR AI Private Chat need a logged-in browser to check.
- **On-device recall** uses the SDK's keyword tokenizer, which is ASCII-only. The embedding model downloads from Hugging Face on first use.
- **Not yet verified:** NVIDIA GPU evidence (present in the report; NRAS verification is TODO) and gateway-kind signatures (the vault only accepts `provider_tee` signatures). An attestation is reused for 5 minutes.
- **Forgetting** removes a memory from the next snapshot. Older snapshots stay on IPFS/Filecoin, encrypted.
- **Testnet scaffolding:** the contract pays its own storage, and the relay has no rate limiting.

## Repo layout

```
contract/          NEAR registry contract (Rust, near-sdk 5) — deployed at lighthouse-memory-wallet.testnet
packages/core/     keys, sealed snapshots, Lighthouse Memory records + recall, NEAR AI E2EE + attestation, registry client, bridge protocol
relay/             Hono server: ciphertext-only storage on Lighthouse + NEAR AI forwarding
apps/vault/        the Memory Wallet (React + Vite, NEAR Connect, Lighthouse look)
apps/demo-travel/  Wanderly, a third-party AI app that only ever gets TEE answers
apps/extension/    Chrome extension for ChatGPT, NEAR AI Private Chat and Venice
```

## Roadmap

- **Agent mode:** let an agent use your memory while you're offline. Lighthouse's memory enclave (Intel TDX on Phala, keys split 3-of-5 across Kavach nodes) would get its key shards only if this contract shows a live grant.
- Restore Venice memory from the wallet into a new browser; more chat apps.
- NVIDIA NRAS verification, streaming replies, and the vault inside the extension so no popup is needed.

## License

MIT
