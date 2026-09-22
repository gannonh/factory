import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { startFactoryServer } from '../server/http'
import { MockServer } from '../server/simulation'

const execFileAsync = promisify(execFile)
const ORIGIN = 'http://localhost:5173'

async function boot() {
  const running = await startFactoryServer(new MockServer({ manual: true, rng: () => 0.5 }), { port: 0, origin: ORIGIN })
  return running
}

test('the server listens on 127.0.0.1 and rejects a foreign origin', async () => {
  const running = await boot()
  try {
    const ss = await execFileAsync('ss', ['-ltn', `sport = :${running.port}`])
    expect(ss.stdout).toContain('127.0.0.1:' + running.port)
    expect(ss.stdout).not.toContain('0.0.0.0:' + running.port)

    const foreign = await fetch(`http://127.0.0.1:${running.port}/command`, {
      method: 'POST',
      headers: { origin: 'http://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'sim.reset', args: [] }),
    })
    expect(foreign.status).toBe(403)

    const missing = await fetch(`http://127.0.0.1:${running.port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'sim.reset', args: [] }),
    })
    expect(missing.status).toBe(403)

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${running.port}/world`, { headers: { origin: 'http://evil.test' } })
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(403)
        resolve()
      })
      ws.on('open', () => reject(new Error('foreign origin websocket opened')))
      ws.on('error', () => {})
    })
  } finally {
    await running.close()
  }
})

test('a command updates every connected client and advance is not a command', async () => {
  const running = await boot()
  try {
    const open = (label: string) => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${running.port}/world`, { headers: { origin: ORIGIN } })
      ws.once('message', () => resolve(ws))
      ws.on('error', reject)
      ws.on('unexpected-response', () => reject(new Error(`${label} upgrade rejected`)))
    })
    const [a, b] = await Promise.all([open('a'), open('b')])
    const next = (ws: WebSocket) => new Promise<string>((resolve) => { ws.once('message', (data) => resolve(String(data))) })
    const pendingA = next(a)
    const pendingB = next(b)
    const response = await fetch(`http://127.0.0.1:${running.port}/command`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'graph.createNode', args: ['agent', { x: 10, y: 20 }] }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; result: string; world: { agents: Record<string, { position: { x: number } }> } }
    expect(body.ok).toBe(true)
    expect(body.world.agents[body.result].position).toEqual({ x: 10, y: 20 })
    const pushedA = JSON.parse(await pendingA) as { world: { agents: Record<string, unknown> } }
    const pushedB = JSON.parse(await pendingB) as { world: { agents: Record<string, unknown> } }
    expect(pushedA.world.agents).toHaveProperty(body.result)
    expect(pushedB.world.agents).toHaveProperty(body.result)

    const advance = await fetch(`http://127.0.0.1:${running.port}/command`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'sim.advance', args: [1] }),
    })
    expect(advance.status).toBe(400)
    a.close()
    b.close()
  } finally {
    await running.close()
  }
})

test('the world keeps running after every client disconnects', async () => {
  const running = await startFactoryServer(new MockServer({ rng: () => 0.5 }), { port: 0, origin: ORIGIN })
  try {
    const post = async (method: string, args: unknown[]) => {
      const response = await fetch(`http://127.0.0.1:${running.port}/command`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      })
      expect(response.status).toBe(200)
      return response.json() as Promise<{ world: { now: number; runs: Record<string, { status: string }> } }>
    }
    const before = await post('sim.set', [{ speed: 4 }])
    await post('triggers.fire', ['tr-cron'])
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const after = await post('sim.set', [{ speed: 4 }])
    expect(after.world.now).toBeGreaterThan(before.world.now)
    expect(Object.values(after.world.runs).some((run) => run.status === 'succeeded')).toBe(true)
  } finally {
    await running.close()
  }
}, 15_000)

test('the browser sources do not mention localStorage', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.ts') || name.endsWith('.tsx')) files.push(path)
    }
  }
  walk('src')
  const hits = files.filter((path) => readFileSync(path, 'utf8').includes('localStorage'))
  expect(hits).toEqual([])
})
