import type { ReactNode } from 'react'

const DOCS = 'https://docs.lighthouse.storage/'

/** The floating glass bar from lighthouse.storage, with the Lighthouse wordmark. */
export function TopBar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href="https://lighthouse.storage/" target="_blank" rel="noreferrer" aria-label="Lighthouse">
        <img className="brand-logo" src="/lighthouse-logo.svg" alt="Lighthouse" width={218} height={66} />
      </a>
      <span className="product">Memory Wallet</span>
      {children}
      <div className="topbar-right">
        {right ?? (
          <>
            <a className="nav-link" href="/memory-wallet-extension.zip" download>
              Extension <span aria-hidden="true">↓</span>
            </a>
            <a className="nav-link" href={DOCS} target="_blank" rel="noreferrer">
              Docs <span aria-hidden="true">↗</span>
            </a>
          </>
        )}
      </div>
    </header>
  )
}

/** The site's hero film, as a still: the memory network fading into the page, plus its violet glow. */
export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop-film" />
      <div className="backdrop-glow" />
    </div>
  )
}

export const EXTENSION_ZIP = '/memory-wallet-extension.zip'

/** Chrome only installs extensions from outside the Web Store via "Load unpacked". */
export function ExtensionCard() {
  return (
    <section className="ext">
      <div>
        <h2>
          Use your memory in <span className="gradient">ChatGPT, NEAR AI and Venice.</span>
        </h2>
        <p className="muted">
          The Memory Wallet extension adds a Memory button to those chats. Each site gets a grant on NEAR, and you tick exactly which
          memories it sees. On Venice it can also bring Venice's local memory into your wallet.
        </p>
        <ol className="ext-steps">
          <li>Download the extension and unzip it.</li>
          <li>
            Open <code>chrome://extensions</code> and turn on <b>Developer mode</b>.
          </li>
          <li>
            Click <b>Load unpacked</b> and pick the <code>memory-wallet-extension</code> folder.
          </li>
        </ol>
      </div>
      <a className="cta" href={EXTENSION_ZIP} download>
        Download the extension <span aria-hidden="true">↓</span>
      </a>
    </section>
  )
}

export function Footer() {
  return (
    <footer className="foot">
      <span>
        Memory Wallet by <a href="https://lighthouse.storage/" target="_blank" rel="noreferrer">Lighthouse</a>
      </span>
      <nav>
        <a href={EXTENSION_ZIP} download>
          Extension ↓
        </a>
        <a href={DOCS} target="_blank" rel="noreferrer">
          Docs ↗
        </a>
        <a href="https://lighthouse.storage/storage" target="_blank" rel="noreferrer">
          Storage ↗
        </a>
        <a href="https://near.ai/" target="_blank" rel="noreferrer">
          NEAR AI ↗
        </a>
      </nav>
    </footer>
  )
}
