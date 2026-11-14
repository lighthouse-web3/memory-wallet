// Starts the relay, the vault (5173) and the demo app (5174) together. Ctrl+C stops all three.
import { spawn } from 'node:child_process'

const procs = [
  ['relay', ['run', 'dev', '-w', 'relay']],
  ['vault', ['run', 'dev', '-w', 'apps/vault']],
  ['travel', ['run', 'dev', '-w', 'apps/demo-travel']],
]

const children = procs.map(([name, args]) => {
  const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const tag = `[${name}]`.padEnd(9)
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) console.log(tag, line)
    })
  }
  child.on('exit', (code) => {
    console.log(tag, `exited (${code})`)
    shutdown(code ?? 1)
  })
  return child
})

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) c.kill('SIGTERM')
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
