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

test('a spawned node undoes away and redoes back under its original id', async () => {
  const { fixture, history } = setup()
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(false)

  const id = await history.createNode('agent', { x: 80, y: 90 }) as AgentId
  const created = fixture.world().agents[id]
  expect(history.canUndo()).toBe(true)

  await history.undo()
  expect(fixture.world().agents).not.toHaveProperty(id)
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(true)

  await history.redo()
  expect(fixture.world().agents[id]).toMatchObject({ id, name: created.name, position: { x: 80, y: 90 } })
  expect(history.canUndo()).toBe(true)
  expect(history.canRedo()).toBe(false)
})

test('a failed undo keeps the entry undoable', async () => {
  const fixture = makeFixture()
  let offline = false
  const graph = {
    ...fixture.api.graph,
    deleteNodes: (ids: Parameters<typeof fixture.api.graph.deleteNodes>[0]) =>
      offline ? Promise.reject(new Error('disconnected from server')) : fixture.api.graph.deleteNodes(ids),
  }
  const history = createHistory({ ...fixture.api, graph }, fixture.world)
  const id = await history.createNode('agent', { x: 80, y: 90 }) as AgentId

  offline = true
  await expect(history.undo()).rejects.toThrow('disconnected from server')
  expect(fixture.world().agents).toHaveProperty(id)
  expect(history.canUndo()).toBe(true)
  expect(history.canRedo()).toBe(false)

  offline = false
  await history.undo()
  expect(fixture.world().agents).not.toHaveProperty(id)
  expect(history.canRedo()).toBe(true)
})

test('a delete whose edge removal fails still undoes the deleted node', async () => {
  const fixture = makeFixture()
  const graph = { ...fixture.api.graph, removeEdges: () => Promise.reject(new Error('disconnected from server')) }
  const history = createHistory({ ...fixture.api, graph }, fixture.world)
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const loose = await fixture.api.graph.connect(coder, fixture.agent('Reviewer'), 'handoff')
  if (!loose.ok) throw new Error(loose.reason)

  await expect(history.delete({ nodeIds: [planner], edgeIds: [loose.id] })).rejects.toThrow('disconnected from server')
  expect(fixture.world().agents).not.toHaveProperty(planner)
  expect(history.canUndo()).toBe(true)

  await history.undo()
  expect(fixture.world().agents).toHaveProperty(planner)
})

test('a deleted node round trips through undo and redo under its original id', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const before = fixture.world().agents[planner]
  const edgeIds = Object.values(fixture.world().edges).filter((e) => e.source === planner || e.target === planner).map((e) => e.id)

  await history.delete({ nodeIds: [planner], edgeIds: [] })
  await history.undo()
  await history.redo()
  expect(fixture.world().agents).not.toHaveProperty(planner)
  for (const id of edgeIds) expect(fixture.world().edges).not.toHaveProperty(id)
  expect(history.canRedo()).toBe(false)

  await history.undo()
  expect(fixture.world().agents[planner]).toEqual(before)
  for (const id of edgeIds) expect(fixture.world().edges).toHaveProperty(id)
  expect(history.canUndo()).toBe(false)
})

test('a connect undoes away and redoes back under its original edge id', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')

  const result = await history.connect(planner, coder, 'depends-on')
  if (!result.ok) throw new Error(result.reason)
  const id = result.id
  const created = fixture.world().edges[id]

  await history.undo()
  expect(fixture.world().edges).not.toHaveProperty(id)
  await history.redo()
  expect(fixture.world().edges[id]).toEqual(created)
  expect(created).toEqual({ id, kind: 'depends-on', source: planner, target: coder })
})

test('an inspector edge delete undoes back under its original id and redoes away', async () => {
  const { fixture, history } = setup()
  const removed = Object.values(fixture.world().edges)[0]

  await history.removeEdges([removed.id])
  expect(fixture.world().edges).not.toHaveProperty(removed.id)
  await history.undo()
  expect(fixture.world().edges[removed.id]).toEqual(removed)
  await history.redo()
  expect(fixture.world().edges).not.toHaveProperty(removed.id)
})

test('an edge kind change undoes and redoes', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const result = fixture.api.graph.connect(planner, coder, 'handoff')
  if (!result.ok) throw new Error(result.reason)

  await history.setEdgeKind(result.id, 'depends-on')
  expect(fixture.world().edges[result.id].kind).toBe('depends-on')
  await history.undo()
  expect(fixture.world().edges[result.id].kind).toBe('handoff')
  await history.redo()
  expect(fixture.world().edges[result.id].kind).toBe('depends-on')
})

test('a multi-node move is one undo step that restores every prior position', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const trigger = Object.values(fixture.world().triggers)[0].id
  const node = sb('sb-local-1')
  const w = fixture.world()
  const before = [w.agents[planner].position, w.triggers[trigger].position, w.sandboxes[node].position]

  await history.move([
    { id: planner, position: { x: 1, y: 2 } },
    { id: trigger, position: { x: 3, y: 4 } },
    { id: node, position: { x: 5, y: 6 } },
  ])
  await history.undo()
  const undone = fixture.world()
  expect([undone.agents[planner].position, undone.triggers[trigger].position, undone.sandboxes[node].position]).toEqual(before)
  expect(history.canUndo()).toBe(false)

  await history.redo()
  const redone = fixture.world()
  expect([redone.agents[planner].position, redone.triggers[trigger].position, redone.sandboxes[node].position])
    .toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }])
})

test('undo of a working agent delete restores it idle with its edges while its run and tasks keep the delete outcome', async () => {
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

  await history.delete({ nodeIds: [coder], edgeIds: [] })
  expect(fixture.world().agents).not.toHaveProperty(coder)

  await history.undo()
  const w = fixture.world()
  expect(w.agents[coder]).toEqual({ ...before, status: 'idle' })
  for (const id of edgeIds) expect(w.edges).toHaveProperty(id)
  expect(w.runs[run.id]).toMatchObject({ status: 'failed', error: 'agent deleted' })
  expect(fixture.task(running).status).toBe('failed')
  expect(fixture.task(queued).status).toBe('cancelled')
  expect(w.agents[coder].failed).toBe(before.failed)
  expect(w.events.at(-1)).toMatchObject({ kind: 'graph', subject: { kind: 'agent', id: coder }, msg: 'Restored Coder' })
})

test('undo of a sandbox delete restores it with no leases, empty history, stateSince now and its captured state', async () => {
  const { fixture, history } = setup()
  const coder = fixture.agent('Coder')
  fixture.api.agents.enqueue(coder, { title: 'one', prompt: 'p', priority: 'normal' })
  fixture.api.sim.advance(1)
  const id = sb('sb-local-1')
  const before = fixture.world().sandboxes[id]
  expect(before.leases).toHaveLength(1)
  expect(before.history.length).toBeGreaterThan(0)

  await history.delete({ nodeIds: [id], edgeIds: [] })
  fixture.api.sim.advance(500)
  await history.undo()
  const w = fixture.world()
  expect(w.sandboxes[id]).toEqual({ ...before, leases: [], history: [], stateSince: w.now })
  expect(w.sandboxes[id].stateSince).not.toBe(before.stateSince)
  expect(w.sandboxes[id]).toMatchObject({ state: before.state, progress: before.progress })
  expect(Object.values(w.edges).filter((e) => e.target === id)).toHaveLength(2)
})

test('undo of a trigger delete restores it with lastFiredAt null and its captured fired count', async () => {
  const { fixture, history } = setup()
  const trigger = Object.values(fixture.world().triggers)[0]
  fixture.api.triggers.fire(trigger.id)
  fixture.api.triggers.fire(trigger.id)
  const before = fixture.world().triggers[trigger.id]
  expect(before.fired).toBe(2)
  expect(before.lastFiredAt).not.toBeNull()

  await history.delete({ nodeIds: [trigger.id], edgeIds: [] })
  await history.undo()
  expect(fixture.world().triggers[trigger.id]).toEqual({ ...before, lastFiredAt: null })
  expect(Object.values(fixture.world().edges).some((e) => e.source === trigger.id)).toBe(true)
})

test('undo of a paused agent delete restores it still paused', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  fixture.api.agents.setPaused(planner, true)

  await history.delete({ nodeIds: [planner], edgeIds: [] })
  await history.undo()
  expect(fixture.world().agents[planner].status).toBe('paused')
})

test('a node delete with a separately selected edge is one undo step', async () => {
  const { fixture, history } = setup()
  const created = await history.createNode('trigger', { x: 0, y: 0 })
  const reviewer = fixture.agent('Reviewer')
  const attached = Object.values(fixture.world().edges).filter((e) => e.source === reviewer || e.target === reviewer).map((e) => e.id)
  const standalone = edge(fixture, (e) => e.source === fixture.agent('Planner') && e.kind === 'runs-in').id
  expect(attached.length).toBeGreaterThan(1)

  // React Flow also passes the attached edges it removes alongside the node
  await history.delete({ nodeIds: [reviewer], edgeIds: [attached[0], standalone] })
  expect(fixture.world().agents).not.toHaveProperty(reviewer)
  expect(fixture.world().edges).not.toHaveProperty(standalone)

  await history.undo()
  expect(fixture.world().agents).toHaveProperty(reviewer)
  for (const id of [...attached, standalone]) expect(fixture.world().edges).toHaveProperty(id)
  expect(fixture.world().triggers).toHaveProperty(created)

  await history.undo()
  expect(fixture.world().triggers).not.toHaveProperty(created)
  expect(history.canUndo()).toBe(false)
})

test('an edge-only delete removes the edges without a node delete event', async () => {
  const { fixture, history } = setup()
  const id = Object.values(fixture.world().edges)[0].id
  const deletions = () => fixture.events().filter((e) => e.msg.startsWith('Deleted')).length

  await history.delete({ nodeIds: [], edgeIds: [id] })
  expect(fixture.world().edges).not.toHaveProperty(id)
  await history.undo()
  expect(fixture.world().edges).toHaveProperty(id)
  await history.redo()
  expect(fixture.world().edges).not.toHaveProperty(id)
  expect(deletions()).toBe(0)
})

test('undo of a spawn whose node is already gone logs no delete and still moves the cursor', async () => {
  const { fixture, history } = setup()
  const id = await history.createNode('sandbox', { x: 0, y: 0 }) as SandboxId
  fixture.api.sandboxes.act(id, 'destroy')
  fixture.api.sim.advance(1500)
  expect(fixture.world().sandboxes).not.toHaveProperty(id)
  const deletions = () => fixture.events().filter((e) => e.msg.startsWith('Deleted')).length

  await history.undo()
  expect(deletions()).toBe(0)
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(true)

  await history.redo()
  expect(fixture.world().sandboxes).toHaveProperty(id)
})

test('three name keystrokes on one agent are one undo step', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')

  for (const name of ['Planner1', 'Planner12', 'Planner123']) await history.updateAgent(planner, { name })
  expect(fixture.world().agents[planner].name).toBe('Planner123')

  await history.undo()
  expect(fixture.world().agents[planner].name).toBe('Planner')
  expect(history.canUndo()).toBe(false)
  await history.redo()
  expect(fixture.world().agents[planner].name).toBe('Planner123')
})

test('retry Attempts then Backoff edits coalesce under the retry key', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const original = fixture.world().agents[planner].retry

  // each field sends only itself, as the inspector does, and the server merges it into the policy
  const attempts = history.updateAgent(planner, { retry: { maxAttempts: 5 } })
  const backoff = history.updateAgent(planner, { retry: { backoffMs: 9000 } })
  await Promise.all([attempts, backoff])
  expect(fixture.world().agents[planner].retry).toEqual({ ...original, maxAttempts: 5, backoffMs: 9000 })

  await history.undo()
  expect(fixture.world().agents[planner].retry).toEqual(original)
  expect(history.canUndo()).toBe(false)
})

test('a name edit then a role edit are two undo steps', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')

  await history.updateAgent(planner, { name: 'Lead' })
  await history.updateAgent(planner, { role: 'architect' })
  await history.undo()
  expect(fixture.world().agents[planner]).toMatchObject({ name: 'Lead', role: 'tech lead' })
  await history.undo()
  expect(fixture.world().agents[planner]).toMatchObject({ name: 'Planner', role: 'tech lead' })
  expect(history.canUndo()).toBe(false)
})

test('the same key on a different node is a separate undo step', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')

  await history.updateAgent(planner, { name: 'Lead' })
  await history.updateAgent(coder, { name: 'Builder' })
  await history.undo()
  expect(fixture.world().agents[planner].name).toBe('Lead')
  expect(fixture.world().agents[coder].name).toBe('Coder')
  await history.undo()
  expect(fixture.world().agents[planner].name).toBe('Planner')
})

test('typing a character and deleting it again leaves nothing to undo', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const created = await history.createNode('agent', { x: 0, y: 0 })

  await history.updateAgent(planner, { name: 'Planner1' })
  await history.updateAgent(planner, { name: 'Planner' })
  await history.undo()
  expect(fixture.world().agents).not.toHaveProperty(created)
  expect(history.canUndo()).toBe(false)
})

test('an edit after a dropped entry starts a new undo step instead of extending the entry below', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const role = fixture.world().agents[planner].role

  await history.updateAgent(planner, { name: 'Lead' })
  await history.updateAgent(planner, { role: 'architect' })
  await history.updateAgent(planner, { role })
  await history.updateAgent(planner, { name: 'Lead2' })
  await history.undo()
  expect(fixture.world().agents[planner].name).toBe('Lead')
})

test('an undo or redo between same-key edits starts a new undo step', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')

  await history.updateAgent(planner, { name: 'Lead' })
  await history.updateAgent(coder, { name: 'Builder' })
  await history.undo()
  await history.updateAgent(planner, { name: 'Lead1' })
  await history.undo()
  expect(fixture.world().agents[planner].name).toBe('Lead')

  await history.undo()
  await history.redo()
  await history.updateAgent(planner, { name: 'Lead2' })
  await history.undo()
  expect(fixture.world().agents[planner].name).toBe('Lead')
})

test('a multi-key patch is one undo step that reverts every key', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')

  await history.updateAgent(planner, { name: 'Lead', role: 'architect' })
  await history.updateAgent(planner, { role: 'architect', name: 'Lead2' })
  await history.undo()
  expect(fixture.world().agents[planner]).toMatchObject({ name: 'Planner', role: 'tech lead' })
  expect(history.canUndo()).toBe(false)
})

test('trigger and sandbox patches undo and redo', async () => {
  const { fixture, history } = setup()
  const trigger = Object.values(fixture.world().triggers)[0]
  const box = fixture.world().sandboxes[sb('sb-docker-1')]

  await history.updateTrigger(trigger.id, { enabled: true })
  await history.updateSandbox(box.id, { capacity: 3 })
  await history.undo()
  expect(fixture.world().sandboxes[box.id].capacity).toBe(box.capacity)
  await history.undo()
  expect(fixture.world().triggers[trigger.id].enabled).toBe(false)
  await history.redo()
  await history.redo()
  expect(fixture.world().triggers[trigger.id].enabled).toBe(true)
  expect(fixture.world().sandboxes[box.id].capacity).toBe(3)
})

test('rejected and no-op writes leave nothing to undo', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const runsIn = edge(fixture, (e) => e.source === coder && e.kind === 'runs-in')
  const handoff = fixture.api.graph.connect(planner, coder, 'handoff')
  fixture.api.graph.connect(planner, coder, 'depends-on')
  if (!handoff.ok) throw new Error(handoff.reason)

  expect((await history.connect(sb('sb-local-1'), planner, null)).ok).toBe(false)
  expect((await history.connect(runsIn.source, runsIn.target, 'runs-in')).ok).toBe(false)
  await history.setEdgeKind(handoff.id, 'depends-on')
  await history.setEdgeKind(handoff.id, 'handoff')
  await history.setEdgeKind(runsIn.id, 'handoff')
  await history.updateSandbox(sb('sb-docker-1'), { capacity: 0 })
  await history.updateSandbox(sb('sb-docker-1'), { capacity: fixture.world().sandboxes[sb('sb-docker-1')].capacity })
  await history.updateAgent(planner, { name: 'Planner' })
  await history.removeEdges(['ed-missing' as EdgeId])
  await history.delete({ nodeIds: ['ag-missing' as AgentId], edgeIds: [] })
  await history.move([{ id: planner, position: fixture.world().agents[planner].position }])

  expect(fixture.world().edges[handoff.id].kind).toBe('handoff')
  expect(history.canUndo()).toBe(false)
})

test('the stack keeps the newest 100 edits and the first of 101 is no longer undoable', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  for (let x = 1; x <= 101; x += 1) await history.move([{ id: planner, position: { x, y: 0 } }])

  for (let i = 0; i < 100; i += 1) await history.undo()
  expect(history.canUndo()).toBe(false)
  expect(fixture.world().agents[planner].position).toEqual({ x: 1, y: 0 })
  await history.undo()
  expect(fixture.world().agents[planner].position).toEqual({ x: 1, y: 0 })
})

test('a new edit after an undo discards the redo entries', async () => {
  const { fixture, history } = setup()
  const first = await history.createNode('agent', { x: 0, y: 0 })
  await history.undo()
  const second = await history.createNode('trigger', { x: 0, y: 0 })
  expect(history.canRedo()).toBe(false)

  await history.redo()
  expect(fixture.world().agents).not.toHaveProperty(first)
  await history.undo()
  expect(fixture.world().triggers).not.toHaveProperty(second)
  expect(history.canUndo()).toBe(false)
})

test('reset reseeds the world and empties the stack', async () => {
  const { fixture, history } = setup()
  const planner = fixture.agent('Planner')
  const created = await history.createNode('agent', { x: 0, y: 0 })
  await history.updateAgent(planner, { name: 'Lead' })
  await history.undo()

  await history.reset()
  expect(fixture.world().agents).not.toHaveProperty(created)
  expect(fixture.world().agents[planner].name).toBe('Planner')
  expect(fixture.world().edges).toHaveProperty('ed-2')
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(false)
})

test('subscribers hear every stack change until they unsubscribe, with methods usable detached', async () => {
  const { fixture, history } = setup()
  const { subscribe, canUndo, canRedo } = history
  const seen: Array<[boolean, boolean]> = []
  const unsubscribe = subscribe(() => { seen.push([canUndo(), canRedo()]) })

  await history.createNode('agent', { x: 0, y: 0 })
  await history.undo()
  await history.redo()
  await history.reset()
  expect(seen).toEqual([[true, false], [false, true], [true, false], [false, false]])

  unsubscribe()
  await history.updateAgent(fixture.agent('Planner'), { name: 'Lead' })
  expect(seen).toHaveLength(4)
})

test('restoreEdges skips missing endpoints, invalid kinds, duplicates and ids already present', async () => {
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

test('restoreNodes skips an id that already exists and logs nothing for it', async () => {
  const fixture = makeFixture()
  const planner = fixture.world().agents[fixture.agent('Planner')]
  const events = fixture.events().length

  fixture.api.graph.restoreNodes([{ kind: 'agent', node: { ...planner, name: 'Impostor' } }])
  expect(fixture.world().agents[planner.id]).toEqual(planner)
  expect(fixture.events()).toHaveLength(events)
})
