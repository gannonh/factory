/**
 * Task event subjects and Events-tab selection, exercised through the public
 * API surface in `src/api/client.ts` plus the pure subject lookup in
 * `src/domain/types.ts` that `EventsTab.open` uses. The fixture is a
 * manual-mode MockServer with an injected rng (0.5): every run lasts 12.5s of
 * simulated time and succeeds. There is no DOM harness, so the Events-tab
 * click decision is verified through `existingSubject` instead of rendering.
 */
import { expect, test } from 'vitest'
import { existingSubject, type AgentId, type EdgeId, type GroupId, type NodeId, type NodeKind, type RunId, type SandboxId, type Subject, type TaskId, type TriggerId } from '../src/domain/types'
import { makeFixture, sb, type Fixture } from './fixture'

/** Manual trigger wired to the given agents, for counted firings. */
function manualTrigger(fixture: Fixture, targets: string[]): TriggerId {
  const id = fixture.api.graph.createNode('trigger', { x: 40, y: 400 }) as TriggerId
  for (const name of targets) fixture.api.graph.connect(id, fixture.agent(name), 'triggers')
  return id
}

/** The newest task event whose message starts with `prefix`. */
function lastTaskEvent(fixture: Fixture, prefix: string) {
  const events = fixture.events().filter((e) => e.kind === 'task' && e.msg.startsWith(prefix))
  const event = events[events.length - 1]
  if (!event) throw new Error(`no task event starting with ${prefix}`)
  return event
}

function lastDeletedEvent(fixture: Fixture) {
  const event = [...fixture.events()].reverse().find((e) => e.kind === 'graph' && e.msg.startsWith('Deleted '))
  if (!event) throw new Error('no deleted graph event')
  return event
}

test('a manual enqueue emits its queued event with the new task as subject', () => {
  const fixture = makeFixture()
  const id = fixture.api.agents.enqueue(fixture.agent('Planner'), { title: 'Plan one', prompt: 'p1', priority: 'normal' })
  expect(lastTaskEvent(fixture, 'Queued').subject).toEqual({ kind: 'task', id })
})

test('cancelling a queued task emits its cancelled event with that task as subject', () => {
  const fixture = makeFixture()
  const id = fixture.api.agents.enqueue(fixture.agent('Planner'), { title: 'Plan one', prompt: 'p1', priority: 'normal' })
  fixture.api.tasks.cancel(id)
  expect(lastTaskEvent(fixture, 'Cancelled').subject).toEqual({ kind: 'task', id })
})

test('a trigger firing emits its queued event with the new task as subject', () => {
  const fixture = makeFixture()
  const coder = fixture.agent('Coder')
  const trigger = manualTrigger(fixture, ['Coder'])
  fixture.api.triggers.fire(trigger)
  const task = Object.values(fixture.world().tasks).find((t) => t.agentId === coder)!
  expect(lastTaskEvent(fixture, 'Queued').subject).toEqual({ kind: 'task', id: task.id })
})

test('a cancelled event subject selects its task, which still shows status cancelled', () => {
  const fixture = makeFixture()
  const id = fixture.api.agents.enqueue(fixture.agent('Planner'), { title: 'Plan one', prompt: 'p1', priority: 'normal' })
  fixture.api.tasks.cancel(id)
  const subject = lastTaskEvent(fixture, 'Cancelled').subject
  expect(existingSubject(fixture.world(), subject)).toEqual({ kind: 'task', id })
  expect(fixture.task(id).status).toBe('cancelled')
})

test('a delete event subject keeps the deleted node kind for every node type', () => {
  const fixture = makeFixture()
  const deleted: Array<{ kind: NodeKind; id: NodeId }> = [
    { kind: 'agent', id: fixture.agent('Planner') },
    { kind: 'sandbox', id: sb('sb-local-1') },
    { kind: 'trigger', id: Object.values(fixture.world().triggers)[0].id },
  ]

  for (const { kind, id } of deleted) {
    fixture.api.graph.deleteNodes([id])
    expect(lastDeletedEvent(fixture).subject).toEqual({ kind, id })
  }
})

test('a multi-node delete event uses the first node kind', () => {
  const fixture = makeFixture()
  const sandbox = sb('sb-local-1')
  const trigger = Object.values(fixture.world().triggers)[0].id

  fixture.api.graph.deleteNodes([sandbox, trigger])

  expect(lastDeletedEvent(fixture).subject).toEqual({ kind: 'sandbox', id: sandbox })
})

test('existingSubject resolves every kind only while its record exists and never throws', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const taskId = fixture.api.agents.enqueue(planner, { title: 'Plan one', prompt: 'p1', priority: 'normal' })
  fixture.api.sim.advance(1) // the Planner run starts
  const w = fixture.world()
  const present: Subject[] = [
    { kind: 'agent', id: planner },
    { kind: 'sandbox', id: sb('sb-local-1') },
    { kind: 'trigger', id: Object.values(w.triggers)[0].id },
    { kind: 'run', id: Object.values(w.runs)[0].id },
    { kind: 'task', id: taskId },
    { kind: 'edge', id: Object.values(w.edges)[0].id },
  ]
  for (const subject of present) expect(existingSubject(w, subject)).toEqual(subject)

  const grouped = fixture.api.graph.group([planner, fixture.agent('Coder')])
  if (grouped === null) throw new Error('expected a group')
  expect(existingSubject(fixture.world(), { kind: 'group', id: grouped })).toEqual({ kind: 'group', id: grouped })

  const absent: Subject[] = [
    { kind: 'agent', id: 'missing' as AgentId },
    { kind: 'sandbox', id: 'missing' as SandboxId },
    { kind: 'trigger', id: 'missing' as TriggerId },
    { kind: 'run', id: 'missing' as RunId },
    { kind: 'task', id: 'missing' as TaskId },
    { kind: 'edge', id: 'missing' as EdgeId },
    { kind: 'group', id: 'missing' as GroupId },
  ]
  for (const subject of absent) expect(existingSubject(w, subject)).toBeNull()
})

test('a queued event subject selects its live task and nothing once the task is gone', () => {
  const fixture = makeFixture()
  const id = fixture.api.agents.enqueue(fixture.agent('Planner'), { title: 'Plan one', prompt: 'p1', priority: 'normal' })
  const subject = lastTaskEvent(fixture, 'Queued').subject
  expect(existingSubject(fixture.world(), subject)).toEqual({ kind: 'task', id })

  fixture.api.sim.reset()
  expect(existingSubject(fixture.world(), subject)).toBeNull()
})

test('a handoff emits its queued event with the new handoff task as subject', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  fixture.api.graph.connect(planner, coder, 'handoff')
  const trigger = manualTrigger(fixture, ['Planner'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1) // Planner run starts
  fixture.api.sim.advance(12_500) // Planner succeeds and hands off to Coder

  const handoff = Object.values(fixture.world().tasks).find((t) => t.origin.kind === 'handoff' && t.origin.from === planner)!
  expect(lastTaskEvent(fixture, 'Queued').subject).toEqual({ kind: 'task', id: handoff.id })
})

test('a failed prerequisite puts the dependent task in the cancelled event subject', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  fixture.api.graph.removeEdges(Object.values(fixture.world().edges).filter((e) => e.kind === 'runs-in').map((e) => e.id))
  fixture.api.graph.connect(planner, sb('sb-local-1'), 'runs-in')
  fixture.api.graph.connect(coder, sb('sb-docker-1'), 'runs-in')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  fixture.api.agents.update(planner, { timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 1000, backoff: 'fixed' } })
  const trigger = manualTrigger(fixture, ['Planner', 'Coder'])

  fixture.api.triggers.fire(trigger)
  fixture.api.sim.advance(1)
  const coderTask = Object.values(fixture.world().tasks).find((t) => t.agentId === coder)!
  fixture.api.sim.advance(5401) // planner times out for good; the dependency cancels the coder task

  const cancelled = fixture.events().find((e) => e.kind === 'task' && e.msg.startsWith('Cancelled') && e.msg.includes(`task ${coderTask.id}, flow`))
  expect(cancelled?.subject).toEqual({ kind: 'task', id: coderTask.id })
})
