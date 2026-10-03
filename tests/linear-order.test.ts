import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { LINEAR_PRIORITY, createLinearClient } from '../server/linear'
import { LINEAR_POLL_MS, type AgentId, type LinearSettings, type Task, type TriggerId } from '../src/domain/types'
import { makeFixture, type Fixture } from './fixture'

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

test('the Linear client reads an unknown priority number as normal', async () => {
  const node = { id: 'issue-1', identifier: 'ENG-1', title: 'Fix login', description: null, url: 'https://linear.app/x/ENG-1', branchName: 'eng-1', priority: 7 }
  const page = { data: { issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } }
  const fetch = () => Promise.resolve(new Response(JSON.stringify(page)))
  const [issue] = await client({ fetch }).issues(LIFECYCLE)
  expect(issue.priority).toBe('normal')
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
