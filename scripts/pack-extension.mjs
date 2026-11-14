// Zips apps/extension into the vault's public folder, so the vault can offer it as a download
// (apps/vault/public/memory-wallet-extension.zip, git-ignored). Outside the Chrome Web Store,
// Chrome only installs extensions via "Load unpacked", so users unzip it and load the folder.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const out = `${root}apps/vault/public/memory-wallet-extension.zip`
const stage = mkdtempSync(join(tmpdir(), 'mw-ext-'))
try {
  cpSync(`${root}apps/extension`, join(stage, 'memory-wallet-extension'), { recursive: true, filter: (src) => !/\/\.[^/]+$/.test(src) })
  rmSync(out, { force: true })
  execFileSync('zip', ['-r', '-X', '-q', out, 'memory-wallet-extension'], { cwd: stage })
  console.log(`extension → ${out}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
