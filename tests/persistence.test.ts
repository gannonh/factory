/**
 * Persistence behavior, exercised through the public API surface in
 * `src/api/client.ts` against an in-memory storage injected into MockServer.
 * A reload is simulated by constructing a second MockServer on the same
 * storage. Fake timers flush the 1s save throttle; manual-mode servers have
 * no interval, so save timeouts are the only pending timers.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApi, type Api } from '../src/api/client'
import { MockServer, retainWorld, STORAGE_KEY } from '../src/api/mockServer'
import { seedWorld } from '../src/domain/seed'
import type { AgentId, FactoryEvent, FlowId, Run, RunId, SandboxId, Task, TaskId, TriggerId, World } from '../src/domain/types'

const RNG = () => 0.5
const sb = (id: string) => id as SandboxId

function makeStorage() {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
}

type Storage = ReturnType<typeof makeStorage>

type Fixture = {
  server: MockServer
  api: Api
  world: () => World
  agent: (name: string) => AgentId
  task: (id: TaskId) => Task
  flushSave: () => void
}

/**
 * Boot a manual server on `storage`. `isolate` turns the seeded triggers off
 * and drops the seeded handoff edges, mirroring the other API fixtures.
 */
function boot(storage: Storage, isolate = false): Fixture {
  const server = new MockServer({ manual: true, rng: RNG, storage })
  const api = createApi(server)
  let latest = server.snapshot()
  api.subscribe((w) => { latest = w })
  const fixture: Fixture = {
    server,
    api,
    world: () => latest,
    agent: (name) => {
      const found = Object.values(latest.agents).find((a) => a.name === name)
      if (!found) throw new Error(`no agent named ${name}`)
      return found.id
    },
    task: (id) => {
      const t = latest.tasks[id]
      if (!t) throw new Error(`no task ${id}`)
      return t
    },
    flushSave: () => vi.advanceTimersByTime(1000),
  }
  if (isolate) {
    for (const tr of Object.values(latest.triggers)) api.triggers.update(tr.id, { enabled: false })
    api.graph.removeEdges(Object.values(latest.edges).filter((e) => e.kind === 'handoff').map((e) => e.id))
  }
  return fixture
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

test('a completed run and simulated time survive a reload', () => {
  const storage = makeStorage()
  const first = boot(storage, true)
  first.api.agents.enqueue(first.agent('Planner'), { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  const before = first.world()
  const run = Object.values(before.runs)[0]
  expect(run.status).toBe('succeeded')
  first.flushSave()

  const second = boot(storage)
  const after = second.world()
  const restored = after.runs[run.id]
  expect(restored.status).toBe('succeeded')
  expect(restored.attempt).toBe(run.attempt)
  expect(restored.tokens).toBe(run.tokens)
  expect(restored.startedAt).toBe(run.startedAt)
  expect(restored.endedAt).toBe(run.endedAt)
  expect(restored.output).toEqual(run.output)
  expect(after.now).toBe(before.now)
  expect(restored.endedAt! - restored.startedAt).toBe(run.endedAt! - run.startedAt)
  expect(after.tasks[run.taskId].flowId).toBe(before.tasks[run.taskId].flowId)
})

test('a run in progress at reload is failed with interrupted by reload and its task retries', () => {
  const storage = makeStorage()
  const first = boot(storage, true)
  first.api.agents.enqueue(first.agent('Coder'), { title: 'work', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  const run = Object.values(first.world().runs)[0]
  expect(run.status).toBe('running')
  first.flushSave()

  const second = boot(storage)
  const w = second.world()
  const restored = w.runs[run.id]
  expect(restored.status).toBe('failed')
  expect(restored.error).toBe('interrupted by reload')
  expect(restored.endedAt).toBe(w.now)
  expect(restored.endedAt! - restored.startedAt).toBeGreaterThanOrEqual(0)
  expect(w.sandboxes[restored.sandboxId].leases).toEqual([])
  const task = second.task(restored.taskId)
  expect(task.status).toBe('waiting')
  expect(task.retryAt).toBe(w.now + 2000)
  expect(task.blockedOn).toBe('retry 2/3 in 2s')
  const interruptions = w.events.filter((e) => e.subject.kind === 'run' && e.subject.id === run.id && e.msg.includes('interrupted by reload'))
  expect(interruptions).toHaveLength(1)

  second.api.sim.advance(2000)
  expect(second.task(task.id).status).toBe('running')
})

test('an interrupted run with no retries left fails its task like a live failure', () => {
  const storage = makeStorage()
  const first = boot(storage, true)
  const coder = first.agent('Coder')
  first.api.agents.update(coder, { retry: { maxAttempts: 1, backoffMs: 2000, backoff: 'fixed' } })
  first.api.agents.enqueue(coder, { title: 'work', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  const run = Object.values(first.world().runs)[0]
  expect(run.status).toBe('running')
  first.flushSave()

  const second = boot(storage)
  const w = second.world()
  const restored = w.runs[run.id]
  expect(restored.status).toBe('failed')
  expect(restored.error).toBe('interrupted by reload')
  const task = second.task(restored.taskId)
  expect(task.status).toBe('failed')
  expect(task.blockedOn).toBeNull()
  expect(w.agents[coder].failed).toBe(1)
  expect(w.agents[coder].status).toBe('error')
  const interruptions = w.events.filter((e) => e.subject.kind === 'run' && e.subject.id === run.id && e.msg.includes('interrupted by reload'))
  expect(interruptions).toHaveLength(1)
})

test('a waiting handoff task survives a reload with its origin, input and blockedOn', () => {
  const storage = makeStorage()
  const first = boot(storage)
  const planner = first.agent('Planner')
  const coder = first.agent('Coder')
  for (const tr of Object.values(first.world().triggers)) first.api.triggers.update(tr.id, { enabled: false })
  first.api.graph.removeEdges(Object.values(first.world().edges).filter((e) => e.kind === 'handoff' && e.source === coder).map((e) => e.id))
  first.api.graph.removeEdges(Object.values(first.world().edges).filter((e) => e.kind === 'runs-in' && e.source === coder).map((e) => e.id))
  const trigger = first.api.graph.createNode('trigger', { x: 40, y: 40 })
  first.api.graph.connect(trigger, planner, 'triggers')
  first.api.triggers.fire(trigger as TriggerId)
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  const before = first.world()
  const handoff = Object.values(before.tasks).find((t) => t.origin.kind === 'handoff')
  expect(handoff).toBeDefined()
  expect(handoff!.input).not.toBeNull()
  expect(handoff!.blockedOn).toBe('no sandbox attached')
  first.flushSave()

  const second = boot(storage)
  const w = second.world()
  const restored = w.tasks[handoff!.id]
  expect(restored.status).toBe(handoff!.status)
  expect(restored.flowId).toBe(handoff!.flowId)
  expect(restored.priority).toBe(handoff!.priority)
  expect(restored.origin).toEqual(handoff!.origin)
  expect(restored.input).toEqual(handoff!.input)
  expect(restored.blockedOn).toBe('no sandbox attached')

  second.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  second.api.sim.advance(1)
  expect(second.task(restored.id).status).toBe('running')
})

test('a task waiting on a retry deadline survives a reload and honours retryAt', () => {
  const storage = makeStorage()
  const first = boot(storage, true)
  const coder = first.agent('Coder')
  first.api.agents.update(coder, { timeoutMs: 5000 })
  first.api.agents.enqueue(coder, { title: 'slow', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(5001)
  const failed = Object.values(first.world().runs)[0]
  const task = first.task(failed.taskId)
  expect(failed.status).toBe('failed')
  expect(failed.error).toBe('timeout')
  expect(task.status).toBe('waiting')
  const retryAt = task.retryAt!
  expect(retryAt).toBeGreaterThan(first.world().now)
  first.flushSave()

  const second = boot(storage)
  const w = second.world()
  const restored = w.tasks[task.id]
  expect(w.runs[failed.id].error).toBe('timeout')
  expect(restored.status).toBe('waiting')
  expect(restored.retryAt).toBe(retryAt)
  expect(restored.blockedOn).toBe(task.blockedOn)

  second.api.sim.advance(retryAt - w.now - 1)
  expect(second.task(task.id).status).toBe('waiting')
  second.api.sim.advance(2)
  expect(second.task(task.id).status).toBe('running')
})

test('a fresh module reseeds ids above the restored events', async () => {
  const storage = makeStorage()
  const first = boot(storage, true)
  first.api.agents.enqueue(first.agent('Planner'), { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  const before = first.world()
  const maxRestoredId = Math.max(...before.events.map((e) => e.id))
  first.flushSave()

  vi.resetModules()
  const { MockServer: FreshServer } = await import('../src/api/mockServer')
  const { createApi: freshCreateApi } = await import('../src/api/client')
  const second = new FreshServer({ manual: true, rng: RNG, storage })
  const api = freshCreateApi(second)
  const w = second.snapshot()
  expect(w.events).toEqual(before.events)

  const node = api.graph.createNode('agent', { x: 0, y: 0 })
  const after = second.snapshot()
  const created = after.events.find((e) => e.subject.kind === 'agent' && e.subject.id === node)
  expect(created).toBeDefined()
  expect(created!.id).toBeGreaterThan(maxRestoredId)
  expect(new Set(after.events.map((e) => e.id)).size).toBe(after.events.length)
})

test('reset clears the saved history and restores the seed', () => {
  const storage = makeStorage()
  const first = boot(storage, true)
  first.api.agents.enqueue(first.agent('Planner'), { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  first.flushSave()
  expect(storage.getItem(STORAGE_KEY)).not.toBeNull()

  first.api.sim.reset()
  expect(storage.getItem(STORAGE_KEY)).toBeNull()
  const w = first.world()
  expect(Object.keys(w.tasks)).toEqual([])
  expect(Object.keys(w.runs)).toEqual([])
  expect(w.events).toEqual([])

  // the pending save timer flushes the fresh seed, never the pre-reset history
  vi.advanceTimersByTime(1000)
  const saved = JSON.parse(storage.getItem(STORAGE_KEY)!) as Pick<World, 'tasks' | 'runs' | 'events'>
  expect(Object.keys(saved.tasks)).toEqual([])
  expect(Object.keys(saved.runs)).toEqual([])
  expect(saved.events).toEqual([])

  const third = boot(storage)
  expect(Object.keys(third.world().tasks)).toEqual([])
  expect(Object.keys(third.world().runs)).toEqual([])
  expect(Object.keys(third.world().agents)).toHaveLength(4)
})

test('a reload keeps the newest 200 completed runs plus the interrupted one, never orphaning tasks', () => {
  const storage = makeStorage()
  const first = boot(storage)
  const planner = first.agent('Planner')
  const coder = first.agent('Coder')
  const qa = first.agent('QA')
  for (const tr of Object.values(first.world().triggers)) first.api.triggers.update(tr.id, { enabled: false })
  first.api.graph.removeEdges(Object.values(first.world().edges).filter((e) => e.kind === 'handoff' || e.kind === 'runs-in').map((e) => e.id))
  first.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  first.api.graph.connect(qa, sb('sb-docker-1'), 'runs-in')
  first.api.graph.connect(planner, coder, 'depends-on')
  const trigger = first.api.graph.createNode('trigger', { x: 40, y: 40 })
  first.api.graph.connect(trigger, planner, 'triggers')
  first.api.graph.connect(trigger, coder, 'triggers')
  first.api.triggers.fire(trigger as TriggerId)
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)

  const plannerTask = Object.values(first.world().tasks).find((t) => t.agentId === planner)!
  const coderTask = Object.values(first.world().tasks).find((t) => t.agentId === coder)!
  expect(first.world().tasks[plannerTask.id].status).toBe('succeeded')
  expect(first.world().tasks[coderTask.id].status).toBe('waiting')
  expect(first.world().tasks[coderTask.id].blockedOn).toBe('no sandbox attached')
  const prunedRun = Object.values(first.world().runs).find((r) => r.taskId === plannerTask.id)!

  for (let i = 0; i < 206; i++) first.api.agents.enqueue(qa, { title: `serial ${i}`, prompt: 'p', priority: 'normal' })
  for (let i = 0; i < 206; i++) first.api.sim.advance(12_500)

  const before = first.world()
  const completed = Object.values(before.runs)
    .filter((r) => r.status === 'succeeded')
    .sort((a, b) => a.startedAt - b.startedAt)
  expect(completed).toHaveLength(206) // the planner run and 205 of the serial runs
  expect(Object.values(before.runs).filter((r) => r.status === 'running')).toHaveLength(1)
  expect(completed[0].id).toBe(prunedRun.id) // the planner run is the oldest
  const newest200 = new Set(completed.slice(-200).map((r) => r.id))
  first.flushSave()

  const second = boot(storage)
  const w = second.world()
  const runs = Object.values(w.runs)
  expect(runs).toHaveLength(201)
  const succeeded = runs.filter((r) => r.status === 'succeeded')
  expect(succeeded).toHaveLength(200)
  expect(succeeded.every((r) => newest200.has(r.id))).toBe(true)
  expect(runs.some((r) => r.id === prunedRun.id)).toBe(false)
  const interrupted = runs.find((r) => r.status === 'failed')!
  expect(interrupted.error).toBe('interrupted by reload')
  for (const run of runs) expect(w.tasks[run.taskId]).toBeDefined()
  // the pruned planner run's task survives: the waiting coder task shares its flow
  expect(w.tasks[plannerTask.id].status).toBe('succeeded')
  expect(w.tasks[coderTask.id].status).toBe('waiting')
  expect(w.tasks[coderTask.id].flowId).toBe(plannerTask.flowId)
})

test('retainWorld selects runs, tasks and events by the persistence rules', () => {
  const w = seedWorld(1000)
  const run = (id: string, taskId: TaskId, startedAt: number, status: Run['status']): Run => ({
    id: id as RunId, taskId, agentId: 'ag-coder' as AgentId, sandboxId: sb('sb-docker-1'), title: id, attempt: 1,
    status, progress: status === 'running' ? 0.5 : 1, durationMs: 10, startedAt, endedAt: status === 'running' ? null : startedAt + 10,
    tokens: 1, output: null, error: null,
  })
  const task = (id: string, flowId: string, status: Task['status']): Task => ({
    id: id as TaskId, flowId: flowId as FlowId, agentId: 'ag-coder' as AgentId, title: id, prompt: 'p', priority: 'normal',
    status, origin: { kind: 'manual' }, input: null, createdAt: 0, attempts: 1, retryAt: null, blockedOn: null,
  })
  for (let i = 1; i <= 210; i++) {
    const t = task(`tk-${i}`, `fl-${i}`, 'succeeded')
    w.tasks[t.id] = t
    w.runs[`run-${i}` as RunId] = run(`run-${i}`, t.id, i, 'succeeded')
  }
  const live = task('tk-live', 'fl-live', 'running')
  w.tasks[live.id] = live
  w.runs['run-live' as RunId] = run('run-live', live.id, 211, 'running')
  const dropped = task('tk-dropped', 'fl-dropped', 'cancelled')
  w.tasks[dropped.id] = dropped
  const prerequisite = task('tk-prereq', 'fl-pending', 'succeeded')
  const pending = task('tk-pending', 'fl-pending', 'waiting')
  w.tasks[prerequisite.id] = prerequisite
  w.tasks[pending.id] = pending
  w.logs = [{ id: 1, ts: 0, level: 'info', runId: null, agentId: null, msg: 'session log' }]
  w.events = Array.from({ length: 450 }, (_, i): FactoryEvent => ({
    id: i + 1, ts: 0, kind: 'graph', subject: { kind: 'agent', id: 'ag-coder' as AgentId }, msg: `event ${i + 1}`,
  }))

  const p = retainWorld(w)
  const kept = Object.values(p.runs)
  expect(kept.filter((r) => r.status === 'running').map((r) => r.id)).toEqual(['run-live'])
  const completed = kept.filter((r) => r.status !== 'running')
  expect(completed).toHaveLength(200)
  expect(completed.map((r) => r.startedAt).sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 11))
  expect(p.tasks['tk-live' as TaskId]).toBeDefined()
  expect(p.tasks['tk-11' as TaskId]).toBeDefined()
  expect(p.tasks['tk-10' as TaskId]).toBeUndefined() // its run fell out of the window
  expect(p.tasks[dropped.id]).toBeUndefined()
  expect(p.tasks[pending.id]).toBeDefined()
  expect(p.tasks[prerequisite.id]).toBeDefined() // shares the pending task's flow
  expect(p.events).toHaveLength(400)
  expect(p.events[0].id).toBe(51)
  expect(p.events[399].id).toBe(450)
  expect('logs' in p).toBe(false)
})
