import { expect, test, vi } from 'vitest'
import { retainWorld, STORAGE_KEY, MockServer } from '../src/api/mockServer'
import { GROUP_HEADER, GROUP_PAD, groupFrame, membersOf } from '../src/components/canvas/groups'
import { seedWorld } from '../src/domain/seed'
import type { AgentId, GroupId, NodeId, SandboxId } from '../src/domain/types'
import { createHistory } from '../src/history'
import { makeFixture, makeStorage, RNG } from './fixture'

test('graph.group sets one shared groupId, leaves positions unchanged, and returns null for one id or an already grouped id', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const qa = fixture.agent('QA')
  const plannerPos = fixture.world().agents[planner].position
  const coderPos = fixture.world().agents[coder].position

  expect(fixture.api.graph.group([planner])).toBeNull()
  expect(fixture.world().agents[planner].groupId).toBeNull()
  expect(fixture.world().groups).toEqual({})

  const id = fixture.api.graph.group([planner, coder])
  expect(id).toMatch(/^gr-/)
  const w = fixture.world()
  expect(w.groups[id!]).toEqual({ id, name: 'Group 1' })
  expect(w.agents[planner].groupId).toBe(id)
  expect(w.agents[coder].groupId).toBe(id)
  expect(w.agents[qa].groupId).toBeNull()
  expect(w.agents[planner].position).toEqual(plannerPos)
  expect(w.agents[coder].position).toEqual(coderPos)

  expect(fixture.api.graph.group([planner, qa])).toBeNull()
  expect(fixture.world().agents[qa].groupId).toBeNull()
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().groups[id!]).toEqual({ id, name: 'Group 1' })
})

test('graph.ungroup clears groupId, removes the record, and leaves positions unchanged', () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const plannerPos = fixture.world().agents[planner].position
  const coderPos = fixture.world().agents[coder].position
  const id = fixture.api.graph.group([planner, coder])
  if (id === null) throw new Error('expected a group')

  fixture.api.graph.ungroup(id)
  const w = fixture.world()
  expect(w.groups).toEqual({})
  expect(w.groups).not.toHaveProperty(id)
  expect(w.agents[planner].groupId).toBeNull()
  expect(w.agents[coder].groupId).toBeNull()
  expect(w.agents[planner].position).toEqual(plannerPos)
  expect(w.agents[coder].position).toEqual(coderPos)
})

test('undo and redo of group and of ungroup keep the same group id', () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')

  const id = history.group([planner, coder])
  if (id === null) throw new Error('expected a group')
  expect(fixture.world().groups[id].id).toBe(id)
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)

  history.undo()
  expect(fixture.world().groups).not.toHaveProperty(id)
  expect(fixture.world().agents[planner].groupId).toBeNull()
  expect(fixture.world().agents[coder].groupId).toBeNull()
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(true)

  history.redo()
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Group 1' })
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)

  history.ungroup(id)
  expect(fixture.world().groups).not.toHaveProperty(id)
  expect(fixture.world().agents[planner].groupId).toBeNull()

  history.undo()
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Group 1' })
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)

  history.redo()
  expect(fixture.world().groups).not.toHaveProperty(id)
  expect(fixture.world().agents[planner].groupId).toBeNull()
  expect(fixture.world().agents[coder].groupId).toBeNull()
})

test('groupFrame pads member rects and membersOf lists the group ids', () => {
  expect(groupFrame([
    { x: 100, y: 200, width: 220, height: 84 },
    { x: 160, y: 260, width: 200, height: 52 },
  ])).toEqual({
    position: { x: 100 - GROUP_PAD, y: 200 - GROUP_PAD - GROUP_HEADER },
    width: 160 + 200 - 100 + GROUP_PAD * 2,
    height: 260 + 52 - 200 + GROUP_PAD * 2 + GROUP_HEADER,
  })

  const world = seedWorld(0)
  const gid = 'gr-literal' as GroupId
  world.groups[gid] = { id: gid, name: 'Literal' }
  world.agents['ag-planner' as AgentId].groupId = gid
  world.agents['ag-coder' as AgentId].groupId = gid
  world.sandboxes['sb-local-1' as SandboxId].groupId = gid
  expect(membersOf(world, gid)).toEqual(['ag-planner', 'ag-coder', 'sb-local-1'] as NodeId[])
  expect(membersOf(world, 'gr-missing' as GroupId)).toEqual([])
})

test('rename sets the group name and two consecutive renames undo in one step', () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  const id = history.group([fixture.agent('Planner'), fixture.agent('Coder')])
  if (id === null) throw new Error('expected a group')

  history.updateGroup(id, { name: 'Alpha' })
  history.updateGroup(id, { name: 'Alpha team' })
  expect(fixture.world().groups[id].name).toBe('Alpha team')

  history.undo()
  expect(fixture.world().groups[id].name).toBe('Group 1')
  expect(history.canUndo()).toBe(true)

  history.redo()
  expect(fixture.world().groups[id].name).toBe('Alpha team')
})

test('delete one member then undo puts it back in the group, and delete every member then undo restores the group name', () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const id = history.group([planner, coder])
  if (id === null) throw new Error('expected a group')
  history.updateGroup(id, { name: 'Crew' })

  history.delete({ nodeIds: [planner], edgeIds: [] })
  expect(fixture.world().agents).not.toHaveProperty(planner)
  expect(fixture.world().agents[coder].groupId).toBe(id)
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Crew' })

  history.undo()
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)
  expect(fixture.world().groups[id].name).toBe('Crew')

  history.delete({ nodeIds: [planner, coder], edgeIds: [] })
  expect(fixture.world().agents).not.toHaveProperty(planner)
  expect(fixture.world().agents).not.toHaveProperty(coder)
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Crew' })

  history.undo()
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Crew' })
})

test('a group survives a reload through injected storage with its name and members', () => {
  vi.useFakeTimers()
  try {
    const storage = makeStorage()
    const first = makeFixture({ storage })
    const planner = first.agent('Planner')
    const coder = first.agent('Coder')
    const id = first.api.graph.group([planner, coder])
    if (id === null) throw new Error('expected a group')
    first.api.groups.update(id, { name: 'Crew' })
    first.flushSave()

    const second = makeFixture({ storage, isolate: false })
    const w = second.world()
    expect(w.groups[id]).toEqual({ id, name: 'Crew' })
    expect(w.agents[planner].groupId).toBe(id)
    expect(w.agents[coder].groupId).toBe(id)
  } finally {
    vi.useRealTimers()
  }
})

test('a group with no members is absent from the saved payload', () => {
  vi.useFakeTimers()
  try {
    const storage = makeStorage()
    const fixture = makeFixture({ storage })
    const history = createHistory(fixture.api, fixture.world)
    const planner = fixture.agent('Planner')
    const coder = fixture.agent('Coder')
    const id = history.group([planner, coder])
    if (id === null) throw new Error('expected a group')
    history.delete({ nodeIds: [planner, coder], edgeIds: [] })
    expect(fixture.world().groups[id]).toEqual({ id, name: 'Group 1' })
    fixture.flushSave()
    const saved = JSON.parse(storage.getItem(STORAGE_KEY)!) as { groups: Record<string, unknown> }
    expect(saved.groups).toEqual({})
    expect(retainWorld(fixture.world()).groups).toEqual({})
  } finally {
    vi.useRealTimers()
  }
})

test('a save without groups seeds a fresh world', () => {
  const storage = makeStorage()
  storage.setItem(STORAGE_KEY, JSON.stringify({
    now: 1, agents: {}, sandboxes: {}, triggers: {}, edges: {}, sim: { paused: false, speed: 1 },
    tasks: {}, runs: {}, events: [],
  }))
  const server = new MockServer({ manual: true, rng: RNG, storage })
  expect(Object.keys(server.snapshot().agents)).toHaveLength(4)
  expect(server.snapshot().groups).toEqual({})
})
