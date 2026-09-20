/**
 * Copy, paste and duplicate, exercised through `createClipboard` bound to a
 * history on a fixture's API and world getter. Assertions read world state and
 * the history's public `canUndo`; the `api.graph.paste` boundary rule is also
 * covered directly through `src/api/client.ts`.
 */
import { expect, test } from 'vitest'
import { createClipboard } from '../src/clipboard'
import { createHistory } from '../src/history'
import { fragmentOf, type AgentId, type Edge, type NodeId, type TriggerId, type World } from '../src/domain/types'
import { makeFixture, sb, type Fixture } from './fixture'

const tr = (id: string) => id as TriggerId

/** The default fixture with a Planner → Coder handoff, which is the selection most tests copy. */
function setup() {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const joined = fixture.api.graph.connect(planner, coder, 'handoff')
  if (!joined.ok) throw new Error(joined.reason)
  return { fixture, history, clipboard: createClipboard(history, fixture.world), planner, coder, handoff: joined.id }
}

/** The server writes into the world it last published, so a comparison baseline needs its own copy of the record maps. */
function snapshot(fixture: Fixture): World {
  return { ...fixture.world() }
}

function nodeCount(w: World): number {
  return Object.keys(w.agents).length + Object.keys(w.sandboxes).length + Object.keys(w.triggers).length
}

function edgesAmong(fixture: Fixture, ids: NodeId[]): Edge[] {
  return fragmentOf(fixture.world(), ids).edges
}

test('paste creates offset copies of two agents and the handoff between them, leaving the originals alone', () => {
  const { fixture, clipboard, planner, coder, handoff } = setup()
  fixture.api.agents.enqueue(planner, { title: 'Plan', prompt: 'plan it', priority: 'normal' })
  fixture.api.sim.advance(1)
  fixture.api.sim.advance(12_500)
  fixture.api.sim.advance(1)
  expect(fixture.world().agents[planner].completed).toBe(1)
  expect(fixture.world().agents[coder].status).toBe('working')
  const before = snapshot(fixture)

  expect(clipboard.copy([planner, coder])).toBe(true)
  const pasted = clipboard.paste() as AgentId[]

  expect(pasted).toHaveLength(2)
  expect(new Set([...pasted, planner, coder]).size).toBe(4)
  const [newPlanner, newCoder] = pasted
  const w = fixture.world()
  expect(w.agents[newPlanner]).toEqual({
    id: newPlanner, name: 'Planner', role: 'tech lead', model: 'claude-opus-5', temperature: 0.2, concurrency: 1, timeoutMs: 120_000,
    retry: { maxAttempts: 3, backoffMs: 2000, backoff: 'exponential' }, tools: ['read_file', 'search', 'linear'],
    systemPrompt: 'You are Planner, the tech lead for this team. Work in the assigned sandbox and hand off when done.',
    status: 'idle', position: { x: 360, y: 100 }, completed: 0, failed: 0, groupId: null,
  })
  expect(w.agents[newCoder]).toEqual({
    id: newCoder, name: 'Coder', role: 'implementer', model: 'claude-sonnet-5', temperature: 0.2, concurrency: 2, timeoutMs: 120_000,
    retry: { maxAttempts: 3, backoffMs: 2000, backoff: 'exponential' }, tools: ['read_file', 'write_file', 'bash'],
    systemPrompt: 'You are Coder, the implementer for this team. Work in the assigned sandbox and hand off when done.',
    status: 'idle', position: { x: 360, y: 300 }, completed: 0, failed: 0, groupId: null,
  })
  expect(newPlanner).toMatch(/^ag-/)
  expect(newCoder).toMatch(/^ag-/)

  const added = Object.values(w.edges).filter((e) => !before.edges[e.id])
  expect(added).toEqual([{ id: expect.stringMatching(/^ed-/), kind: 'handoff', source: newPlanner, target: newCoder }])
  expect(added[0].id).not.toBe(handoff)

  expect(w.agents[planner]).toEqual(before.agents[planner])
  expect(w.agents[coder]).toEqual(before.agents[coder])
  for (const e of Object.values(before.edges)) expect(w.edges[e.id]).toEqual(e)
  expect(nodeCount(w)).toBe(nodeCount(before) + 2)
  expect(w.tasks).toEqual(before.tasks)
  expect(w.runs).toEqual(before.runs)
})

test('a paused agent pastes paused', () => {
  const { fixture, clipboard, planner } = setup()
  fixture.api.agents.setPaused(planner, true)
  clipboard.copy([planner])
  const [copy] = clipboard.paste() as AgentId[]
  expect(fixture.world().agents[copy].status).toBe('paused')
})

test('repeated pastes cascade by one more offset each, and a new copy starts over', () => {
  const { fixture, clipboard, planner } = setup()
  clipboard.copy([planner])
  const [first] = clipboard.paste() as AgentId[]
  const [second] = clipboard.paste() as AgentId[]
  expect(fixture.world().agents[first].position).toEqual({ x: 360, y: 100 })
  expect(fixture.world().agents[second].position).toEqual({ x: 400, y: 140 })

  clipboard.copy([planner])
  const [third] = clipboard.paste() as AgentId[]
  expect(fixture.world().agents[third].position).toEqual({ x: 360, y: 100 })
})

test('an edge from a copied agent to an unselected sandbox is not copied', () => {
  const { fixture, clipboard, planner, coder } = setup()
  const before = snapshot(fixture)
  expect(Object.values(before.edges).filter((e) => e.kind === 'runs-in' && (e.source === planner || e.source === coder))).toHaveLength(3)

  clipboard.copy([planner, coder])
  const pasted = clipboard.paste()

  const w = fixture.world()
  expect(Object.keys(w.edges)).toHaveLength(Object.keys(before.edges).length + 1)
  const touching = Object.values(w.edges).filter((e) => pasted.includes(e.source) || pasted.includes(e.target))
  expect(touching.map((e) => e.kind)).toEqual(['handoff'])
  expect(Object.keys(w.sandboxes)).toEqual(Object.keys(before.sandboxes))
})

test('copying an empty selection returns false and keeps the fragment copied before', () => {
  const { fixture, clipboard, planner } = setup()
  expect(clipboard.copy([planner])).toBe(true)
  expect(clipboard.copy([])).toBe(false)
  expect(clipboard.copy(['ag-missing' as AgentId])).toBe(false)

  const pasted = clipboard.paste() as AgentId[]
  expect(pasted).toHaveLength(1)
  expect(fixture.world().agents[pasted[0]].name).toBe('Planner')
})

test('paste with nothing copied and duplicate of nothing change nothing', () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  const clipboard = createClipboard(history, fixture.world)
  const published = fixture.world()
  const before = snapshot(fixture)

  expect(clipboard.paste()).toEqual([])
  expect(clipboard.duplicate([])).toEqual([])
  expect(fixture.world()).toBe(published)
  expect(fixture.world()).toEqual(before)
  expect(history.canUndo()).toBe(false)
})

test('a leased sandbox and a fired trigger paste idle', () => {
  const { fixture, clipboard, planner } = setup()
  fixture.api.triggers.fire(tr('tr-cron'))
  fixture.api.sim.advance(1)
  const before = snapshot(fixture)
  expect(before.sandboxes[sb('sb-local-1')].leases).toEqual([expect.objectContaining({ agentId: planner })])
  expect(before.sandboxes[sb('sb-local-1')].state).toBe('running')
  expect(before.triggers[tr('tr-cron')]).toMatchObject({ fired: 1, lastFiredAt: expect.any(Number) })

  clipboard.copy([sb('sb-local-1'), tr('tr-cron')])
  const pasted = clipboard.paste()

  const w = fixture.world()
  const newSandbox = pasted.find((id) => id in w.sandboxes)
  const newTrigger = pasted.find((id) => id in w.triggers)
  if (!newSandbox || !newTrigger) throw new Error('expected a pasted sandbox and trigger')
  expect(w.sandboxes[sb(newSandbox)]).toEqual({
    id: newSandbox, name: 'mac-studio', kind: 'local', host: 'localhost', image: 'ghcr.io/factory/dev:node22', capacity: 1,
    state: 'provisioning', stateSince: w.now, progress: 0, metrics: { cpu: 0, mem: 0, disk: 4 }, history: [], leases: [],
    restartPending: false, position: { x: 360, y: 510 }, groupId: null,
  })
  expect(w.triggers[tr(newTrigger)]).toEqual({
    id: newTrigger, name: 'Nightly sweep', kind: 'cron', intervalMs: 18_000, enabled: false, lastFiredAt: null, fired: 0,
    template: 'Sweep open issues and plan the next batch', position: { x: 80, y: 100 }, groupId: null,
  })
  expect(newSandbox).toMatch(/^sb-/)
  expect(newTrigger).toMatch(/^tr-/)
  expect(w.sandboxes[sb('sb-local-1')]).toEqual(before.sandboxes[sb('sb-local-1')])
  expect(w.triggers[tr('tr-cron')]).toEqual(before.triggers[tr('tr-cron')])
  expect(w.logs.at(-1)?.msg).toBe('provisioning mac-studio (local) on localhost')
})

test('paste still works after the copied originals were edited and deleted', () => {
  const { fixture, history, clipboard, planner, coder } = setup()
  clipboard.copy([planner, coder])
  history.updateAgent(planner, { name: 'Lead' })
  history.delete({ nodeIds: [planner, coder], edgeIds: [] })

  const pasted = clipboard.paste() as AgentId[]

  const w = fixture.world()
  expect(pasted.map((id) => w.agents[id].name)).toEqual(['Planner', 'Coder'])
  expect(pasted.map((id) => w.agents[id].position)).toEqual([{ x: 360, y: 100 }, { x: 360, y: 300 }])
  expect(edgesAmong(fixture, pasted)).toEqual([{ id: expect.stringMatching(/^ed-/), kind: 'handoff', source: pasted[0], target: pasted[1] }])
})

test('one undo removes a paste and redo restores it under the same ids', () => {
  const { fixture, history, clipboard, planner, coder } = setup()
  const before = snapshot(fixture)
  clipboard.copy([planner, coder])
  const pasted = clipboard.paste() as AgentId[]
  const after = snapshot(fixture)
  const [newEdge] = edgesAmong(fixture, pasted)

  history.undo()
  expect(fixture.world().agents).toEqual(before.agents)
  expect(fixture.world().edges).toEqual(before.edges)
  expect(history.canUndo()).toBe(false)

  history.redo()
  expect(fixture.world().agents).toEqual(after.agents)
  expect(fixture.world().edges).toEqual(after.edges)
  expect(fixture.world().edges[newEdge.id]).toEqual({ id: newEdge.id, kind: 'handoff', source: pasted[0], target: pasted[1] })
})

test('duplicate copies the selection at one offset without touching the clipboard, and undoes in one step', () => {
  const { fixture, history, clipboard, planner, coder } = setup()
  const reviewer = fixture.agent('Reviewer')
  clipboard.copy([reviewer])
  const before = snapshot(fixture)

  const dup = clipboard.duplicate([planner, coder]) as AgentId[]

  const after = snapshot(fixture)
  expect(dup.map((id) => after.agents[id].name)).toEqual(['Planner', 'Coder'])
  expect(dup.map((id) => after.agents[id].position)).toEqual([{ x: 360, y: 100 }, { x: 360, y: 300 }])
  expect(Object.keys(after.agents)).toHaveLength(Object.keys(before.agents).length + 2)
  expect(Object.keys(after.edges)).toHaveLength(Object.keys(before.edges).length + 1)
  expect(edgesAmong(fixture, dup)).toEqual([{ id: expect.stringMatching(/^ed-/), kind: 'handoff', source: dup[0], target: dup[1] }])
  expect(after.agents[planner]).toEqual(before.agents[planner])
  expect(after.agents[coder]).toEqual(before.agents[coder])

  history.undo()
  expect(fixture.world().agents).toEqual(before.agents)
  expect(fixture.world().edges).toEqual(before.edges)
  expect(history.canUndo()).toBe(false)

  history.redo()
  expect(fixture.world().agents).toEqual(after.agents)
  expect(fixture.world().edges).toEqual(after.edges)

  const [fromClipboard] = clipboard.paste() as AgentId[]
  expect(fixture.world().agents[fromClipboard]).toMatchObject({ name: 'Reviewer', position: { x: 680, y: 300 } })
})

test('api.graph.paste drops an edge that leaves the fragment and logs one Pasted event', () => {
  const { fixture, planner, coder } = setup()
  const before = snapshot(fixture)
  const external = Object.values(before.edges).find((e) => e.kind === 'runs-in' && e.source === planner)
  if (!external) throw new Error('expected a seeded runs-in edge from Planner')
  const fragment = fragmentOf(before, [planner, coder])

  const created = fixture.api.graph.paste({ nodes: fragment.nodes, edges: [...fragment.edges, external] }, { x: 10, y: 20 })

  const w = fixture.world()
  expect(created.nodes.map((ref) => ref.node.position)).toEqual([{ x: 330, y: 80 }, { x: 330, y: 280 }])
  expect(created.edges).toEqual([{ id: expect.stringMatching(/^ed-/), kind: 'handoff', source: created.nodes[0].node.id, target: created.nodes[1].node.id }])
  expect(Object.keys(w.edges)).toHaveLength(Object.keys(before.edges).length + 1)
  expect(Object.values(w.edges).filter((e) => e.target === external.target)).toEqual(Object.values(before.edges).filter((e) => e.target === external.target))
  const events = w.events.slice(before.events.length)
  expect(events).toEqual([{ id: expect.any(Number), ts: w.now, kind: 'graph', subject: { kind: 'agent', id: created.nodes[0].node.id }, msg: 'Pasted 2 nodes' }])
})

test('api.graph.paste of an empty fragment creates nothing and publishes nothing', () => {
  const fixture = makeFixture()
  const published = fixture.world()
  const before = snapshot(fixture)
  expect(fixture.api.graph.paste({ nodes: [], edges: [] }, { x: 40, y: 40 })).toEqual({ nodes: [], edges: [] })
  expect(fixture.world()).toBe(published)
  expect(fixture.world()).toEqual(before)
})
