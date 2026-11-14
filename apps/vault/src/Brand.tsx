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
          <a className="nav-link" href={DOCS} target="_blank" rel="noreferrer">
            Docs <span aria-hidden="true">↗</span>
          </a>
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

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="eyebrow">
      <span className="mini-mark" />
      {children}
    </div>
  )
}

export function Footer() {
  return (
    <footer className="foot">
      <span>
        Memory Wallet by <a href="https://lighthouse.storage/" target="_blank" rel="noreferrer">Lighthouse</a>
      </span>
      <nav>
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
