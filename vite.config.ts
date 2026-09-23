import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const worldPort = process.env.FACTORY_WORLD_PORT ?? process.env.FACTORY_PORT ?? '8787'
const worldTarget = `http://127.0.0.1:${worldPort}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/command': { target: worldTarget },
      '/health': { target: worldTarget },
      '/world': { target: worldTarget, ws: true },
    },
  },
})
