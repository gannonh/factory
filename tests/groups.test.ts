import { expect, test } from 'vitest'
import { GROUP_HEADER, GROUP_PAD, groupFrame, membersOf, sharedGroupId } from '../src/components/canvas/groups'
import { seedWorld } from '../src/domain/seed'
import type { AgentId, GroupId, NodeId, SandboxId } from '../src/domain/types'
import { createHistory } from '../src/history'
import { makeFixture } from './fixture'

test('a new group takes the next unused Group N name', async () => {
  const fixture = makeFixture()
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const qa = fixture.agent('QA')
  const reviewer = fixture.agent('Reviewer')

  const first = fixture.api.graph.group([planner, coder])
  const second = fixture.api.graph.group([qa, reviewer])
  if (first === null || second === null) throw new Error('expected two groups')
  expect(fixture.world().groups[first].name).toBe('Group 1')
  expect(fixture.world().groups[second].name).toBe('Group 2')

  fixture.api.graph.ungroup(first)
  const third = fixture.api.graph.group([planner, coder])
  if (third === null) throw new Error('expected a replacement group')
  expect(fixture.world().groups[third].name).toBe('Group 1')
  expect(fixture.world().groups[second].name).toBe('Group 2')
})

test('graph.group sets one shared groupId, leaves positions unchanged, and returns null for one id or an already grouped id', async () => {
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

test('graph.ungroup clears groupId, removes the record, and leaves positions unchanged', async () => {
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

test('undo and redo of group and of ungroup keep the same group id', async () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')

  const id = await history.group([planner, coder])
  if (id === null) throw new Error('expected a group')
  expect(fixture.world().groups[id].id).toBe(id)
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)

  await history.undo()
  expect(fixture.world().groups).not.toHaveProperty(id)
  expect(fixture.world().agents[planner].groupId).toBeNull()
  expect(fixture.world().agents[coder].groupId).toBeNull()
  expect(history.canUndo()).toBe(false)
  expect(history.canRedo()).toBe(true)

  await history.redo()
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Group 1' })
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)

  await history.ungroup(id)
  expect(fixture.world().groups).not.toHaveProperty(id)
  expect(fixture.world().agents[planner].groupId).toBeNull()

  await history.undo()
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Group 1' })
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)

  await history.redo()
  expect(fixture.world().groups).not.toHaveProperty(id)
  expect(fixture.world().agents[planner].groupId).toBeNull()
  expect(fixture.world().agents[coder].groupId).toBeNull()
})

test('sharedGroupId is the one group only when every selected id is that group', async () => {
  const a = 'gr-a' as GroupId
  const b = 'gr-b' as GroupId
  expect(sharedGroupId([])).toBeNull()
  expect(sharedGroupId([null])).toBeNull()
  expect(sharedGroupId([a])).toBe(a)
  expect(sharedGroupId([a, a])).toBe(a)
  expect(sharedGroupId([a, null])).toBeNull()
  expect(sharedGroupId([a, b])).toBeNull()
})

test('groupFrame pads member rects and membersOf lists the group ids', async () => {
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

test('rename sets the group name and two consecutive renames undo in one step', async () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  const id = await history.group([fixture.agent('Planner'), fixture.agent('Coder')])
  if (id === null) throw new Error('expected a group')

  await history.updateGroup(id, { name: 'Alpha' })
  await history.updateGroup(id, { name: 'Alpha team' })
  expect(fixture.world().groups[id].name).toBe('Alpha team')

  await history.undo()
  expect(fixture.world().groups[id].name).toBe('Group 1')
  expect(history.canUndo()).toBe(true)

  await history.redo()
  expect(fixture.world().groups[id].name).toBe('Alpha team')
})

test('delete one member then undo puts it back in the group, and delete every member then undo restores the group name', async () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  const planner = fixture.agent('Planner')
  const coder = fixture.agent('Coder')
  const id = await history.group([planner, coder])
  if (id === null) throw new Error('expected a group')
  await history.updateGroup(id, { name: 'Crew' })

  await history.delete({ nodeIds: [planner], edgeIds: [] })
  expect(fixture.world().agents).not.toHaveProperty(planner)
  expect(fixture.world().agents[coder].groupId).toBe(id)
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Crew' })

  await history.undo()
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)
  expect(fixture.world().groups[id].name).toBe('Crew')

  await history.delete({ nodeIds: [planner, coder], edgeIds: [] })
  expect(fixture.world().agents).not.toHaveProperty(planner)
  expect(fixture.world().agents).not.toHaveProperty(coder)
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Crew' })

  await history.undo()
  expect(fixture.world().agents[planner].groupId).toBe(id)
  expect(fixture.world().agents[coder].groupId).toBe(id)
  expect(fixture.world().groups[id]).toEqual({ id, name: 'Crew' })
})
