// Builds the two Vercel sites with the Build Output API (v3), then deploy with `vercel deploy --prebuilt`.
//
//   node scripts/vercel-build.mjs vault      → .vercel/output: the vault at /, the relay as one function at /api/*
//   node scripts/vercel-build.mjs wanderly   → apps/demo-travel/.vercel/output: the demo app (static)
//
// The vault and its relay share a domain (no CORS). Wanderly lives on another domain on purpose:
// it plays a third-party app, and the vault only answers the origin you granted.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname
const target = process.argv[2]
const VAULT_URL = process.env.MW_VAULT_URL || 'https://lighthouse-memory-wallet.vercel.app'

const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

function viteBuild(workspace, env) {
  execFileSync('npm', ['run', 'build', '-w', workspace], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
}

if (target === 'vault') {
  const out = `${root}.vercel/output`
  rmSync(out, { recursive: true, force: true })

  viteBuild('apps/vault', { VITE_RELAY_URL: '/api' })
  cpSync(`${root}apps/vault/dist`, `${out}/static`, { recursive: true })

  const fn = `${out}/functions/api.func`
  mkdirSync(fn, { recursive: true })
  await build({
    entryPoints: [`${root}relay/src/vercel.ts`],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: `${fn}/index.mjs`,
    // Some dependencies are CommonJS and call require().
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  })
  json(`${fn}/.vc-config.json`, { runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 })
  json(`${out}/config.json`, { version: 3, routes: [{ src: '^/api(?:/.*)?$', dest: '/api' }, { handle: 'filesystem' }] })
  console.log(`vault + relay → ${out}`)
} else if (target === 'wanderly') {
  const out = `${root}apps/demo-travel/.vercel/output`
  rmSync(out, { recursive: true, force: true })
  viteBuild('apps/demo-travel', { VITE_VAULT_URL: VAULT_URL })
  cpSync(`${root}apps/demo-travel/dist`, `${out}/static`, { recursive: true })
  json(`${out}/config.json`, { version: 3 })
  console.log(`wanderly (vault: ${VAULT_URL}) → ${out}`)
} else {
  console.error('usage: node scripts/vercel-build.mjs vault|wanderly')
  process.exit(1)
}
