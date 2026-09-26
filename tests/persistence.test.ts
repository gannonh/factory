/**
 * Persistence behavior, exercised through the in-process API in
 * `server/api.ts`. A restart is simulated by constructing a second MockServer
 * on the same store: a string in memory, or a real world file in a temp dir.
 * Fake timers flush the 1s save throttle and pin Date.now so generated ids are
 * literal; manual-mode servers have no interval, so save timeouts are the only
 * pending timers.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MockServer, retainWorld } from '../server/simulation'
import { fileStore, worldFilePath } from '../server/worldFile'
import { seedWorld } from '../src/domain/seed'
import type { AgentId, FactoryEvent, FlowId, Run, RunId, Task, TaskId, TriggerId, World } from '../src/domain/types'
import { makeFixture, memoryStore, RNG, sb } from './fixture'

const flushSave = () => vi.advanceTimersByTime(1000)
let dir = ''

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  dir = mkdtempSync(join(tmpdir(), 'factory-persistence-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

test('a completed run and simulated time survive a restart', () => {
  const store = memoryStore()
  const first = makeFixture({ store, isolate: true })
  first.api.agents.enqueue(first.agent('Planner'), { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  const before = first.world()
  const run = Object.values(before.runs)[0]
  expect(run.status).toBe('succeeded')
  flushSave()

  const second = makeFixture({ store, isolate: false })
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

test('a run in progress at restart is failed with interrupted by restart and its task retries', () => {
  const store = memoryStore()
  const first = makeFixture({ store, isolate: true })
  first.api.agents.enqueue(first.agent('Coder'), { title: 'work', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  const run = Object.values(first.world().runs)[0]
  expect(run.status).toBe('running')
  flushSave()

  const second = makeFixture({ store, isolate: false })
  const w = second.world()
  const restored = w.runs[run.id]
  expect(restored.status).toBe('failed')
  expect(restored.error).toBe('interrupted by restart')
  expect(restored.endedAt).toBe(w.now)
  expect(restored.endedAt! - restored.startedAt).toBeGreaterThanOrEqual(0)
  expect(w.sandboxes[restored.sandboxId].leases).toEqual([])
  const task = second.task(restored.taskId)
  expect(task.status).toBe('waiting')
  expect(task.retryAt).toBe(w.now + 2000)
  expect(task.blockedOn).toBe('retry 2/3 in 2s')
  const interruptions = w.events.filter((e) => e.subject.kind === 'run' && e.subject.id === run.id && e.msg.includes('interrupted by restart'))
  expect(interruptions).toHaveLength(1)

  second.api.sim.advance(2000)
  expect(second.task(task.id).status).toBe('running')
})

test('an interrupted run with no retries left fails its task like a live failure', () => {
  const store = memoryStore()
  const first = makeFixture({ store, isolate: true })
  const coder = first.agent('Coder')
  first.api.agents.update(coder, { retry: { maxAttempts: 1, backoffMs: 2000, backoff: 'fixed' } })
  first.api.agents.enqueue(coder, { title: 'work', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  const run = Object.values(first.world().runs)[0]
  expect(run.status).toBe('running')
  flushSave()

  const second = makeFixture({ store, isolate: false })
  const w = second.world()
  const restored = w.runs[run.id]
  expect(restored.status).toBe('failed')
  expect(restored.error).toBe('interrupted by restart')
  const task = second.task(restored.taskId)
  expect(task.status).toBe('failed')
  expect(task.blockedOn).toBeNull()
  expect(w.agents[coder].failed).toBe(1)
  expect(w.agents[coder].status).toBe('error')
  const interruptions = w.events.filter((e) => e.subject.kind === 'run' && e.subject.id === run.id && e.msg.includes('interrupted by restart'))
  expect(interruptions).toHaveLength(1)
})

test('a waiting handoff task survives a restart with its origin, input and blockedOn', () => {
  const store = memoryStore()
  const first = makeFixture({ store, isolate: false })
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
  flushSave()

  const second = makeFixture({ store, isolate: false })
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

test('a task waiting on a retry deadline survives a restart and honours retryAt', () => {
  const store = memoryStore()
  const first = makeFixture({ store, isolate: true })
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
  flushSave()

  const second = makeFixture({ store, isolate: false })
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
  const store = memoryStore()
  const first = makeFixture({ store, isolate: true })
  first.api.agents.enqueue(first.agent('Planner'), { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  const before = first.world()
  const maxRestoredId = Math.max(...before.events.map((e) => e.id))
  flushSave()

  vi.resetModules()
  const { MockServer: FreshServer } = await import('../server/simulation')
  const { createApi: freshCreateApi } = await import('../server/api')
  const second = new FreshServer({ manual: true, rng: RNG, store })
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
  const store = memoryStore()
  const first = makeFixture({ store, isolate: true })
  first.api.agents.enqueue(first.agent('Planner'), { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  flushSave()
  expect(store.text).not.toBeNull()

  first.api.sim.reset()
  expect(store.text).toBeNull()
  const w = first.world()
  expect(Object.keys(w.tasks)).toEqual([])
  expect(Object.keys(w.runs)).toEqual([])
  expect(w.events).toEqual([])

  // the pending save timer flushes the fresh seed, never the pre-reset history
  vi.advanceTimersByTime(1000)
  const saved = JSON.parse(store.text!) as Pick<World, 'tasks' | 'runs' | 'events'>
  expect(Object.keys(saved.tasks)).toEqual([])
  expect(Object.keys(saved.runs)).toEqual([])
  expect(saved.events).toEqual([])

  const third = makeFixture({ store, isolate: false })
  expect(Object.keys(third.world().tasks)).toEqual([])
  expect(Object.keys(third.world().runs)).toEqual([])
  expect(Object.keys(third.world().agents)).toHaveLength(4)
})

test('a restart keeps the newest 200 completed runs plus the interrupted one, never orphaning tasks', () => {
  const store = memoryStore()
  const first = makeFixture({ store, isolate: false })
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
  flushSave()

  const second = makeFixture({ store, isolate: false })
  const w = second.world()
  const runs = Object.values(w.runs)
  expect(runs).toHaveLength(201)
  const succeeded = runs.filter((r) => r.status === 'succeeded')
  expect(succeeded).toHaveLength(200)
  expect(succeeded.every((r) => newest200.has(r.id))).toBe(true)
  expect(runs.some((r) => r.id === prunedRun.id)).toBe(false)
  const interrupted = runs.find((r) => r.status === 'failed')!
  expect(interrupted.error).toBe('interrupted by restart')
  for (const run of runs) expect(w.tasks[run.taskId]).toBeDefined()
  // the pruned planner run's task survives: the waiting coder task shares its flow
  expect(w.tasks[plannerTask.id].status).toBe('succeeded')
  expect(w.tasks[coderTask.id].status).toBe('waiting')
  expect(w.tasks[coderTask.id].flowId).toBe(plannerTask.flowId)
})

const VALID_EMPTY_SAVE = {
  now: 1, agents: {}, sandboxes: {}, triggers: {}, edges: {}, groups: {}, sim: { paused: false, speed: 1 },
  tasks: {}, runs: {}, events: [],
}

test('a well-formed empty save loads as an empty world', () => {
  const store = memoryStore()
  store.text = JSON.stringify(VALID_EMPTY_SAVE)
  const server = new MockServer({ manual: true, rng: RNG, store })
  expect(Object.keys(server.snapshot().agents)).toEqual([])
  expect(server.snapshot().now).toBe(1)
})

test('a malformed save is discarded instead of crashing the load', () => {
  const malformed = [
    { label: 'events as an object', patch: { events: {} } },
    { label: 'runs as an array', patch: { runs: [] } },
    { label: 'non-numeric now', patch: { now: 'soon' } },
    { label: 'null run entry', patch: { runs: { 'run-x': null } } },
    { label: 'event without an id', patch: { events: [{ msg: 'no id' }] } },
    { label: 'groups missing', patch: { groups: undefined } },
  ]
  for (const { label, patch } of malformed) {
    const store = memoryStore()
    store.text = JSON.stringify({ ...VALID_EMPTY_SAVE, ...patch })
    let server: MockServer | undefined
    expect(() => { server = new MockServer({ manual: true, rng: RNG, store }) }, label).not.toThrow()
    expect(Object.keys(server!.snapshot().agents), label).toHaveLength(4) // seed, not the malformed save
    expect(Object.keys(server!.snapshot().runs), label).toEqual([])
  }
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

const logger = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => { lines.push(line) } }
}

const fileServer = (path: string, log?: (line: string) => void) =>
  makeFixture({ store: fileStore(path, log), isolate: false })

test('a pipeline survives a restart through the world file', () => {
  const path = join(dir, 'world.json')
  const first = makeFixture({ store: fileStore(path), isolate: true })
  const planner = first.agent('Planner')
  const coder = first.agent('Coder')
  expect(first.api.graph.connect(planner, coder, 'handoff')).toEqual({ ok: true, id: 'ed-mjuohs000' })
  first.api.graph.updatePositions([{ id: planner, position: { x: 100, y: 200 } }, { id: coder, position: { x: 400, y: 200 } }])
  expect(first.api.graph.group([planner, coder])).toBe('gr-mjuohs002')
  first.api.agents.enqueue(planner, { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  first.api.sim.advance(12_500)
  first.server.close()
  expect(existsSync(path)).toBe(true)

  const second = fileServer(path)
  const w = second.world()
  expect(w.now).toBe(1767225625001)
  expect(w.edges['ed-mjuohs000' as keyof World['edges']]).toEqual({ id: 'ed-mjuohs000', kind: 'handoff', source: 'ag-planner', target: 'ag-coder' })
  expect(w.agents[planner].position).toEqual({ x: 100, y: 200 })
  expect(w.agents[coder].position).toEqual({ x: 400, y: 200 })
  expect(w.groups).toEqual({ 'gr-mjuohs002': { id: 'gr-mjuohs002', name: 'Group 1' } })
  expect(w.agents[planner].groupId).toBe('gr-mjuohs002')
  expect(w.agents[coder].groupId).toBe('gr-mjuohs002')
  expect(Object.values(w.tasks).map((t) => [t.id, t.agentId, t.title, t.status, t.flowId])).toEqual([
    ['tk-mjuohs005', 'ag-planner', 'plan', 'succeeded', 'fl-mjuohs004'],
    ['tk-mjuohs00c', 'ag-coder', 'plan → Coder', 'succeeded', 'fl-mjuohs004'],
  ])
  expect(w.runs['run-mjuohs007' as RunId]).toEqual({
    id: 'run-mjuohs007', taskId: 'tk-mjuohs005', agentId: 'ag-planner', sandboxId: 'sb-local-1', title: 'plan', attempt: 1,
    status: 'succeeded', progress: 1, durationMs: 12500, startedAt: 1767225600001, endedAt: 1767225612501, tokens: 4250,
    output: { summary: 'The tech lead completed "plan".', artifacts: [{ kind: 'note', label: 'Completion note for plan', url: null }] },
    error: null,
  })
  expect(w.runs['run-mjuohs00e' as RunId].status).toBe('succeeded')
  expect(w.events).toEqual(first.world().events)
  expect(w.events.filter((e) => e.subject.id === 'run-mjuohs007').map((e) => e.msg)).toEqual([
    'Planner started “plan” on mac-studio',
    'Planner finished “plan”',
  ])
})

test('a run in flight at shutdown comes back failed and retries, or fails its task without retries', () => {
  const path = join(dir, 'world.json')
  const first = makeFixture({ store: fileStore(path), isolate: true })
  const coder = first.agent('Coder')
  const reviewer = first.agent('Reviewer')
  first.api.agents.update(reviewer, { retry: { maxAttempts: 1, backoffMs: 2000, backoff: 'fixed' } })
  first.api.agents.enqueue(coder, { title: 'work', prompt: 'p', priority: 'normal' })
  first.api.agents.enqueue(reviewer, { title: 'review', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  const running = Object.values(first.world().runs)
  expect(running.map((r) => [r.agentId, r.status])).toEqual([['ag-coder', 'running'], ['ag-reviewer', 'running']])
  first.server.close()

  const second = fileServer(path)
  const w = second.world()
  const coderRun = w.runs[running[0].id]
  const reviewerRun = w.runs[running[1].id]
  expect([coderRun.status, coderRun.error]).toEqual(['failed', 'interrupted by restart'])
  expect([reviewerRun.status, reviewerRun.error]).toEqual(['failed', 'interrupted by restart'])
  const coderTask = second.task(coderRun.taskId)
  expect([coderTask.status, coderTask.blockedOn, coderTask.retryAt]).toEqual(['waiting', 'retry 2/3 in 2s', w.now + 2000])
  const reviewerTask = second.task(reviewerRun.taskId)
  expect([reviewerTask.status, reviewerTask.blockedOn]).toEqual(['failed', null])

  second.api.sim.advance(2000)
  expect(second.task(coderTask.id).status).toBe('running')
})

test('reset then restart starts from the seed', () => {
  const path = join(dir, 'world.json')
  const first = makeFixture({ store: fileStore(path), isolate: true })
  first.api.agents.enqueue(first.agent('Planner'), { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.api.sim.advance(12_500)
  first.server.flush()
  first.api.sim.reset()
  expect(existsSync(path)).toBe(false)
  flushSave()
  expect(existsSync(path)).toBe(true)

  const second = fileServer(path)
  const w = second.world()
  const seed = seedWorld(Date.now())
  expect(Object.keys(w.agents)).toEqual(Object.keys(seed.agents))
  expect(Object.keys(w.edges)).toEqual(Object.keys(seed.edges))
  expect(w.tasks).toEqual({})
  expect(w.runs).toEqual({})
  expect(w.events).toEqual([])
})

test('an unreadable world file is set aside and the server starts on the seed', () => {
  const documents = [
    { label: 'truncated JSON', text: '{"now": 1, "agents": {' },
    { label: 'valid JSON, not a world', text: JSON.stringify({ now: 'soon', agents: [] }) },
  ]
  for (const { label, text } of documents) {
    const path = join(dir, `${label.replace(/\W+/g, '-')}.json`)
    writeFileSync(path, text)
    const { lines, log } = logger()
    const server = fileServer(path, log)
    expect(Object.keys(server.world().agents), label).toEqual(['ag-planner', 'ag-coder', 'ag-reviewer', 'ag-qa'])
    expect(readFileSync(`${path}.corrupt`, 'utf8'), label).toBe(text)
    expect(existsSync(path), label).toBe(false)
    expect(lines, label).toHaveLength(1)
    expect(lines[0], label).toContain(`${path}.corrupt`)
    expect(lines[0], label).toContain(path)

    server.server.flush()
    expect(readFileSync(path, 'utf8'), label).not.toBe(text)
    expect(readFileSync(`${path}.corrupt`, 'utf8'), label).toBe(text)
  }
})

test('a world file that fails while replaying interrupted runs is set aside and the server starts on the seed', () => {
  const path = join(dir, 'world.json')
  const first = makeFixture({ store: fileStore(path), isolate: true })
  first.api.agents.enqueue(first.agent('Planner'), { title: 'plan', prompt: 'p', priority: 'normal' })
  first.api.sim.advance(1)
  first.server.close()
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  saved.agents['ag-planner'].retry = null
  const text = JSON.stringify(saved)
  writeFileSync(path, text)

  const { lines, log } = logger()
  const second = fileServer(path, log)
  expect(second.world().runs).toEqual({})
  expect(second.world().events).toEqual([])
  expect(second.world().agents['ag-planner' as AgentId].retry).toEqual({ maxAttempts: 3, backoffMs: 2000, backoff: 'exponential' })
  expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe(text)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain(`${path}.corrupt`)
})

test('a save goes through a temp file, so a failed save leaves the last document whole', () => {
  const path = join(dir, 'data', 'world.json')
  const { lines, log } = logger()
  const store = fileStore(path, log)
  store.save('{"doc":1}')
  expect(readFileSync(path, 'utf8')).toBe('{"doc":1}')
  expect(existsSync(`${path}.tmp`)).toBe(false)

  mkdirSync(`${path}.tmp`)
  store.save('{"doc":2}')
  expect(readFileSync(path, 'utf8')).toBe('{"doc":1}')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain(path)
})

test('the world file lives in FACTORY_DATA_DIR, or .factory under the repo root', () => {
  expect(worldFilePath({ FACTORY_DATA_DIR: '/var/lib/factory' }, '/src/factory')).toBe('/var/lib/factory/world.json')
  expect(worldFilePath({}, '/src/factory')).toBe('/src/factory/.factory/world.json')
  expect(worldFilePath({ FACTORY_DATA_DIR: '' }, '/src/factory')).toBe('/src/factory/.factory/world.json')
})
