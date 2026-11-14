import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // VITE_* settings live in the repo root .env, next to the relay's.
  envDir: '../..',
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  // @phala/dcap-qvl (Intel quote verification in the browser) is CommonJS and expects `global`.
  define: { global: 'globalThis' },
})
