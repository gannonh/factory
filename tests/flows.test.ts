/**
 * Flow and dependency behavior, exercised through the public API surface in
 * `src/api/client.ts`. Time advances in controlled steps and an injected RNG
 * makes run outcomes deterministic: with rng -> 0.5 every run lasts 12.5s of
 * simulated time and succeeds; the tests use timeouts and retry limits to
 * force deterministic failures instead.
 */
import { expect, test } from 'vitest'
import { createApi } from '../src/api/client'
import { MockServer } from '../src/api/mockServer'
import type { AgentId, FactoryEvent, SandboxId, Task, TaskId, TriggerId, World } from '../src/domain/types'

const RNG = () => 0.5
const sb = (id: string) => id as SandboxId

type Fixture = {
  api: ReturnType<typeof createApi>
  agent: (name: string) => AgentId
  world: () => World
  task: (id: TaskId) => Task
  firstTask: (agentId: AgentId) => Task
  events: () => FactoryEvent[]
  runs: () => World['runs']
}

/** Fixture with the seeded graph isolated: periodic triggers off, handoff and extra runs-in edges removed. */
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
  const firstTask = (agentId: AgentId): Task => {
    const t = Object.values(world().tasks).find((x) => x.agentId === agentId)
    if (!t) throw new Error(`no task for agent ${agentId}`)
    return t
  }
  // isolate from seeded periodic triggers and base handoff edges so tests build their own graphs
  for (const tr of Object.values(world().triggers)) api.triggers.update(tr.id, { enabled: false })
  api.graph.removeEdges(Object.values(world().edges).filter((e) => e.kind === 'handoff').map((e) => e.id))
  return { api, agent, world, task, firstTask, events: () => world().events, runs: () => world().runs }
}

/** Manual trigger wired to the given agents, for counted firings. */
function manualTrigger(fixture: Fixture, targets: string[]): TriggerId {
  const id = fixture.api.graph.createNode('trigger', { x: 40, y: 400 }) as TriggerId
  for (const name of targets) fixture.api.graph.connect(id, fixture.agent(name), 'triggers')
  return id
}

/** Advance in 400ms steps until the predicate holds, mirroring the live tick. */
function waitUntil(fixture: Fixture, predicate: () => boolean, what: string, maxSteps = 100) {
  for (let i = 0; i < maxSteps; i++) {
    if (predicate()) return
    fixture.api.sim.advance(400)
  }
  throw new Error(`condition not met: ${what}`)
}

test('manual enqueues mint a fresh nonempty flow id per task', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const t1 = fixture.api.agents.enqueue(planner, { title: 'Plan one', prompt: 'p1', priority: 'normal' })
  const t2 = fixture.api.agents.enqueue(planner, { title: 'Plan two', prompt: 'p2', priority: 'normal' })
  const w = fixture.world()
  const f1 = w.tasks[t1].flowId
  const f2 = w.tasks[t2].flowId
  expect(f1.length).toBeGreaterThan(0)
  expect(f2.length).toBeGreaterThan(0)
  expect(f1).not.toBe(f2)
})

test('one trigger firing shares one flow id across all tasks it creates; firings never share', () => {
  const fixture = makeFixture()
  const cron = Object.values(fixture.world().triggers).find((t) => t.kind === 'cron')!
  fixture.api.graph.connect(cron.id, fixture.agent('Coder'), 'triggers')
  fixture.api.triggers.fire(cron.id)
  let w = fixture.world()
  const first = Object.values(w.tasks)
  expect(first.length).toBe(2)
  expect(first[0].flowId).toBe(first[1].flowId)

  fixture.api.triggers.fire(cron.id)
  w = fixture.world()
  const second = Object.values(w.tasks).filter((t) => t.id !== first[0].id && t.id !== first[1].id)
  expect(second.length).toBe(2)
  expect(second[0].flowId).toBe(second[1].flowId)
  expect(second[0].flowId).not.toBe(first[0].flowId)
})

test('automatic firings each mint their own flow id', () => {
  const fixture = makeFixture()
  const cron = Object.values(fixture.world().triggers).find((t) => t.kind === 'cron')!
  fixture.api.graph.connect(cron.id, fixture.agent('Coder'), 'triggers')
  fixture.api.triggers.update(cron.id, { enabled: true, intervalMs: 1000 })
  fixture.api.sim.advance(1000) // initializes lastFiredAt
  fixture.api.sim.advance(1000) // firing A
  fixture.api.sim.advance(1000) // firing B
  const w = fixture.world()
  const tasks = Object.values(w.tasks)
  expect(tasks.length).toBe(4)
  const byFlow = new Map<string, number>()
  for (const t of tasks) byFlow.set(t.flowId, (byFlow.get(t.flowId) ?? 0) + 1)
  expect([...byFlow.values()].sort()).toEqual([2, 2])
})

test('handoff descendants retain the producing task flow id across hops', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  fixture.api.graph.connect(planner, coder, 'handoff')
  const trigger = manualTrigger(fixture, ['Planner'])
  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1) // Planner run starts
  let w = fixture.world()
  const plannerTask = Object.values(w.tasks).find((t) => t.agentId === planner)!
  expect(plannerTask.status).toBe('running')
  const flow = plannerTask.flowId

  fixture.api.sim.advance(12_500) // Planner run completes -> handoff to Coder
  w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.origin.kind === 'handoff' && t.origin.from === planner)!
  expect(coderTask.flowId).toBe(flow)

  fixture.api.graph.connect(coder, fixture.agent('Reviewer'), 'handoff')
  fixture.api.sim.advance(12_500) // Coder run completes -> handoff to Reviewer
  w = fixture.world()
  const reviewerTask = Object.values(w.tasks).find((t) => t.origin.kind === 'handoff' && t.origin.from === coder)!
  expect(reviewerTask.flowId).toBe(flow)
})

test('AC2: coder waits on its own flow planner, then runs while another flow planner is running', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  fixture.api.agents.update(coder, { concurrency: 1 })
  // one dedicated running sandbox per agent
  fixture.api.graph.removeEdges(Object.values(fixture.world().edges).filter((e) => e.kind === 'runs-in').map((e) => e.id))
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1) // scheduling pass: F1 tasks
  let w = fixture.world()
  const tasks = Object.values(w.tasks)
  expect(tasks.length).toBe(4)
  const byFlow = new Map<string, Task[]>()
  for (const t of tasks) byFlow.set(t.flowId, [...(byFlow.get(t.flowId) ?? []), t])
  expect(byFlow.size).toBe(2)
  const [f1, f2] = [...byFlow.values()]
  const plannerF1 = f1.find((t) => t.agentId === planner)!
  const coderF1 = f1.find((t) => t.agentId === coder)!
  expect(plannerF1.status).toBe('running')
  expect(coderF1.status).toBe('waiting')
  expect(coderF1.blockedOn).toContain('waiting on')
  expect(coderF1.blockedOn).toContain(plannerF1.title)
  expect(coderF1.blockedOn).toContain(plannerF1.id)

  fixture.api.sim.advance(12_500) // Planner/F1 succeeds; Coder/F1 and Planner/F2 eligible
  w = fixture.world()
  const plannerF2 = w.tasks[f2.find((t) => t.agentId === planner)!.id]
  const coderF1Now = w.tasks[coderF1.id]
  const runs = Object.values(w.runs)
  expect(runs.filter((r) => r.status === 'running').length).toBe(2)
  expect(coderF1Now.status).toBe('running')
  expect(plannerF2.status).toBe('running')
  expect(coderF1Now.blockedOn).toBeNull()
  // the waiting F1 coder never consumed a sandbox lease before it could run
  const leases = Object.values(w.sandboxes).flatMap((x) => x.leases).map((l) => w.runs[l.runId])
  expect(leases.map((r) => r.status)).toEqual(['running', 'running'])
})

function isolateSandboxes(fixture: Fixture) {
  fixture.api.graph.removeEdges(Object.values(fixture.world().edges).filter((e) => e.kind === 'runs-in').map((e) => e.id))
}

test('AC3: a manual coder task starts while the planner is busy in another flow', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')

  fixture.api.agents.enqueue(planner, { title: 'Busy plan', prompt: 'bp', priority: 'normal' })
  fixture.api.sim.advance(1) // planner run starts
  const manual = fixture.api.agents.enqueue(coder, { title: 'Freelance fix', prompt: 'ff', priority: 'normal' })
  fixture.api.sim.advance(1)
  expect(fixture.task(manual).status).toBe('running')
})

test('AC3: a later matching task does not interrupt an already running task', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1) // both runs start; no dependency yet
  let w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(coderTask.status).toBe('running')

  fixture.api.graph.connect(planner, coder, 'depends-on') // planner task is active in this flow
  fixture.api.sim.advance(12_500)
  w = fixture.world()
  const coderNow = w.tasks[coderTask.id]
  expect(coderNow.status).toBe('succeeded')
  expect(fixture.events().filter((e) => e.msg.includes(coderTask.id) && e.msg.includes('Cancelled'))).toEqual([])
})

test('AC4: a dependent waits for every matching task across multiple upstream agents', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const reviewer = fixture.agent('Reviewer')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(reviewer, sb('sb-docker-1'), 'runs-in')
  fixture.api.sandboxes.create({ name: 'coder-box', kind: 'docker', host: 'docker.internal', image: 'img' })
  fixture.api.sim.advance(6000) // new sandbox finishes provisioning
  const coderBox = Object.values(fixture.world().sandboxes).find((x) => x.name === 'coder-box')!
  fixture.api.graph.connect(coder, coderBox.id, 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.graph.connect(reviewer, coder, 'depends-on')
  const trigger = manualTrigger(fixture, ['Planner', 'Reviewer', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  let w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(coderTask.status).toBe('waiting')
  expect(coderTask.blockedOn).toContain('waiting on')

  fixture.api.sim.advance(12_500) // planner and reviewer both succeed
  w = fixture.world()
  expect(w.tasks[coderTask.id].status).toBe('running')
})

test('AC4: several tasks on one upstream agent each hold the dependent until all succeed', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const qa = fixture.agent('QA')
  const coder = fixture.agent('Coder')
  const reviewer = fixture.agent('Reviewer')
  isolateSandboxes(fixture)
  fixture.api.agents.update(coder, { concurrency: 1 })
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(qa, sb('sb-docker-1'), 'runs-in')
  fixture.api.sandboxes.create({ name: 'coder-box', kind: 'docker', host: 'docker.internal', image: 'img' })
  fixture.api.sim.advance(6000)
  const coderBox = Object.values(fixture.world().sandboxes).find((x) => x.name === 'coder-box')!
  fixture.api.graph.connect(coder, coderBox.id, 'runs-in')
  fixture.api.graph.connect(reviewer, sb('sb-docker-1'), 'runs-in') // free once QA's run finishes
  fixture.api.graph.connect(planner, coder, 'handoff')
  fixture.api.graph.connect(qa, coder, 'handoff')
  fixture.api.graph.connect(coder, reviewer, 'handoff') // the reviewer task enters the flow via handoff
  fixture.api.graph.connect(coder, reviewer, 'depends-on') // and waits for every coder task in the flow
  const trigger = manualTrigger(fixture, ['Planner', 'QA'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  let w = fixture.world()

  fixture.api.sim.advance(12_500) // planner and qa succeed -> two coder tasks fan out; only one starts
  w = fixture.world()
  const coderTasks = Object.values(w.tasks).filter((t) => t.agentId === coder)
  expect(coderTasks.length).toBe(2)
  const coderFlow = coderTasks[0].flowId
  expect(coderTasks[1].flowId).toBe(coderFlow)
  expect(coderTasks.map((t) => w.tasks[t.id].status).sort()).toEqual(['queued', 'running'])

  fixture.api.sim.advance(12_500) // first coder task succeeds -> reviewer task appears, still held by the second
  w = fixture.world()
  const reviewerTask = Object.values(w.tasks).find((t) => t.agentId === reviewer)!
  const secondCoder = w.tasks[coderTasks[1].id]
  expect(secondCoder.status).toBe('running')
  expect(reviewerTask.status).toBe('waiting')
  expect(reviewerTask.blockedOn).toContain('waiting on')
  expect(reviewerTask.blockedOn).toContain(secondCoder.title)
  expect(reviewerTask.blockedOn).toContain(secondCoder.id)

  fixture.api.sim.advance(12_500) // second coder task succeeds -> reviewer released
  w = fixture.world()
  expect(w.tasks[reviewerTask.id].status).toBe('running')
})

test('AC5: a failed prerequisite cancels the dependent even while other matches are active', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const qa = fixture.agent('QA')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(qa, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-vps-1'), 'runs-in') // running; coder must never lease it
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.graph.connect(qa, coder, 'depends-on')
  fixture.api.agents.update(qa, { timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 1000, backoff: 'fixed' } })
  const trigger = manualTrigger(fixture, ['Planner', 'QA', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  let w = fixture.world()
  const plannerTask = Object.values(w.tasks).find((t) => t.agentId === planner)!
  const qaTask = Object.values(w.tasks).find((t) => t.agentId === qa)!
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(plannerTask.status).toBe('running')
  expect(coderTask.status).toBe('waiting')

  fixture.api.sim.advance(5401) // QA attempt times out and never retries
  w = fixture.world()
  expect(w.tasks[qaTask.id].status).toBe('failed')
  expect(w.tasks[coderTask.id].status).toBe('cancelled')
  expect(w.tasks[coderTask.id].retryAt).toBeNull()
  expect(w.tasks[coderTask.id].blockedOn).toBeNull()
  expect(Object.values(w.runs).some((r) => r.taskId === coderTask.id)).toBe(false)
  const cancels = fixture.events().filter((e) => e.msg.includes('Cancelled') && e.msg.includes(`task ${coderTask.id}, flow`))
  expect(cancels.length).toBe(1)
  expect(cancels[0].msg).toContain(qaTask.title)
  expect(cancels[0].msg).toContain(qaTask.id)
  expect(cancels[0].msg).toContain('failed')
  expect(cancels[0].msg).toContain(coderTask.flowId)
  expect(cancels[0].msg).toContain(coderTask.title)

  fixture.api.sim.advance(12_500) // the planner is not retroactively cancelled
  w = fixture.world()
  expect(w.tasks[plannerTask.id].status).toBe('succeeded')
  expect(fixture.events().filter((e) => e.msg.includes(`task ${coderTask.id}, flow`) && e.msg.includes('Cancelled')).length).toBe(1)
})

test('AC5: a cancelled prerequisite cancels the dependent, and repeated ticks do not repeat the event', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  // no planner sandbox: its task stays cancellable instead of running
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  let w = fixture.world()
  const plannerTask = Object.values(w.tasks).find((t) => t.agentId === planner)!
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(plannerTask.status).toBe('waiting')
  expect(coderTask.status).toBe('waiting')
  expect(coderTask.blockedOn).toContain('waiting on')

  fixture.api.tasks.cancel(plannerTask.id)
  fixture.api.sim.advance(1)
  w = fixture.world()
  expect(w.tasks[coderTask.id].status).toBe('cancelled')
  const cancels = fixture.events().filter((e) => e.msg.includes(`task ${coderTask.id}, flow`) && e.msg.includes('Cancelled'))
  expect(cancels.length).toBe(1)
  expect(cancels[0].msg).toContain(plannerTask.title)
  expect(cancels[0].msg).toContain(plannerTask.id)
  expect(cancels[0].msg).toContain('cancelled')
  expect(cancels[0].msg).toContain(coderTask.flowId)

  fixture.api.sim.advance(1000)
  fixture.api.sim.advance(1000)
  expect(fixture.events().filter((e) => e.msg.includes(`task ${coderTask.id}, flow`) && e.msg.includes('Cancelled')).length).toBe(1)
})

test('AC5: a paused dependent is still cancelled when its prerequisite fails', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.agents.update(planner, { timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 1000, backoff: 'fixed' } })
  fixture.api.agents.setPaused(coder, true)
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  fixture.api.sim.advance(5401)
  let w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(coderTask.status).toBe('cancelled')
})

test('AC6: a retrying prerequisite keeps the dependent waiting, and retry success releases it', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.agents.update(planner, { timeoutMs: 5000, retry: { maxAttempts: 2, backoffMs: 2000, backoff: 'exponential' } })
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  fixture.api.sim.advance(5401) // attempt 1 times out -> planner task enters retry backoff
  let w = fixture.world()
  const plannerTask = Object.values(w.tasks).find((t) => t.agentId === planner)!
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(w.tasks[plannerTask.id].status).toBe('waiting')
  expect(w.tasks[plannerTask.id].retryAt).not.toBeNull()
  expect(w.tasks[coderTask.id].status).toBe('waiting')
  expect(w.tasks[coderTask.id].blockedOn).toContain('waiting on')
  expect(w.tasks[coderTask.id].blockedOn).toContain(plannerTask.title)
  expect(fixture.events().filter((e) => e.msg.includes(coderTask.id) && e.msg.includes('Cancelled'))).toEqual([])

  fixture.api.agents.update(planner, { timeoutMs: 30_000 }) // let attempt 2 finish
  fixture.api.sim.advance(2200) // backoff elapses, attempt 2 starts
  w = fixture.world()
  expect(w.tasks[plannerTask.id].status).toBe('running')
  expect(w.tasks[coderTask.id].status).toBe('waiting')

  fixture.api.sim.advance(12_600) // attempt 2 succeeds -> dependent released
  w = fixture.world()
  expect(w.tasks[plannerTask.id].status).toBe('succeeded')
  expect(w.tasks[coderTask.id].status).toBe('running')
})

test('AC6: exhausted retries cancel the dependent', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.agents.update(planner, { timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 1000, backoff: 'fixed' } })
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  fixture.api.sim.advance(5401)
  let w = fixture.world()
  const plannerTask = Object.values(w.tasks).find((t) => t.agentId === planner)!
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(w.tasks[plannerTask.id].status).toBe('failed')
  expect(w.tasks[coderTask.id].status).toBe('cancelled')
})

test('AC6: chain cancellation reaches every pending link within the following scheduling pass, agents created in reverse order', () => {
  const fixture = makeFixture()
  const agentC = fixture.api.graph.createNode('agent', { x: 960, y: 660 }) as AgentId // created first, so the admission loop would iterate it last
  const agentB = fixture.api.graph.createNode('agent', { x: 640, y: 660 }) as AgentId
  const agentA = fixture.api.graph.createNode('agent', { x: 320, y: 660 }) as AgentId
  fixture.api.graph.connect(agentA, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(agentA, agentB, 'depends-on')
  fixture.api.graph.connect(agentB, agentC, 'depends-on')
  const trigger = manualTrigger(fixture, [fixture.world().agents[agentA].name, fixture.world().agents[agentB].name, fixture.world().agents[agentC].name])
  fixture.api.agents.update(agentA, { timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 1000, backoff: 'fixed' } })

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  let w = fixture.world()
  const taskA = Object.values(w.tasks).find((t) => t.agentId === agentA)!
  const taskB = Object.values(w.tasks).find((t) => t.agentId === agentB)!
  const taskC = Object.values(w.tasks).find((t) => t.agentId === agentC)!
  expect(taskA.status).toBe('running')
  expect(taskB.status).toBe('waiting')

  fixture.api.sim.advance(5401) // A fails terminally; B cancels this pass, C by the following one at the latest
  fixture.api.sim.advance(400)
  w = fixture.world()
  expect(w.tasks[taskA.id].status).toBe('failed')
  expect(w.tasks[taskB.id].status).toBe('cancelled')
  expect(w.tasks[taskC.id].status).toBe('cancelled')
  expect(fixture.events().filter((e) => e.msg.includes(`task ${taskB.id}, flow`) && e.msg.includes('Cancelled')).length).toBe(1)
  expect(fixture.events().filter((e) => e.msg.includes(`task ${taskC.id}, flow`) && e.msg.includes('Cancelled')).length).toBe(1)
})

test('AC9: a paused agent keeps eligible work waiting, then starts when resumed', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  let w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(coderTask.status).toBe('waiting')
  fixture.api.agents.setPaused(coder, true)

  waitUntil(fixture, () => fixture.firstTask(planner).status === 'succeeded', 'planner succeeds')
  w = fixture.world()
  expect(w.tasks[coderTask.id].status).toBe('waiting')
  expect(Object.values(w.runs).some((r) => r.taskId === coderTask.id)).toBe(false)

  fixture.api.agents.setPaused(coder, false)
  waitUntil(fixture, () => fixture.world().tasks[coderTask.id].status === 'running', 'coder starts after resume')
})

test('AC9: exhausted concurrency still prevents a start after dependencies pass', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.agents.update(coder, { concurrency: 1 })
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1) // planner run starts; coder task waits on it
  fixture.api.sim.advance(6000) // put distance between the two coder completions
  const manualCoder = fixture.api.agents.enqueue(coder, { title: 'Solo patch', prompt: 'sp', priority: 'normal' })
  fixture.api.sim.advance(1) // manual coder run takes the only coder slot
  let w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder && t.origin.kind === 'trigger')!
  expect(Object.values(w.runs).filter((r) => r.status === 'running').length).toBe(2)

  waitUntil(fixture, () => fixture.firstTask(planner).status === 'succeeded', 'planner succeeds')
  w = fixture.world()
  expect(w.tasks[coderTask.id].status).toBe('waiting')
  expect(Object.values(w.runs).some((r) => r.taskId === coderTask.id)).toBe(false)

  waitUntil(fixture, () => fixture.world().tasks[coderTask.id].status === 'running', 'coder starts when capacity frees')
  expect(fixture.task(manualCoder).status).toBe('succeeded')
})

test('AC9: retry backoff still gates a start after dependencies pass', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.agents.update(coder, { timeoutMs: 5000, retry: { maxAttempts: 2, backoffMs: 2000, backoff: 'exponential' } })
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1) // planner starts; coder waits
  fixture.api.sim.advance(12_500) // planner succeeds; coder starts
  fixture.api.sim.advance(5401) // coder attempt 1 times out -> retry backoff
  let w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(w.tasks[coderTask.id].status).toBe('waiting')
  expect(w.tasks[coderTask.id].retryAt).not.toBeNull()

  fixture.api.sim.advance(1)
  w = fixture.world()
  expect(w.tasks[coderTask.id].status).toBe('waiting')
  expect(w.tasks[coderTask.id].retryAt).not.toBeNull()

  waitUntil(fixture, () => fixture.world().tasks[coderTask.id].retryAt === null && fixture.world().tasks[coderTask.id].status === 'running', 'attempt 2 starts after backoff')
})

test('AC9: an unavailable sandbox holds the dependent with a reason, then releases it', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const reviewer = fixture.agent('Reviewer')
  isolateSandboxes(fixture)
  fixture.api.sandboxes.update(sb('sb-docker-1'), { capacity: 1 }) // Reviewer's single lease fills builder-a
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1) // planner run starts on mac-studio; coder waits on it
  fixture.api.sim.advance(6000)
  fixture.api.agents.enqueue(reviewer, { title: 'Audit logs', prompt: 'al', priority: 'normal' })
  fixture.api.graph.connect(reviewer, sb('sb-docker-1'), 'runs-in')
  fixture.api.sim.advance(1) // reviewer run leases builder-a

  waitUntil(fixture, () => fixture.firstTask(planner).status === 'succeeded', 'planner succeeds')
  let w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder)!
  expect(w.tasks[coderTask.id].status).toBe('waiting')
  expect(w.tasks[coderTask.id].blockedOn).toBe('no free sandbox')
  const reviewerRun = Object.values(w.runs).find((r) => r.agentId === reviewer && r.status === 'running')
  expect(reviewerRun).toBeDefined()

  waitUntil(fixture, () => fixture.world().tasks[coderTask.id].status === 'running', 'coder starts once the sandbox frees')
})

test('AC7: removing the depends-on edge clears a stale waiting-on reason while other constraints hold', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  isolateSandboxes(fixture)
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.agents.update(coder, { concurrency: 1 })

  // occupy the coder's only slot with a manual task so capacity stays full
  const manual = fixture.api.agents.enqueue(coder, { title: 'Solo patch', prompt: 'sp', priority: 'normal' })
  fixture.api.sim.advance(1)
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])
  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  let w = fixture.world()
  const coderTask = Object.values(w.tasks).find((t) => t.agentId === coder && t.origin.kind === 'trigger')!
  expect(coderTask.status).toBe('waiting')
  expect(coderTask.blockedOn).toContain('waiting on')

  fixture.api.graph.removeEdges(Object.values(w.edges).filter((e) => e.kind === 'depends-on').map((e) => e.id))
  fixture.api.sim.advance(1)
  w = fixture.world()
  expect(w.tasks[coderTask.id].status).toBe('waiting') // capacity still full
  expect(w.tasks[coderTask.id].blockedOn).toBeNull() // stale reason cleared

  waitUntil(fixture, () => fixture.task(manual).status === 'succeeded', 'manual task finishes')
  waitUntil(fixture, () => fixture.world().tasks[coderTask.id].status === 'running', 'task starts once capacity frees')
})

test('advance rejects invalid simulated-time increments', () => {
  const fixture = makeFixture()
  const before = fixture.world().now
  expect(() => fixture.api.sim.advance(Number.NaN)).toThrow(RangeError)
  expect(() => fixture.api.sim.advance(-1)).toThrow(RangeError)
  expect(() => fixture.api.sim.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  expect(fixture.world().now).toBe(before)
})
