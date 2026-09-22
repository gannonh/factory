import { MockServer } from './simulation'
import { startFactoryServer } from './http'

const port = Number(process.env.FACTORY_PORT ?? 8787)
const origin = process.env.FACTORY_ORIGIN ?? 'http://localhost:5173'

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('FACTORY_PORT must be an integer from 0 to 65535')
  process.exit(1)
}

const running = await startFactoryServer(new MockServer(), { port, origin })
console.log(`factory server listening on 127.0.0.1:${running.port} for ${origin}`)
