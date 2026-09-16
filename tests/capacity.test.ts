/**
 * Sandbox capacity behavior, exercised through the public API surface in
 * `src/api/client.ts`. Time advances in controlled steps and an injected RNG
 * (0.5) makes every run last 12.5s of simulated time and succeed, so lease
 * lifetimes and waits are deterministic.
 */
import { expect, test, vi } from 'vitest'
import { createApi } from '../src/api/client'
import { MockServer } from '../src/api/mockServer'
import type { AgentId, SandboxId, Task, TaskId, World } from '../src/domain/types'

const RNG = () => 0.5
const sb = (id: string) => id as SandboxId

type Fixture = {
  api: ReturnType<typeof createApi>
  agent: (name: string) => AgentId
  world: () => World
  task: (id: TaskId) => Task
}

/** Fixture with the seeded triggers off and the seeded handoff edges removed. */
function makeFixture(): Fixture {
  const server = new MockServer({ manual: true, rng: RNG })
  const api = createApi(server)
  let latest: World | undefined
  api.subscribe((w) => { latest = w })
  const world = (): World => {
    if (!latest) throw new Error('no world snapshot')
    return latest
  }
  const agent = (name: string): AgentId => {
    const found = Object.values(world().agents).find((a) => a.name === name)
    if (!found) throw new Error(`no agent named ${name}`)
    return found.id
  }
  const task = (id: TaskId): Task => {
    const t = world().tasks[id]
    if (!t) throw new Error(`no task ${id}`)
    return t
  }
  for (const tr of Object.values(world().triggers)) api.triggers.update(tr.id, { enabled: false })
  api.graph.removeEdges(Object.values(world().edges).filter((e) => e.kind === 'handoff').map((e) => e.id))
  return { api, agent, world, task }
}

function isolateSandboxes(fixture: Fixture) {
  fixture.api.graph.removeEdges(Object.values(fixture.world().edges).filter((e) => e.kind === 'runs-in').map((e) => e.id))
}

function tasksForAgent(fixture: Fixture, agentId: AgentId): Task[] {
  return Object.values(fixture.world().tasks).filter((t) => t.agentId === agentId)
}

/** Coder concurrency 2 attached only to `sandboxId`, with two runs already leased. */
function twoCoderLeases(fixture: Fixture, sandboxId: SandboxId): AgentId {
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.agents.update(coder, { concurrency: 2 })
  fixture.api.graph.connect(coder, sandboxId, 'runs-in')
  fixture.api.agents.enqueue(coder, { title: 'one', prompt: 'p', priority: 'normal' })
  fixture.api.agents.enqueue(coder, { title: 'two', prompt: 'p', priority: 'normal' })
  fixture.api.sim.advance(1)
  return coder
}

test('a sandbox stores capacity from create and update, rejecting invalid values', () => {
  const fixture = makeFixture()
  const id = fixture.api.sandboxes.create({ name: 'big-box', kind: 'docker', host: 'docker.internal', image: 'img', capacity: 2 })
  expect(fixture.world().sandboxes[id].capacity).toBe(2)
  expect(fixture.world().sandboxes[id].leases).toEqual([])

  const plain = fixture.api.sandboxes.create({ name: 'plain-box', kind: 'docker', host: 'docker.internal', image: 'img' })
  expect(fixture.world().sandboxes[plain].capacity).toBe(1)

  fixture.api.sandboxes.update(id, { capacity: 3 })
  expect(fixture.world().sandboxes[id].capacity).toBe(3)
  fixture.api.sandboxes.update(id, { capacity: 0 })
  expect(fixture.world().sandboxes[id].capacity).toBe(3)
  fixture.api.sandboxes.update(id, { capacity: 1.5 })
  expect(fixture.world().sandboxes[id].capacity).toBe(3)
  fixture.api.sandboxes.update(sb('sb-missing'), { capacity: 2 })
  expect(fixture.world().sandboxes[sb('sb-missing')]).toBeUndefined()
})

test('a create capacity below 1 or fractional falls back to 1', () => {
  const fixture = makeFixture()
  const zero = fixture.api.sandboxes.create({ name: 'zero-box', kind: 'docker', host: 'docker.internal', image: 'img', capacity: 0 })
  expect(fixture.world().sandboxes[zero].capacity).toBe(1)
  const fractional = fixture.api.sandboxes.create({ name: 'half-box', kind: 'docker', host: 'docker.internal', image: 'img', capacity: 1.5 })
  expect(fixture.world().sandboxes[fractional].capacity).toBe(1)
})

test('seeded sandboxes carry their capacities and a canvas sandbox starts at 1', () => {
  const fixture = makeFixture()
  const w = fixture.world()
  expect(w.sandboxes[sb('sb-local-1')].capacity).toBe(1)
  expect(w.sandboxes[sb('sb-docker-1')].capacity).toBe(2)
  expect(w.sandboxes[sb('sb-vps-1')].capacity).toBe(4)
  expect(Object.values(w.sandboxes).flatMap((x) => x.leases)).toEqual([])

  const id = fixture.api.graph.createNode('sandbox', { x: 0, y: 0 }) as SandboxId
  expect(fixture.world().sandboxes[id].capacity).toBe(1)
  expect(fixture.world().sandboxes[id].leases).toEqual([])
})

test('a capacity-2 sandbox hosts two runs and holds the third at no free sandbox', () => {
  const fixture = makeFixture()
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.agents.update(coder, { concurrency: 3 })
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  for (const title of ['one', 'two', 'three']) fixture.api.agents.enqueue(coder, { title, prompt: 'p', priority: 'normal' })

  fixture.api.sim.advance(1)
  const w = fixture.world()
  const tasks = tasksForAgent(fixture, coder)
  expect(tasks).toHaveLength(3)
  expect(tasks.filter((t) => t.status === 'running')).toHaveLength(2)
  const waiting = tasks.filter((t) => t.status === 'waiting')
  expect(waiting).toHaveLength(1)
  expect(waiting[0].blockedOn).toBe('no free sandbox')

  const box = w.sandboxes[sb('sb-docker-1')]
  expect(box.leases).toHaveLength(2)
  for (const lease of box.leases) {
    const run = w.runs[lease.runId]
    expect(run.status).toBe('running')
    expect(lease.agentId).toBe(coder)
    expect(lease.since).toBe(run.startedAt)
  }
})

test('mac-studio at capacity 1 hosts one run and holds the second at no free sandbox', () => {
  const fixture = makeFixture()
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.agents.update(coder, { concurrency: 2 })
  fixture.api.graph.connect(coder, sb('sb-local-1'), 'runs-in')
  fixture.api.agents.enqueue(coder, { title: 'one', prompt: 'p', priority: 'normal' })
  fixture.api.agents.enqueue(coder, { title: 'two', prompt: 'p', priority: 'normal' })

  fixture.api.sim.advance(1)
  const tasks = tasksForAgent(fixture, coder)
  expect(tasks.filter((t) => t.status === 'running')).toHaveLength(1)
  const waiting = tasks.filter((t) => t.status === 'waiting')
  expect(waiting).toHaveLength(1)
  expect(waiting[0].blockedOn).toBe('no free sandbox')
  expect(fixture.world().sandboxes[sb('sb-local-1')].leases).toHaveLength(1)
})

test('an agent without a runs-in edge waits with no sandbox attached', () => {
  const fixture = makeFixture()
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.agents.enqueue(coder, { title: 'orphan', prompt: 'p', priority: 'normal' })

  fixture.api.sim.advance(1)
  const task = tasksForAgent(fixture, coder)[0]
  expect(task.status).toBe('waiting')
  expect(task.blockedOn).toBe('no sandbox attached')
})

test('raising capacity admits the waiting task on the next scheduling pass', () => {
  const fixture = makeFixture()
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.agents.update(coder, { concurrency: 3 })
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.agents.enqueue(coder, { title: 'one', prompt: 'p', priority: 'normal' })
  fixture.api.agents.enqueue(coder, { title: 'two', prompt: 'p', priority: 'normal' })
  const third = fixture.api.agents.enqueue(coder, { title: 'three', prompt: 'p', priority: 'normal' })

  fixture.api.sim.advance(1)
  expect(fixture.task(third).status).toBe('waiting')
  expect(fixture.task(third).blockedOn).toBe('no free sandbox')

  fixture.api.sandboxes.update(sb('sb-docker-1'), { capacity: 3 })
  fixture.api.sim.advance(1)
  const w = fixture.world()
  expect(w.tasks[third].status).toBe('running')
  expect(w.sandboxes[sb('sb-docker-1')].leases).toHaveLength(3)
})

test('lowering capacity below the lease count leaves runs running and admits nothing until one finishes', () => {
  const fixture = makeFixture()
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.agents.update(coder, { concurrency: 3 })
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  const first = fixture.api.agents.enqueue(coder, { title: 'one', prompt: 'p', priority: 'normal' })
  const second = fixture.api.agents.enqueue(coder, { title: 'two', prompt: 'p', priority: 'normal' })
  const third = fixture.api.agents.enqueue(coder, { title: 'three', prompt: 'p', priority: 'normal' })

  fixture.api.sim.advance(1)
  expect(fixture.task(first).status).toBe('running')
  expect(fixture.task(second).status).toBe('running')
  expect(fixture.task(third).status).toBe('waiting')
  const runningRuns = Object.values(fixture.world().runs).filter((r) => r.status === 'running').map((r) => r.id).sort()

  fixture.api.sandboxes.update(sb('sb-docker-1'), { capacity: 1 })
  fixture.api.sim.advance(1)
  let w = fixture.world()
  expect(w.sandboxes[sb('sb-docker-1')].capacity).toBe(1)
  expect(w.tasks[first].status).toBe('running')
  expect(w.tasks[second].status).toBe('running')
  expect(Object.values(w.runs).filter((r) => r.status === 'running').map((r) => r.id).sort()).toEqual(runningRuns)
  expect(w.sandboxes[sb('sb-docker-1')].leases).toHaveLength(2)
  expect(w.tasks[third].blockedOn).toBe('no free sandbox')

  fixture.api.sim.advance(12_500) // both runs finish, leases drop below the lowered capacity
  w = fixture.world()
  expect(w.tasks[first].status).toBe('succeeded')
  expect(w.tasks[second].status).toBe('succeeded')
  expect(w.tasks[third].status).toBe('running')
  expect(w.sandboxes[sb('sb-docker-1')].leases).toHaveLength(1)
})

test('stop fails every leased run, retries each task per policy and empties leases', () => {
  const fixture = makeFixture()
  const coder = twoCoderLeases(fixture, sb('sb-docker-1'))
  expect(fixture.world().sandboxes[sb('sb-docker-1')].leases).toHaveLength(2)

  fixture.api.sandboxes.act(sb('sb-docker-1'), 'stop')
  const w = fixture.world()
  const runs = Object.values(w.runs)
  expect(runs).toHaveLength(2)
  expect(runs.every((r) => r.status === 'failed' && r.error === 'sandbox stop')).toBe(true)
  expect(w.sandboxes[sb('sb-docker-1')].leases).toEqual([])
  expect(w.sandboxes[sb('sb-docker-1')].state).toBe('stopping')

  for (const task of tasksForAgent(fixture, coder)) {
    expect(task.status).toBe('waiting')
    expect(task.retryAt).toBe(w.now + 2000) // Coder backoff: 2s exponential after attempt 1
    expect(task.blockedOn).toBe('retry 2/3 in 2s')
  }
})

for (const action of ['restart', 'rebuild', 'destroy'] as const) {
  test(`${action} fails every leased run and empties leases`, () => {
    const fixture = makeFixture()
    const coder = twoCoderLeases(fixture, sb('sb-docker-1'))
    fixture.api.sandboxes.act(sb('sb-docker-1'), action)

    const w = fixture.world()
    const runs = Object.values(w.runs)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.status === 'failed' && r.error === `sandbox ${action}`)).toBe(true)
    expect(w.sandboxes[sb('sb-docker-1')].leases).toEqual([])
    for (const task of tasksForAgent(fixture, coder)) {
      expect(task.status).toBe('waiting')
      expect(task.retryAt).not.toBeNull()
    }
  })
}

test('deleting a sandbox node fails every leased run with sandbox deleted', () => {
  const fixture = makeFixture()
  const coder = twoCoderLeases(fixture, sb('sb-docker-1'))
  fixture.api.graph.deleteNodes([sb('sb-docker-1')])

  const w = fixture.world()
  expect(w.sandboxes[sb('sb-docker-1')]).toBeUndefined()
  const runs = Object.values(w.runs)
  expect(runs).toHaveLength(2)
  expect(runs.every((r) => r.status === 'failed' && r.error === 'sandbox deleted')).toBe(true)
  for (const task of tasksForAgent(fixture, coder)) {
    expect(task.status).toBe('waiting')
    expect(task.retryAt).not.toBeNull()
  }
})

test('a pre-slice save is discarded and a v2 save restores capacity without leases', () => {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {}) // load() and save() are browser-only
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
  try {
    store.set('factory.world.v1', JSON.stringify({
      agents: {}, triggers: {}, edges: {}, sim: { paused: false, speed: 1 },
      sandboxes: {
        'sb-old': {
          id: 'sb-old', name: 'old', kind: 'docker', host: 'h', image: 'i', state: 'running', stateSince: 1,
          progress: 1, metrics: { cpu: 0, mem: 0, disk: 0 }, history: [], lease: { agentId: 'ag-coder', runId: 'run-old', since: 1 },
          restartPending: false, position: { x: 0, y: 0 },
        },
      },
    }))
    const seeded = new MockServer({ manual: true, rng: RNG })
    expect(Object.keys(seeded.snapshot().sandboxes)).toHaveLength(3) // seed, not the v1 save
    expect(seeded.snapshot().sandboxes[sb('sb-docker-1')].capacity).toBe(2)

    store.set('factory.world.v2', JSON.stringify({
      agents: {}, triggers: {}, edges: {}, sim: { paused: false, speed: 1 },
      sandboxes: {
        'sb-keep': {
          id: 'sb-keep', name: 'keep', kind: 'docker', host: 'h', image: 'i', state: 'running', stateSince: 1,
          progress: 1, metrics: { cpu: 0, mem: 0, disk: 0 }, history: [{ cpu: 1, mem: 1, disk: 1 }],
          leases: [{ agentId: 'ag-coder', runId: 'run-x', since: 1 }], capacity: 4, restartPending: false,
          position: { x: 0, y: 0 },
        },
      },
    }))
    const loaded = new MockServer({ manual: true, rng: RNG })
    const box = loaded.snapshot().sandboxes[sb('sb-keep')]
    expect(box.capacity).toBe(4)
    expect(box.leases).toEqual([])
    expect(box.history).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a persisted sandbox with an invalid capacity loads with capacity 1', () => {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {}) // load() and save() are browser-only
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
  const box = (id: string, capacity: number | undefined) => ({
    id, name: id, kind: 'docker', host: 'h', image: 'i', state: 'running', stateSince: 1,
    progress: 1, metrics: { cpu: 0, mem: 0, disk: 0 }, history: [], leases: [],
    capacity, restartPending: false, position: { x: 0, y: 0 },
  })
  try {
    store.set('factory.world.v2', JSON.stringify({
      agents: {}, triggers: {}, edges: {}, sim: { paused: false, speed: 1 },
      sandboxes: {
        'sb-zero': box('sb-zero', 0),
        'sb-frac': box('sb-frac', 2.5),
        'sb-missing': box('sb-missing', undefined),
        'sb-good': box('sb-good', 3),
      },
    }))
    const loaded = new MockServer({ manual: true, rng: RNG })
    const w = loaded.snapshot()
    expect(w.sandboxes[sb('sb-zero')].capacity).toBe(1)
    expect(w.sandboxes[sb('sb-frac')].capacity).toBe(1)
    expect(w.sandboxes[sb('sb-missing')].capacity).toBe(1)
    expect(w.sandboxes[sb('sb-good')].capacity).toBe(3)
    expect(w.sandboxes[sb('sb-good')].leases).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the scheduler takes the least-loaded attached sandbox and clears only the finished run lease', () => {
  const fixture = makeFixture()
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.agents.update(coder, { concurrency: 3 })
  const boxB = fixture.api.sandboxes.create({ name: 'box-b', kind: 'docker', host: 'docker.internal', image: 'img', capacity: 2 })
  fixture.api.sim.advance(6000) // box-b finishes provisioning
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in') // builder-a edge first: wins ties
  fixture.api.graph.connect(coder, boxB, 'runs-in')

  const a = fixture.api.agents.enqueue(coder, { title: 'a', prompt: 'p', priority: 'normal' })
  fixture.api.sim.advance(1)
  expect(fixture.task(a).status).toBe('running')
  expect(fixture.world().sandboxes[sb('sb-docker-1')].leases).toHaveLength(1)
  expect(fixture.world().sandboxes[boxB].leases).toHaveLength(0)

  const b = fixture.api.agents.enqueue(coder, { title: 'b', prompt: 'p', priority: 'normal' })
  fixture.api.sim.advance(1)
  expect(fixture.world().sandboxes[boxB].leases).toHaveLength(1) // least loaded beats edge order
  expect(fixture.world().sandboxes[sb('sb-docker-1')].leases).toHaveLength(1)

  const c = fixture.api.agents.enqueue(coder, { title: 'c', prompt: 'p', priority: 'normal' })
  fixture.api.sim.advance(1)
  expect(fixture.world().sandboxes[sb('sb-docker-1')].leases).toHaveLength(2) // tied: first edge wins
  expect(fixture.world().sandboxes[boxB].leases).toHaveLength(1)

  const runA = Object.values(fixture.world().runs).find((r) => r.taskId === a)!
  fixture.api.sim.advance(12_498) // only run a reaches its 12.5s duration
  const w = fixture.world()
  expect(w.runs[runA.id].status).toBe('succeeded')
  expect(w.tasks[b].status).toBe('running')
  expect(w.tasks[c].status).toBe('running')
  const builder = w.sandboxes[sb('sb-docker-1')]
  expect(builder.leases).toHaveLength(1) // the same-agent second lease survives
  expect(builder.leases[0].runId).toBe(Object.values(w.runs).find((r) => r.taskId === c)!.id)
  expect(w.sandboxes[boxB].leases).toHaveLength(1)
  expect(w.sandboxes[boxB].leases[0].runId).toBe(Object.values(w.runs).find((r) => r.taskId === b)!.id)
})
