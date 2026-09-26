import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { startFactoryServer } from '../server/http'
import { MockServer } from '../server/simulation'

const ORIGIN = 'http://localhost:5173'

async function boot() {
  const simulation = new MockServer({ manual: true, rng: () => 0.5 })
  const running = await startFactoryServer(simulation, { port: 0, origins: [ORIGIN] })
  return Object.assign(running, { simulation })
}

async function post(port: number, method: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/command`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  return { status: response.status, body: await response.json() as { ok: boolean; error?: string } }
}

/** Revisions published after the call, skipping the snapshot `subscribe` delivers immediately. */
function published(simulation: MockServer): number[] {
  const revs: number[] = []
  let initial = true
  simulation.subscribe(() => {
    if (initial) initial = false
    else revs.push(simulation.revision())
  })
  return revs
}

test('the server listens on 127.0.0.1 and rejects a foreign origin', async () => {
  const running = await boot()
  try {
    expect(running.address).toBe('127.0.0.1')

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

test('sim.set rejects a speed outside 1, 2, 4 and publishes nothing', async () => {
  const running = await boot()
  try {
    const { simulation } = running
    const revs = published(simulation)

    const rejected = await post(running.port, 'sim.set', [{ speed: 3 }])
    expect(rejected).toEqual({ status: 400, body: { ok: false, error: 'sim.set: args[0].speed: expected one of 1, 2, 4' } })
    expect(simulation.revision()).toBe(1)
    expect(revs).toEqual([])
    expect(simulation.snapshot().sim.speed).toBe(1)

    const accepted = await post(running.port, 'sim.set', [{ speed: 4 }])
    expect(accepted.status).toBe(200)
    expect(simulation.revision()).toBe(2)
    expect(revs).toEqual([2])
    expect(simulation.snapshot().sim).toEqual({ paused: false, speed: 4 })
  } finally {
    await running.close()
  }
})

test('graph.restoreNodes rejects an incomplete agent and restores a full one', async () => {
  const running = await boot()
  try {
    const { simulation } = running
    const revs = published(simulation)

    const rejected = await post(running.port, 'graph.restoreNodes', [[{ kind: 'agent', node: { id: 'ag-x', name: 'x' } }]])
    expect(rejected).toEqual({ status: 400, body: { ok: false, error: 'graph.restoreNodes: args[0][0].node.role: expected a string' } })
    expect(Object.keys(simulation.snapshot().agents)).not.toContain('ag-x')
    expect(simulation.revision()).toBe(1)
    expect(revs).toEqual([])

    const agent = Object.values(simulation.snapshot().agents)[0]
    expect((await post(running.port, 'graph.deleteNodes', [[agent.id]])).status).toBe(200)
    expect(simulation.snapshot().agents[agent.id]).toBeUndefined()
    const restored = await post(running.port, 'graph.restoreNodes', [[{ kind: 'agent', node: agent }]])
    expect(restored.status).toBe(200)
    expect(simulation.snapshot().agents[agent.id]).toEqual({ ...agent, status: 'idle' })
    expect(revs).toEqual([2, 3])
  } finally {
    await running.close()
  }
})

test('a command with the wrong argument count is rejected before it runs', async () => {
  const running = await boot()
  try {
    const { simulation } = running
    const revs = published(simulation)
    const rejected = await post(running.port, 'graph.connect', ['ag-planner'])
    expect(rejected).toEqual({ status: 400, body: { ok: false, error: 'graph.connect: args: expected 3 arguments, got 1' } })
    expect(simulation.revision()).toBe(1)
    expect(revs).toEqual([])
  } finally {
    await running.close()
  }
})

test('the world keeps running after every client disconnects', async () => {
  const running = await startFactoryServer(new MockServer({ rng: () => 0.5 }), { port: 0, origins: [ORIGIN] })
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
