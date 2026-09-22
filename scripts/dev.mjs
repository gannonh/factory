import { spawn } from 'node:child_process'
import process from 'node:process'

const env = {
  ...process.env,
  FACTORY_PORT: process.env.FACTORY_PORT ?? '8787',
  FACTORY_ORIGIN: process.env.FACTORY_ORIGIN ?? 'http://localhost:5173',
  FACTORY_WORLD_PORT: process.env.FACTORY_WORLD_PORT ?? process.env.FACTORY_PORT ?? '8787',
}

const server = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], { stdio: 'inherit', env })
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env })

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  server.kill('SIGTERM')
  vite.kill('SIGTERM')
}

process.on('SIGINT', () => { stop(); process.exit(0) })
process.on('SIGTERM', () => { stop(); process.exit(0) })
server.on('exit', (code) => { if (!stopping) { vite.kill('SIGTERM'); process.exit(code ?? 1) } })
vite.on('exit', (code) => { if (!stopping) { server.kill('SIGTERM'); process.exit(code ?? 1) } })
