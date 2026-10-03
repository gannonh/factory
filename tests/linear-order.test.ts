import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { LINEAR_PRIORITY, createLinearClient } from '../server/linear'
import { LINEAR_POLL_MS, type AgentId, type IssueId, type LinearSettings, type Task, type TriggerId } from '../src/domain/types'
import { makeFixture, memoryStore, type Fixture } from './fixture'

const KEY = 'lin_api_test_order'
const LIFECYCLE: LinearSettings = {
  team: 'team-eng', project: null, pickupState: 'state-eng-todo',
  startedState: 'state-eng-in-progress', finishedState: 'state-eng-in-review', failedState: null,
}
const URGENT = 1
const HIGH = 2
const MEDIUM = 3
const LOW = 4

let fake: FakeLinear
beforeAll(async () => { fake = await startFakeLinear({ apiKey: KEY }) })
afterAll(() => fake.close())
beforeEach(async () => { await control({ op: 'reset' }) })

async function control(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(fake.controlUrl, { method: 'POST', body: JSON.stringify(body) })
  return response.json()
}
const addIssue = (title: string, fields: Record<string, unknown> = {}) => control({ op: 'addIssue', title, ...fields })
const moveIssue = (identifier: string, state: string) => control({ op: 'moveIssue', identifier, state })
const linearState = async (identifier: string) => ((await control({ op: 'issue', identifier })) as { state: string }).state

const client = (options: Partial<Parameters<typeof createLinearClient>[0]> = {}) => createLinearClient({ url: fake.url, apiKey: KEY, ...options })

function wallClock(start = 1_000_000) {
  const clock = { now: start, read: () => clock.now }
  return clock
}

function linearTrigger(f: Fixture, agent: AgentId): TriggerId {
  const id = f.api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
  f.api.triggers.update(id, { kind: 'linear', name: 'Linear intake' })
  f.api.graph.connect(id, agent, 'triggers')
  f.api.triggers.update(id, { linear: LIFECYCLE, enabled: true })
  return id
}

async function step(f: Fixture, ms: number) {
  f.api.sim.advance(ms)
  await f.api.sim.settled()
}

/** Takes the pickup issues and starts the first runs. */
async function start(f: Fixture) {
  await step(f, 0)
  await step(f, 1)
}

async function nextPoll(f: Fixture, wall: { now: number }) {
  wall.now += LINEAR_POLL_MS
  await step(f, 1)
}

/** Polls, then runs the scheduler pass that acts on what the poll read. */
async function pollAndSchedule(f: Fixture, wall: { now: number }) {
  await nextPoll(f, wall)
  await step(f, 1)
}

/** One Coder that runs one task at a time, fed by a Linear trigger. */
function oneSlot(wall = wallClock()) {
  const f = makeFixture({ linear: client(), clock: wall.read })
  const coder = f.agent('Coder')
  f.api.agents.update(coder, { concurrency: 1 })
  linearTrigger(f, coder)
  return f
}

const startOrder = (f: Fixture) => Object.values(f.world().runs).sort((a, b) => a.startedAt - b.startedAt).map((r) => r.title)
const taskTitled = (f: Fixture, title: string): Task => Object.values(f.world().tasks).find((t) => t.title === title)!

test('Linear priority maps Urgent and High to high, Medium and No priority to normal, and Low to low', async () => {
  expect(LINEAR_PRIORITY).toEqual({ 0: 'normal', 1: 'high', 2: 'high', 3: 'normal', 4: 'low' })

  for (const [title, priority] of [['None', 0], ['Urgent', URGENT], ['High', HIGH], ['Medium', MEDIUM], ['Low', LOW]] as const) await addIssue(title, { priority })
  const f = oneSlot()
  await step(f, 0)
  expect(Object.values(f.world().tasks).map((t) => [t.title, t.priority])).toEqual([
    ['ENG-1 None', 'normal'], ['ENG-2 Urgent', 'high'], ['ENG-3 High', 'high'], ['ENG-4 Medium', 'normal'], ['ENG-5 Low', 'low'],
  ])
})

test('the Linear client reads an unknown priority as normal, takes blockers only from inverse blocks relations, and reports unread relations', async () => {
  const related = (type: string, identifier: string, state: { name: string; type: string }) =>
    ({ type, issue: { id: `id-${identifier}`, identifier, url: `https://linear.app/x/${identifier}`, state } })
  const node = {
    id: 'issue-1', identifier: 'ENG-1', title: 'Fix login', description: null, url: 'https://linear.app/x/ENG-1', branchName: 'eng-1', priority: 7,
    inverseRelations: {
      nodes: [related('blocks', 'OPS-4', { name: 'In Review', type: 'started' }), related('related', 'ENG-9', { name: 'Todo', type: 'unstarted' })],
      pageInfo: { hasNextPage: true },
    },
  }
  const page = { data: { issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } }
  const fetch = () => Promise.resolve(new Response(JSON.stringify(page)))
  const [issue] = await client({ fetch }).issues(LIFECYCLE)
  expect(issue.priority).toBe('normal')
  expect(issue.blockers).toEqual([{ id: 'id-OPS-4', identifier: 'OPS-4', url: 'https://linear.app/x/OPS-4', state: { name: 'In Review', type: 'started' } }])
  expect(issue.moreRelations).toBe(true)
})

test('with one agent slot, waiting issues at Low, Urgent and Medium start Urgent, Medium, Low', async () => {
  await addIssue('Tidy logs', { priority: LOW })
  await addIssue('Fix outage', { priority: URGENT })
  await addIssue('Add export', { priority: MEDIUM })
  const f = oneSlot()
  await start(f)
  await step(f, 12_500)
  await step(f, 12_500)
  expect(startOrder(f)).toEqual(['ENG-2 Fix outage', 'ENG-3 Add export', 'ENG-1 Tidy logs'])
})

test('raising a queued issue’s priority in Linear moves it ahead on the next poll', async () => {
  await addIssue('Add export', { priority: MEDIUM })
  await addIssue('Tidy logs', { priority: LOW })
  await addIssue('Rename flag', { priority: LOW })
  const wall = wallClock()
  const f = oneSlot(wall)
  await start(f)
  expect(taskTitled(f, 'ENG-3 Rename flag').priority).toBe('low')

  await control({ op: 'setPriority', identifier: 'ENG-3', priority: URGENT })
  await nextPoll(f, wall)
  expect(taskTitled(f, 'ENG-3 Rename flag').priority).toBe('high')
  await step(f, 12_500)
  await step(f, 12_500)
  expect(startOrder(f)).toEqual(['ENG-1 Add export', 'ENG-3 Rename flag', 'ENG-2 Tidy logs'])
})

const ENG_1 = 'issue-eng-1' as IssueId
const ENG_2 = 'issue-eng-2' as IssueId
const queueRow = (task: Task) => ({ status: task.status, blockedOn: task.blockedOn, attempts: task.attempts })

test('an issue blocked by an unfinished issue waits, says why, and stays in the pickup state in Linear', async () => {
  await addIssue('Ship schema', { state: 'In Progress' })
  await addIssue('Use schema', { blockedBy: ['ENG-1'] })
  const f = oneSlot()
  await start(f)
  await step(f, 30_000)

  expect(queueRow(taskTitled(f, 'ENG-2 Use schema'))).toEqual({ status: 'waiting', blockedOn: 'blocked by ENG-1 (In Progress)', attempts: 0 })
  expect(Object.values(f.world().runs)).toEqual([])
  expect(f.world().intake[ENG_2]).toMatchObject({
    phase: 'taken', writes: [],
    blockers: [{ id: 'issue-eng-1', identifier: 'ENG-1', url: 'https://linear.app/fake/issue/ENG-1/ship-schema', state: { name: 'In Progress', type: 'started' } }],
  })
  expect(Object.keys(f.world().intake)).toEqual(['issue-eng-2'])
  expect(await linearState('ENG-2')).toBe('Todo')
})

test('an issue starts on the first poll after its blocker is done, and a blocker in review still blocks it', async () => {
  await addIssue('Ship schema')
  await addIssue('Use schema', { blockedBy: ['ENG-1'] })
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  linearTrigger(f, f.agent('Coder'))
  await start(f)
  expect(startOrder(f)).toEqual(['ENG-1 Ship schema'])
  expect(taskTitled(f, 'ENG-2 Use schema').blockedOn).toBe('blocked by ENG-1 (Todo)')

  await step(f, 12_500)
  expect(await linearState('ENG-1')).toBe('In Review')
  await pollAndSchedule(f, wall)
  expect(queueRow(taskTitled(f, 'ENG-2 Use schema'))).toEqual({ status: 'waiting', blockedOn: 'blocked by ENG-1 (In Review)', attempts: 0 })
  expect(await linearState('ENG-2')).toBe('Todo')

  await moveIssue('ENG-1', 'Done')
  await pollAndSchedule(f, wall)
  expect(queueRow(taskTitled(f, 'ENG-2 Use schema'))).toEqual({ status: 'running', blockedOn: null, attempts: 1 })
  expect(startOrder(f)).toEqual(['ENG-1 Ship schema', 'ENG-2 Use schema'])
  expect(await linearState('ENG-2')).toBe('In Progress')
})

test('with two blockers, finishing one leaves the reason naming only the other', async () => {
  await addIssue('Ship schema', { state: 'In Progress' })
  await addIssue('Ship API', { state: 'In Progress' })
  await addIssue('Use both', { blockedBy: ['ENG-1', 'ENG-2'] })
  const wall = wallClock()
  const f = oneSlot(wall)
  await start(f)
  expect(taskTitled(f, 'ENG-3 Use both').blockedOn).toBe('blocked by ENG-1 (In Progress), ENG-2 (In Progress)')

  await moveIssue('ENG-1', 'Canceled')
  await pollAndSchedule(f, wall)
  expect(queueRow(taskTitled(f, 'ENG-3 Use both'))).toEqual({ status: 'waiting', blockedOn: 'blocked by ENG-2 (In Progress)', attempts: 0 })
})

test('a blocker in another team blocks the issue, and Factory never takes the blocker', async () => {
  await addIssue('Open firewall', { team: 'OPS' })
  await addIssue('Call partner API', { blockedBy: ['OPS-1'] })
  const wall = wallClock()
  const f = oneSlot(wall)
  await start(f)
  expect(Object.values(f.world().tasks).map(queueRow)).toEqual([{ status: 'waiting', blockedOn: 'blocked by OPS-1 (Todo)', attempts: 0 }])

  await moveIssue('OPS-1', 'Done')
  await pollAndSchedule(f, wall)
  expect(Object.values(f.world().tasks).map((t) => [t.title, t.status])).toEqual([['ENG-1 Call partner API', 'running']])
  expect(Object.keys(f.world().intake)).toEqual(['issue-eng-1'])
  expect(await linearState('OPS-1')).toBe('Done')
})

test('a blocker added in Linear holds a queued issue on the next poll, and removing it returns the issue to the queue', async () => {
  await addIssue('Add export')
  await addIssue('Tidy logs')
  await addIssue('Ship schema', { state: 'In Progress' })
  const wall = wallClock()
  const f = oneSlot(wall)
  await start(f)
  expect(queueRow(taskTitled(f, 'ENG-2 Tidy logs'))).toEqual({ status: 'queued', blockedOn: null, attempts: 0 })

  await control({ op: 'block', identifier: 'ENG-2', blockedBy: 'ENG-3' })
  await pollAndSchedule(f, wall)
  expect(queueRow(taskTitled(f, 'ENG-2 Tidy logs'))).toEqual({ status: 'waiting', blockedOn: 'blocked by ENG-3 (In Progress)', attempts: 0 })

  await control({ op: 'unblock', identifier: 'ENG-2', blockedBy: 'ENG-3' })
  await pollAndSchedule(f, wall)
  expect(queueRow(taskTitled(f, 'ENG-2 Tidy logs'))).toEqual({ status: 'queued', blockedOn: null, attempts: 0 })
  expect(f.world().intake[ENG_2].blockers).toEqual([])
})

test('a blocked issue stays waiting with the same reason after a restart', async () => {
  await addIssue('Ship schema', { state: 'In Review' })
  await addIssue('Use schema', { blockedBy: ['ENG-1'] })
  const store = memoryStore()
  const wall = wallClock()
  const first = makeFixture({ store, linear: client(), clock: wall.read })
  linearTrigger(first, first.agent('Coder'))
  await start(first)
  first.server.flush()

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wall.read })
  expect(queueRow(taskTitled(second, 'ENG-2 Use schema'))).toEqual({ status: 'waiting', blockedOn: 'blocked by ENG-1 (In Review)', attempts: 0 })
  await start(second)
  expect(queueRow(taskTitled(second, 'ENG-2 Use schema'))).toEqual({ status: 'waiting', blockedOn: 'blocked by ENG-1 (In Review)', attempts: 0 })
  expect(Object.values(second.world().runs).filter((r) => r.title === 'ENG-2 Use schema')).toEqual([])
})

test('an intake record saved before blockers were kept loads with none, and its issue runs', async () => {
  await addIssue('Fix login')
  const store = memoryStore()
  const first = makeFixture({ store, linear: client(), clock: wallClock().read })
  const coder = first.agent('Coder')
  first.api.agents.setPaused(coder, true)
  linearTrigger(first, coder)
  await step(first, 0)
  first.server.flush()
  const saved = JSON.parse(store.text!) as { intake: Record<string, Record<string, unknown>> }
  delete saved.intake[ENG_1].blockers
  store.text = JSON.stringify(saved)

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wallClock().read })
  expect(second.world().intake[ENG_1]).toMatchObject({ phase: 'taken', blockers: [] })
  second.api.agents.setPaused(second.agent('Coder'), false)
  await step(second, 1)
  expect(queueRow(taskTitled(second, 'ENG-1 Fix login'))).toEqual({ status: 'running', blockedOn: null, attempts: 1 })
})

test('a blocked issue moved by hand to the trigger’s started state still follows its blockers and starts once they are done', async () => {
  await addIssue('Ship schema', { state: 'In Review' })
  await addIssue('Use schema', { blockedBy: ['ENG-1'] })
  const wall = wallClock()
  const f = oneSlot(wall)
  await start(f)
  expect(taskTitled(f, 'ENG-2 Use schema').blockedOn).toBe('blocked by ENG-1 (In Review)')

  await moveIssue('ENG-2', 'In Progress')
  await pollAndSchedule(f, wall)
  expect(queueRow(taskTitled(f, 'ENG-2 Use schema'))).toEqual({ status: 'waiting', blockedOn: 'blocked by ENG-1 (In Review)', attempts: 0 })
  expect(f.world().intake[ENG_2].cancel).toBeNull()

  await moveIssue('ENG-1', 'Done')
  await pollAndSchedule(f, wall)
  expect(queueRow(taskTitled(f, 'ENG-2 Use schema'))).toEqual({ status: 'running', blockedOn: null, attempts: 1 })
})

test('issueStates reads each issue’s state, priority and blockers', async () => {
  await addIssue('Ship schema', { team: 'OPS', state: 'In Progress' })
  await addIssue('Use schema', { priority: URGENT, blockedBy: ['OPS-1'] })
  expect([...(await client().issueStates(['issue-eng-1' as IssueId]))]).toEqual([['issue-eng-1', {
    state: { id: 'state-eng-todo', name: 'Todo', type: 'unstarted' },
    priority: 'high',
    blockers: [{ id: 'issue-ops-1', identifier: 'OPS-1', url: 'https://linear.app/fake/issue/OPS-1/ship-schema', state: { name: 'In Progress', type: 'started' } }],
    moreRelations: false,
  }]])
})

test('an issue with more than 100 relations logs one warning per poll that the rest are not read', async () => {
  const blockers: string[] = []
  for (let n = 1; n <= 101; n++) {
    await addIssue(`Prerequisite ${n}`, { state: 'Backlog' })
    blockers.push(`ENG-${n}`)
  }
  await addIssue('Use everything', { blockedBy: blockers })
  const wall = wallClock()
  const f = oneSlot(wall)
  const warnings = () => f.world().logs.filter((l) => l.level === 'warn').map((l) => l.msg)
  await start(f)
  expect(warnings()).toEqual(['ENG-102: blockers beyond the first 100 relations are not read'])
  expect(f.world().intake['issue-eng-102' as IssueId].blockers).toHaveLength(100)

  await nextPoll(f, wall)
  expect(warnings()).toEqual(['ENG-102: blockers beyond the first 100 relations are not read', 'ENG-102: blockers beyond the first 100 relations are not read'])
})
