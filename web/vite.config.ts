import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: `pnpm dev` serves the dashboard on :5173 and proxies the API (incl. SSE) to the server on :3000.
// Build: output goes to web/dist, which the Node server serves in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } }
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 }
})
