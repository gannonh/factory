import { join } from 'node:path'
import { MockServer } from './simulation'
import { startFactoryServer } from './http'
import { fileStore, worldFilePath } from './worldFile'

const port = Number(process.env.FACTORY_PORT ?? 8787)
// the default page answers on both loopback spellings, and the browser sends whichever the operator typed
const origins = process.env.FACTORY_ORIGIN ? [process.env.FACTORY_ORIGIN] : ['http://localhost:5173', 'http://127.0.0.1:5173']

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('FACTORY_PORT must be an integer from 0 to 65535')
  process.exit(1)
}

const worldFile = worldFilePath(process.env, join(import.meta.dirname, '..'))
const simulation = new MockServer({ store: fileStore(worldFile) })
const running = await startFactoryServer(simulation, { port, origins })
console.log(`factory server listening on 127.0.0.1:${running.port} for ${origins.join(', ')}, world file ${worldFile}`)

let stopping = false
async function shutdown() {
  // Ctrl+C under scripts/dev.mjs delivers SIGINT to the process group and then SIGTERM from dev.mjs
  if (stopping) return
  stopping = true
  simulation.close()
  await running.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
