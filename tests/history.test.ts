/**
 * Undo and redo of graph edits, exercised through `createHistory` bound to a
 * fixture's API and world getter. Every assertion reads world state or the
 * history's public `canUndo`/`canRedo`; entries are never inspected. The
 * `restoreNodes` and `restoreEdges` primitives are also covered directly
 * through `src/api/client.ts`.
 */
import { expect, test } from 'vitest'
import { createHistory } from '../src/history'
import type { AgentId, Edge, EdgeId, SandboxId } from '../src/domain/types'
import { makeFixture, sb, type Fixture } from './fixture'

function setup() {
  const fixture = makeFixture()
  return { fixture, history: createHistory(fixture.api, fixture.world) }
}

function edge(fixture: Fixture, match: (e: Edge) => boolean): Edge {
  const found = Object.values(fixture.world().edges).find(match)
  if (!found) throw new Error('no matching edge')
  return found
}

test('a spawned node undoes away and redoes back under its original id', () => {
  const { fixture, history } = setup()
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(false)

  const id = history.createNode('agent', { x: 80, y: 90 }) as AgentId
  const created = fixture.world().agents[id]
  expect(history.canUndo()).toBe(true)

  history.undo()
  expect(fixture.world().agents).not.toHaveProperty(id)
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(true)

  history.redo()
  expect(fixture.world().agents[id]).toMatchObject({ id, name: created.name, position: { x: 80, y: 90 } })
  expect(history.canUndo()).toBe(true)
  expect(history.canRedo()).toBe(false)
})

test('a deleted node round trips through undo and redo under its original id', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const before = fixture.world().agents[planner]
  const edgeIds = Object.values(fixture.world().edges).filter((e) => e.source === planner || e.target === planner).map((e) => e.id)

  history.delete({ nodeIds: [planner], edgeIds: [] })
  history.undo()
  history.redo()
  expect(fixture.world().agents).not.toHaveProperty(planner)
  for (const id of edgeIds) expect(fixture.world().edges).not.toHaveProperty(id)
  expect(history.canRedo()).toBe(false)

  history.undo()
  expect(fixture.world().agents[planner]).toEqual(before)
  for (const id of edgeIds) expect(fixture.world().edges).toHaveProperty(id)
  expect(history.canUndo()).toBe(false)
})

test('a connect undoes away and redoes back under its original edge id', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')

  const result = history.connect(planner, coder, 'depends-on')
  if (!result.ok) throw new Error(result.reason)
  const id = result.id
  const created = fixture.world().edges[id]

  history.undo()
  expect(fixture.world().edges).not.toHaveProperty(id)
  history.redo()
  expect(fixture.world().edges[id]).toEqual(created)
  expect(created).toEqual({ id, kind: 'depends-on', source: planner, target: coder })
})

test('an inspector edge delete undoes back under its original id and redoes away', () => {
  const { fixture, history } = setup()
  const removed = Object.values(fixture.world().edges)[0]

  history.removeEdges([removed.id])
  expect(fixture.world().edges).not.toHaveProperty(removed.id)
  history.undo()
  expect(fixture.world().edges[removed.id]).toEqual(removed)
  history.redo()
  expect(fixture.world().edges).not.toHaveProperty(removed.id)
})

test('an edge kind change undoes and redoes', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const result = fixture.api.graph.connect(planner, coder, 'handoff')
  if (!result.ok) throw new Error(result.reason)

  history.setEdgeKind(result.id, 'depends-on')
  expect(fixture.world().edges[result.id].kind).toBe('depends-on')
  history.undo()
  expect(fixture.world().edges[result.id].kind).toBe('handoff')
  history.redo()
  expect(fixture.world().edges[result.id].kind).toBe('depends-on')
})

test('a multi-node move is one undo step that restores every prior position', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const trigger = Object.values(fixture.world().triggers)[0].id
  const node = sb('sb-local-1')
  const w = fixture.world()
  const before = [w.agents[planner].position, w.triggers[trigger].position, w.sandboxes[node].position]

  history.move([
    { id: planner, position: { x: 1, y: 2 } },
    { id: trigger, position: { x: 3, y: 4 } },
    { id: node, position: { x: 5, y: 6 } },
  ])
  history.undo()
  const undone = fixture.world()
  expect([undone.agents[planner].position, undone.triggers[trigger].position, undone.sandboxes[node].position]).toEqual(before)
  expect(history.canUndo()).toBe(false)

  history.redo()
  const redone = fixture.world()
  expect([redone.agents[planner].position, redone.triggers[trigger].position, redone.sandboxes[node].position])
    .toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }])
})

test('undo of a working agent delete restores it idle with its edges while its run and tasks keep the delete outcome', () => {
  const { fixture, history } = setup()
  const coder = fixture.agent('Coder')
  fixture.api.agents.update(coder, { concurrency: 1 })
  const running = fixture.api.agents.enqueue(coder, { title: 'one', prompt: 'p', priority: 'normal' })
  const queued = fixture.api.agents.enqueue(coder, { title: 'two', prompt: 'p', priority: 'normal' })
  fixture.api.sim.advance(1)
  const run = Object.values(fixture.runs()).find((r) => r.taskId === running)!
  expect(run.status).toBe('running')
  expect(fixture.task(queued).status).toBe('queued')
  const before = fixture.world().agents[coder]
  expect(before.status).toBe('working')
  const edgeIds = Object.values(fixture.world().edges).filter((e) => e.source === coder || e.target === coder).map((e) => e.id)
  expect(edgeIds.length).toBeGreaterThan(0)

  history.delete({ nodeIds: [coder], edgeIds: [] })
  expect(fixture.world().agents).not.toHaveProperty(coder)

  history.undo()
  const w = fixture.world()
  expect(w.agents[coder]).toEqual({ ...before, status: 'idle' })
  for (const id of edgeIds) expect(w.edges).toHaveProperty(id)
  expect(w.runs[run.id]).toMatchObject({ status: 'failed', error: 'agent deleted' })
  expect(fixture.task(running).status).toBe('failed')
  expect(fixture.task(queued).status).toBe('cancelled')
  expect(w.agents[coder].failed).toBe(before.failed)
  expect(w.events.at(-1)).toMatchObject({ kind: 'graph', subject: { kind: 'agent', id: coder }, msg: 'Restored Coder' })
})

test('undo of a sandbox delete restores it with no leases, empty history, stateSince now and its captured state', () => {
  const { fixture, history } = setup()
  const coder = fixture.agent('Coder')
  fixture.api.agents.enqueue(coder, { title: 'one', prompt: 'p', priority: 'normal' })
  fixture.api.sim.advance(1)
  const id = sb('sb-local-1')
  const before = fixture.world().sandboxes[id]
  expect(before.leases).toHaveLength(1)
  expect(before.history.length).toBeGreaterThan(0)

  history.delete({ nodeIds: [id], edgeIds: [] })
  fixture.api.sim.advance(500)
  history.undo()
  const w = fixture.world()
  expect(w.sandboxes[id]).toEqual({ ...before, leases: [], history: [], stateSince: w.now })
  expect(w.sandboxes[id].stateSince).not.toBe(before.stateSince)
  expect(w.sandboxes[id]).toMatchObject({ state: before.state, progress: before.progress })
  expect(Object.values(w.edges).filter((e) => e.target === id)).toHaveLength(2)
})

test('undo of a trigger delete restores it with lastFiredAt null and its captured fired count', () => {
  const { fixture, history } = setup()
  const trigger = Object.values(fixture.world().triggers)[0]
  fixture.api.triggers.fire(trigger.id)
  fixture.api.triggers.fire(trigger.id)
  const before = fixture.world().triggers[trigger.id]
  expect(before.fired).toBe(2)
  expect(before.lastFiredAt).not.toBeNull()

  history.delete({ nodeIds: [trigger.id], edgeIds: [] })
  history.undo()
  expect(fixture.world().triggers[trigger.id]).toEqual({ ...before, lastFiredAt: null })
  expect(Object.values(fixture.world().edges).some((e) => e.source === trigger.id)).toBe(true)
})

test('undo of a paused agent delete restores it still paused', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  fixture.api.agents.setPaused(planner, true)

  history.delete({ nodeIds: [planner], edgeIds: [] })
  history.undo()
  expect(fixture.world().agents[planner].status).toBe('paused')
})

test('a node delete with a separately selected edge is one undo step', () => {
  const { fixture, history } = setup()
  const created = history.createNode('trigger', { x: 0, y: 0 })
  const reviewer = fixture.agent('Reviewer')
  const attached = Object.values(fixture.world().edges).filter((e) => e.source === reviewer || e.target === reviewer).map((e) => e.id)
  const standalone = edge(fixture, (e) => e.source === fixture.agent('Planner') && e.kind === 'runs-in').id
  expect(attached.length).toBeGreaterThan(1)

  // React Flow also passes the attached edges it removes alongside the node
  history.delete({ nodeIds: [reviewer], edgeIds: [attached[0], standalone] })
  expect(fixture.world().agents).not.toHaveProperty(reviewer)
  expect(fixture.world().edges).not.toHaveProperty(standalone)

  history.undo()
  expect(fixture.world().agents).toHaveProperty(reviewer)
  for (const id of [...attached, standalone]) expect(fixture.world().edges).toHaveProperty(id)
  expect(fixture.world().triggers).toHaveProperty(created)

  history.undo()
  expect(fixture.world().triggers).not.toHaveProperty(created)
  expect(history.canUndo()).toBe(false)
})

test('an edge-only delete removes the edges without a node delete event', () => {
  const { fixture, history } = setup()
  const id = Object.values(fixture.world().edges)[0].id
  const deletions = () => fixture.events().filter((e) => e.msg.startsWith('Deleted')).length

  history.delete({ nodeIds: [], edgeIds: [id] })
  expect(fixture.world().edges).not.toHaveProperty(id)
  history.undo()
  expect(fixture.world().edges).toHaveProperty(id)
  history.redo()
  expect(fixture.world().edges).not.toHaveProperty(id)
  expect(deletions()).toBe(0)
})

test('undo of a spawn whose node is already gone logs no delete and still moves the cursor', () => {
  const { fixture, history } = setup()
  const id = history.createNode('sandbox', { x: 0, y: 0 }) as SandboxId
  fixture.api.sandboxes.act(id, 'destroy')
  fixture.api.sim.advance(1500)
  expect(fixture.world().sandboxes).not.toHaveProperty(id)
  const deletions = () => fixture.events().filter((e) => e.msg.startsWith('Deleted')).length

  history.undo()
  expect(deletions()).toBe(0)
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(true)

  history.redo()
  expect(fixture.world().sandboxes).toHaveProperty(id)
})

test('three name keystrokes on one agent are one undo step', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')

  for (const name of ['Planner1', 'Planner12', 'Planner123']) history.updateAgent(planner, { name })
  expect(fixture.world().agents[planner].name).toBe('Planner123')

  history.undo()
  expect(fixture.world().agents[planner].name).toBe('Planner')
  expect(history.canUndo()).toBe(false)
  history.redo()
  expect(fixture.world().agents[planner].name).toBe('Planner123')
})

test('retry Attempts then Backoff edits coalesce under the retry key', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const original = fixture.world().agents[planner].retry

  history.updateAgent(planner, { retry: { ...original, maxAttempts: 5 } })
  history.updateAgent(planner, { retry: { ...fixture.world().agents[planner].retry, backoffMs: 9000 } })
  expect(fixture.world().agents[planner].retry).toEqual({ ...original, maxAttempts: 5, backoffMs: 9000 })

  history.undo()
  expect(fixture.world().agents[planner].retry).toEqual(original)
  expect(history.canUndo()).toBe(false)
})

test('a name edit then a role edit are two undo steps', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')

  history.updateAgent(planner, { name: 'Lead' })
  history.updateAgent(planner, { role: 'architect' })
  history.undo()
  expect(fixture.world().agents[planner]).toMatchObject({ name: 'Lead', role: 'tech lead' })
  history.undo()
  expect(fixture.world().agents[planner]).toMatchObject({ name: 'Planner', role: 'tech lead' })
  expect(history.canUndo()).toBe(false)
})

test('the same key on a different node is a separate undo step', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')

  history.updateAgent(planner, { name: 'Lead' })
  history.updateAgent(coder, { name: 'Builder' })
  history.undo()
  expect(fixture.world().agents[planner].name).toBe('Lead')
  expect(fixture.world().agents[coder].name).toBe('Coder')
  history.undo()
  expect(fixture.world().agents[planner].name).toBe('Planner')
})

test('typing a character and deleting it again leaves nothing to undo', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const created = history.createNode('agent', { x: 0, y: 0 })

  history.updateAgent(planner, { name: 'Planner1' })
  history.updateAgent(planner, { name: 'Planner' })
  history.undo()
  expect(fixture.world().agents).not.toHaveProperty(created)
  expect(history.canUndo()).toBe(false)
})

test('an edit after a dropped entry starts a new undo step instead of extending the entry below', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const role = fixture.world().agents[planner].role

  history.updateAgent(planner, { name: 'Lead' })
  history.updateAgent(planner, { role: 'architect' })
  history.updateAgent(planner, { role })
  history.updateAgent(planner, { name: 'Lead2' })
  history.undo()
  expect(fixture.world().agents[planner].name).toBe('Lead')
})

test('an undo or redo between same-key edits starts a new undo step', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')

  history.updateAgent(planner, { name: 'Lead' })
  history.updateAgent(coder, { name: 'Builder' })
  history.undo()
  history.updateAgent(planner, { name: 'Lead1' })
  history.undo()
  expect(fixture.world().agents[planner].name).toBe('Lead')

  history.undo()
  history.redo()
  history.updateAgent(planner, { name: 'Lead2' })
  history.undo()
  expect(fixture.world().agents[planner].name).toBe('Lead')
})

test('a multi-key patch is one undo step that reverts every key', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')

  history.updateAgent(planner, { name: 'Lead', role: 'architect' })
  history.updateAgent(planner, { role: 'architect', name: 'Lead2' })
  history.undo()
  expect(fixture.world().agents[planner]).toMatchObject({ name: 'Planner', role: 'tech lead' })
  expect(history.canUndo()).toBe(false)
})

test('trigger and sandbox patches undo and redo', () => {
  const { fixture, history } = setup()
  const trigger = Object.values(fixture.world().triggers)[0]
  const box = fixture.world().sandboxes[sb('sb-docker-1')]

  history.updateTrigger(trigger.id, { enabled: true })
  history.updateSandbox(box.id, { capacity: 3 })
  history.undo()
  expect(fixture.world().sandboxes[box.id].capacity).toBe(box.capacity)
  history.undo()
  expect(fixture.world().triggers[trigger.id].enabled).toBe(false)
  history.redo()
  history.redo()
  expect(fixture.world().triggers[trigger.id].enabled).toBe(true)
  expect(fixture.world().sandboxes[box.id].capacity).toBe(3)
})

test('rejected and no-op writes leave nothing to undo', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const runsIn = edge(fixture, (e) => e.source === coder && e.kind === 'runs-in')
  const handoff = fixture.api.graph.connect(planner, coder, 'handoff')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  if (!handoff.ok) throw new Error(handoff.reason)

  expect(history.connect(sb('sb-local-1'), planner, null).ok).toBe(false)
  expect(history.connect(runsIn.source, runsIn.target, 'runs-in').ok).toBe(false)
  history.setEdgeKind(handoff.id, 'depends-on')
  history.setEdgeKind(handoff.id, 'handoff')
  history.setEdgeKind(runsIn.id, 'handoff')
  history.updateSandbox(sb('sb-docker-1'), { capacity: 0 })
  history.updateSandbox(sb('sb-docker-1'), { capacity: fixture.world().sandboxes[sb('sb-docker-1')].capacity })
  history.updateAgent(planner, { name: 'Planner' })
  history.removeEdges(['ed-missing' as EdgeId])
  history.delete({ nodeIds: ['ag-missing' as AgentId], edgeIds: [] })
  history.move([{ id: planner, position: fixture.world().agents[planner].position }])

  expect(fixture.world().edges[handoff.id].kind).toBe('handoff')
  expect(history.canUndo()).toBe(false)
})

test('the stack keeps the newest 100 edits and the first of 101 is no longer undoable', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  for (let x = 1; x <= 101; x += 1) history.move([{ id: planner, position: { x, y: 0 } }])

  for (let i = 0; i < 100; i += 1) history.undo()
  expect(history.canUndo()).toBe(false)
  expect(fixture.world().agents[planner].position).toEqual({ x: 1, y: 0 })
  history.undo()
  expect(fixture.world().agents[planner].position).toEqual({ x: 1, y: 0 })
})

test('a new edit after an undo discards the redo entries', () => {
  const { fixture, history } = setup()
  const first = history.createNode('agent', { x: 0, y: 0 })
  history.undo()
  const second = history.createNode('trigger', { x: 0, y: 0 })
  expect(history.canRedo()).toBe(false)

  history.redo()
  expect(fixture.world().agents).not.toHaveProperty(first)
  history.undo()
  expect(fixture.world().triggers).not.toHaveProperty(second)
  expect(history.canUndo()).toBe(false)
})

test('reset reseeds the world and empties the stack', () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const created = history.createNode('agent', { x: 0, y: 0 })
  history.updateAgent(planner, { name: 'Lead' })
  history.undo()

  history.reset()
  expect(fixture.world().agents).not.toHaveProperty(created)
  expect(fixture.world().agents[planner].name).toBe('Planner')
  expect(fixture.world().edges).toHaveProperty('ed-2')
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(false)
})

test('subscribers hear every stack change until they unsubscribe, with methods usable detached', () => {
  const { fixture, history } = setup()
  const { subscribe, canUndo, canRedo } = history
  const seen: Array<[boolean, boolean]> = []
  const unsubscribe = subscribe(() => { seen.push([canUndo(), canRedo()]) })

  history.createNode('agent', { x: 0, y: 0 })
  history.undo()
  history.redo()
  history.reset()
  expect(seen).toEqual([[true, false], [false, true], [true, false], [false, false]])

  unsubscribe()
  history.updateAgent(fixture.agent('Planner'), { name: 'Lead' })
  expect(seen).toHaveLength(4)
})

test('restoreEdges skips missing endpoints, invalid kinds, duplicates and ids already present', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const existing = edge(fixture, (e) => e.source === coder && e.target === sb('sb-local-1'))
  const ed = (id: string) => id as EdgeId
  const before = fixture.world().edges

  fixture.api.graph.restoreEdges([
    { id: ed('ed-missing'), kind: 'runs-in', source: 'ag-gone' as AgentId, target: sb('sb-local-1') },
    { id: ed('ed-invalid'), kind: 'handoff', source: coder, target: sb('sb-local-1') },
    { id: ed('ed-duplicate'), kind: existing.kind, source: existing.source, target: existing.target },
    { ...existing, target: sb('sb-vps-1') },
  ])
  expect(fixture.world().edges).toEqual(before)

  fixture.api.graph.restoreEdges([
    { id: ed('ed-first'), kind: 'depends-on', source: planner, target: coder },
    { id: ed('ed-second'), kind: 'depends-on', source: planner, target: coder },
  ])
  expect(fixture.world().edges).toHaveProperty('ed-first')
  expect(fixture.world().edges).not.toHaveProperty('ed-second')
})

test('restoreNodes skips an id that already exists and logs nothing for it', () => {
  const fixture = makeFixture()
  const planner = fixture.world().agents[fixture.agent('Planner')]
  const events = fixture.events().length

  fixture.api.graph.restoreNodes([{ kind: 'agent', node: { ...planner, name: 'Impostor' } }])
  expect(fixture.world().agents[planner.id]).toEqual(planner)
  expect(fixture.events()).toHaveLength(events)
})
