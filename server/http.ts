import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { MockServer } from './simulation'
import { runCommand } from './commands'

const HOST = '127.0.0.1'

export type RunningServer = {
  port: number
  close: () => Promise<void>
}

function originOf(req: IncomingMessage): string | undefined {
  const value = req.headers.origin
  return typeof value === 'string' ? value : undefined
}

function allow(req: IncomingMessage, res: ServerResponse, origin: string): boolean {
  if (originOf(req) !== origin) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden origin')
    return false
  }
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'origin')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  return true
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buf.length
    if (size > 1_000_000) throw new Error('body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function startFactoryServer(
  simulation: MockServer,
  options: { port: number; origin: string },
): Promise<RunningServer> {
  const sockets = new Set<WebSocket>()
  const wss = new WebSocketServer({ noServer: true })
  const snapshot = () => JSON.stringify({ rev: simulation.revision(), world: simulation.snapshot() })

  simulation.subscribe(() => {
    const msg = snapshot()
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    }
  })

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'bad request'
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: message })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'OPTIONS' && url === '/command') {
      if (!allow(req, res, options.origin)) return
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method !== 'POST' || url !== '/command') {
      res.writeHead(404)
      res.end()
      return
    }
    if (!allow(req, res, options.origin)) return
    const parsed: unknown = JSON.parse(await readBody(req))
    if (typeof parsed !== 'object' || parsed === null || !('method' in parsed)) {
      sendJson(res, 400, { ok: false, error: 'expected a command' })
      return
    }
    const method = parsed.method
    const args = 'args' in parsed ? parsed.args : []
    if (typeof method !== 'string' || !Array.isArray(args)) {
      sendJson(res, 400, { ok: false, error: 'expected a command' })
      return
    }
    try {
      const result = runCommand(simulation, method, args)
      sendJson(res, 200, { ok: true, result, rev: simulation.revision(), world: simulation.snapshot() })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'bad request'
      sendJson(res, 400, { ok: false, error: message })
    }
  }

  httpServer.on('upgrade', (req, socket, head) => {
    if (originOf(req) !== options.origin || (req.url ?? '/') !== '/world') {
      socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.send(snapshot())
      ws.on('close', () => sockets.delete(ws))
    })
  })

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port, HOST, () => {
      const addr = httpServer.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('expected a tcp port'))
        return
      }
      resolve({
        port: addr.port,
        close: () => new Promise((done, fail) => {
          for (const ws of sockets) ws.close()
          wss.close()
          httpServer.close((err) => {
            httpServer.closeAllConnections()
            if (err) fail(err)
            else done()
          })
        }),
      })
    })
  })
}
