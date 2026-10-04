import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { complexity, startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { createApi } from '../server/api'
import { startFactoryServer } from '../server/http'
import { LinearError, PROJECTS_QUERY, PROJECT_TEAMS_QUERY, createLinearClient, type LinearClient } from '../server/linear'
import { ClaudeRunner } from '../server/runners'
import { MockServer } from '../server/simulation'
import {
  issueOfFlow, recommendedStates,
  type AgentId, type Edge, type EdgeId, type GraphFragment, type IssueId, type LinearSettings, type NodeRef, type SandboxId, type Task, type TaskId, type TriggerId, type WorkflowState,
} from '../src/domain/types'
import { makeFixture, memoryStore, type Fixture } from './fixture'

const KEY = 'lin_api_test_7f3c9e2a'
const ENG: LinearSettings = { team: 'team-eng', project: null, pickupState: 'state-eng-todo', startedState: null, finishedState: null, failedState: null }
const ONE_AGENT = 'A Linear trigger feeds one agent. Join more agents with a handoff edge.'

let fake: FakeLinear
beforeAll(async () => { fake = await startFakeLinear({ apiKey: KEY }) })
afterAll(() => fake.close())
beforeEach(async () => { await control({ op: 'reset' }) })

async function control(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(fake.controlUrl, { method: 'POST', body: JSON.stringify(body) })
  return response.json()
}
const addIssue = (title: string, fields: Record<string, unknown> = {}) => control({ op: 'addIssue', title, ...fields })
const issueQueries = async () => ((await control({ op: 'stats' })) as { requests: Record<string, number> }).requests.FactoryIssues ?? 0

const client = (options: Partial<Parameters<typeof createLinearClient>[0]> = {}) => createLinearClient({ url: fake.url, apiKey: KEY, ...options })

function switchable(initial: LinearClient) {
  let current = initial
  const client: LinearClient = {
    catalog: () => current.catalog(),
    issues: (filter) => current.issues(filter),
    issueStates: (ids) => current.issueStates(ids),
    comments: (issueId) => current.comments(issueId),
    ensureState: (issueId, stateId, from) => current.ensureState(issueId, stateId, from),
    ensureComment: (issueId, commentId, body) => current.ensureComment(issueId, commentId, body),
    ensureAttachment: (issueId, url, title) => current.ensureAttachment(issueId, url, title),
  }
  return { client, use: (next: LinearClient) => { current = next } }
}

function wallClock(start = 1_000_000) {
  const clock = { now: start, read: () => clock.now }
  return clock
}

function linearTrigger(f: Fixture, agent: AgentId, settings: LinearSettings = ENG): TriggerId {
  const id = f.api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
  f.api.triggers.update(id, { kind: 'linear', name: 'Linear intake' })
  expect(f.api.graph.connect(id, agent, 'triggers')).toMatchObject({ ok: true })
  f.api.triggers.update(id, { linear: settings, enabled: true })
  return id
}

async function poll(f: Fixture) {
  f.api.sim.advance(0)
  await f.api.sim.settled()
}

const issueTasks = (f: Fixture): Task[] => Object.values(f.world().tasks).filter((t) => t.origin.kind === 'issue')

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

test('an issue in the pickup state becomes one task on the joined agent', async () => {
  await addIssue('Fix login', { description: 'Users cannot log in after a password reset.' })
  await addIssue('Someday', { state: 'Backlog' })
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const coder = f.agent('Coder')
  const trigger = linearTrigger(f, coder)
  await poll(f)

  const [task] = issueTasks(f)
  expect(issueTasks(f)).toHaveLength(1)
  const issue = { backend: 'linear', id: 'issue-eng-1', identifier: 'ENG-1', url: 'https://linear.app/fake/issue/ENG-1/fix-login', branchName: 'eng-1-fix-login' }
  expect(task).toMatchObject({
    agentId: 'ag-coder',
    title: 'ENG-1 Fix login',
    prompt: 'Fix login\n\nUsers cannot log in after a password reset.\n\nhttps://linear.app/fake/issue/ENG-1/fix-login',
    priority: 'normal',
    status: 'queued',
    origin: { kind: 'issue', trigger, issue },
  })
  expect(f.world().intake).toEqual({ 'issue-eng-1': { issue, trigger, flowId: task.flowId, takenAt: 1_000_000, phase: 'taken', writes: [], states: { pickupState: 'state-eng-todo', startedState: null }, cancel: null, blockers: [],
    round: 1, rework: null, result: null, left: false, past: [] } })
  expect(f.world().intakePolls).toEqual({ [trigger]: { at: 1_000_000, error: null } })
  expect(f.world().triggers[trigger].fired).toBe(1)
  expect(f.world().events.at(-1)?.msg).toBe('Linear intake took ENG-1')
})

test('a project filter takes only that project’s issues', async () => {
  await addIssue('Alpha work', { project: 'Alpha' })
  await addIssue('Beta work', { project: 'Beta' })
  await addIssue('Loose work')
  await addIssue('Alpha later', { project: 'Alpha' })
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  linearTrigger(f, f.agent('Coder'), { ...ENG, project: 'project-alpha' })
  await poll(f)
  expect(issueTasks(f).map((t) => t.title)).toEqual(['ENG-1 Alpha work', 'ENG-4 Alpha later'])
})

test('Linear settings survive a restart from the saved store', async () => {
  const store = memoryStore()
  const settings = {
    team: 'team-eng', project: 'project-beta', pickupState: 'state-eng-in-review',
    startedState: 'state-eng-in-progress', finishedState: 'state-eng-done', failedState: 'state-eng-backlog',
  }
  const first = makeFixture({ store, linear: client(), clock: wallClock().read })
  const trigger = linearTrigger(first, first.agent('Coder'), settings)
  first.server.flush()

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wallClock().read })
  expect(second.world().triggers[trigger]).toMatchObject({ kind: 'linear', enabled: true, linear: settings, name: 'Linear intake' })
  expect(second.world().intakePolls).toEqual({})
})

test('a Linear trigger refuses a second triggers edge from connect, paste and restore', async () => {
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const coder = f.agent('Coder')
  const qa = f.agent('QA')
  const trigger = linearTrigger(f, coder)
  expect(f.api.graph.connect(trigger, qa, 'triggers')).toEqual({ ok: false, reason: ONE_AGENT })

  const restored: Edge = { id: 'ed-restored' as EdgeId, kind: 'triggers', source: trigger, target: qa }
  f.api.graph.restoreEdges([restored])
  expect(f.world().edges['ed-restored' as EdgeId]).toBeUndefined()

  const w = f.world()
  const fragment: GraphFragment = {
    nodes: [
      { kind: 'trigger', node: w.triggers[trigger] },
      { kind: 'agent', node: w.agents[coder] },
      { kind: 'agent', node: w.agents[qa] },
    ] satisfies NodeRef[],
    edges: [
      { id: 'ed-a' as EdgeId, kind: 'triggers', source: trigger, target: coder },
      { id: 'ed-b' as EdgeId, kind: 'triggers', source: trigger, target: qa },
    ],
  }
  const pasted = f.api.graph.paste(fragment, { x: 40, y: 40 })
  const copy = pasted.nodes.find((ref) => ref.kind === 'trigger')!.node
  expect(copy).toMatchObject({ kind: 'linear', enabled: false, linear: ENG })
  expect(pasted.edges.map((e) => e.kind)).toEqual(['triggers'])

  const cron = f.api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
  f.api.graph.connect(cron, coder, 'triggers')
  f.api.graph.connect(cron, qa, 'triggers')
  expect(() => f.api.triggers.update(cron, { kind: 'linear' })).toThrow('A Linear trigger feeds one agent. Remove all but one triggers edge first.')
  expect(f.world().triggers[cron].kind).toBe('manual')
})

test('a handoff from the joined agent keeps the issue’s flow', async () => {
  await addIssue('Plan the import')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const planner = f.agent('Planner')
  const coder = f.agent('Coder')
  f.api.graph.connect(planner, coder, 'handoff')
  linearTrigger(f, planner)
  await poll(f)
  f.api.sim.advance(1)
  f.api.sim.advance(12_500)

  const flowId = f.world().intake['issue-eng-1' as IssueId].flowId
  const handoff = Object.values(f.world().tasks).find((t) => t.origin.kind === 'handoff')!
  expect(handoff.title).toBe('ENG-1 Plan the import → Coder')
  expect(handoff.flowId).toBe(flowId)
  expect(issueOfFlow(f.world(), handoff.flowId)?.identifier).toBe('ENG-1')
})

test('repeated polls on the 30 s wall clock never take an issue twice, and interval firing skips Linear triggers', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  linearTrigger(f, f.agent('Coder'))
  await poll(f)
  expect(await issueQueries()).toBe(1)

  wall.now += 29_999
  f.api.sim.advance(120_000)
  await f.api.sim.settled()
  expect(await issueQueries()).toBe(1)

  wall.now += 1
  await poll(f)
  wall.now += 30_000
  await poll(f)
  expect(await issueQueries()).toBe(3)
  expect(issueTasks(f).map((t) => t.title)).toEqual(['ENG-1 Fix login'])
  expect(Object.values(f.world().tasks).filter((t) => t.origin.kind === 'trigger')).toEqual([])
})

test('an issue taken before a restart is not taken again after it', async () => {
  await addIssue('Fix login')
  const store = memoryStore()
  const first = makeFixture({ store, linear: client(), clock: wallClock().read })
  linearTrigger(first, first.agent('Coder'))
  await poll(first)
  first.server.flush()

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wallClock().read })
  await poll(second)
  expect(await issueQueries()).toBe(2)
  expect(issueTasks(second).map((t) => t.title)).toEqual(['ENG-1 Fix login'])
  expect(Object.keys(second.world().intake)).toEqual(['issue-eng-1'])
})

test('an issue whose task retention pruned is still not taken again', async () => {
  await addIssue('Fix login')
  const store = memoryStore()
  const first = makeFixture({ store, linear: client(), clock: wallClock().read })
  linearTrigger(first, first.agent('Coder'))
  await poll(first)
  const [task] = issueTasks(first)
  first.api.tasks.cancel(task.id)
  first.server.flush()

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wallClock().read })
  expect(second.world().tasks[task.id]).toBeUndefined()
  expect(second.world().intake['issue-eng-1' as IssueId].flowId).toBe(task.flowId)
  await poll(second)
  expect(await issueQueries()).toBe(2)
  expect(issueTasks(second)).toEqual([])
})

test('a disabled Linear trigger and a paused simulation never poll', async () => {
  await addIssue('Fix login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  f.api.triggers.update(trigger, { enabled: false })
  await poll(f)
  await f.api.triggers.fire(trigger)

  f.api.triggers.update(trigger, { enabled: true })
  f.api.sim.set({ paused: true })
  await poll(f)
  await f.api.triggers.fire(trigger)

  expect(await issueQueries()).toBe(0)
  expect(issueTasks(f)).toEqual([])
  expect(f.world().intakePolls).toEqual({})
})

test('Fire polls a Linear trigger at once', async () => {
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  await poll(f)
  await addIssue('Fix login')
  await f.api.triggers.fire(trigger)
  expect(await issueQueries()).toBe(2)
  expect(issueTasks(f).map((t) => t.title)).toEqual(['ENG-1 Fix login'])
})

test('a poll that finishes after its trigger was disabled is discarded', async () => {
  await addIssue('Fix login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  f.api.sim.advance(0)
  f.api.triggers.update(trigger, { enabled: false })
  await f.api.sim.settled()
  expect(await issueQueries()).toBe(1)
  expect(issueTasks(f)).toEqual([])
  expect(f.world().intake).toEqual({})
  expect(f.world().intakePolls).toEqual({})
})

test('a Linear trigger with no joined agent takes nothing until it has one', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  f.api.graph.removeEdges(Object.values(f.world().edges).filter((e) => e.source === trigger).map((e) => e.id))
  await poll(f)
  expect(issueTasks(f)).toEqual([])
  expect(f.world().intakePolls[trigger]).toEqual({ at: 1_000_000, error: null })

  f.api.graph.connect(trigger, f.agent('QA'), 'triggers')
  await f.api.triggers.fire(trigger)
  expect(issueTasks(f).map((t) => [t.title, t.agentId])).toEqual([['ENG-1 Fix login', 'ag-qa']])
})

const failures: Array<[string, { kind: string; message: string }, () => { start: LinearClient; fix: () => Promise<LinearClient> }]> = [
  ['a missing key', { kind: 'missing-key', message: 'LINEAR_API_KEY is not set' }, () => ({ start: client({ apiKey: undefined }), fix: async () => client() })],
  ['a 401', { kind: 'auth', message: 'Linear rejected LINEAR_API_KEY (HTTP 401)' }, () => ({
    start: client(),
    fix: async () => { await control({ op: 'failAuth', on: false }); return client() },
  })],
  ['a network failure', { kind: 'network', message: 'Could not reach Linear: fetch failed' }, () => ({
    start: client({ fetch: () => Promise.reject(new TypeError('fetch failed')) }),
    fix: async () => client(),
  })],
]

test.each(failures)('%s is recorded on the trigger while the factory keeps running, and the next good poll clears it', async (_label, error, setup) => {
  await addIssue('Fix login')
  if (error.kind === 'auth') await control({ op: 'failAuth', on: true })
  const { start, fix } = setup()
  const linear = switchable(start)
  const wall = wallClock()
  const f = makeFixture({ linear: linear.client, clock: wall.read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  f.api.triggers.update('tr-cron' as TriggerId, { enabled: true })
  await poll(f)
  expect(f.world().intakePolls[trigger]).toEqual({ at: 1_000_000, error })
  expect(issueTasks(f)).toEqual([])

  f.api.sim.advance(18_000)
  expect(Object.values(f.world().tasks).filter((t) => t.origin.kind === 'trigger').map((t) => t.agentId)).toEqual(['ag-planner'])
  const manual = f.api.agents.enqueue(f.agent('Reviewer'), { title: 'review by hand', prompt: 'p', priority: 'normal' })
  f.api.sim.advance(1)
  expect(f.task(manual as TaskId).status).toBe('running')

  linear.use(await fix())
  wall.now += 30_000
  await poll(f)
  expect(f.world().intakePolls[trigger]).toEqual({ at: 1_030_000, error: null })
  expect(issueTasks(f).map((t) => t.title)).toEqual(['ENG-1 Fix login'])
})

test('the API key reaches neither the published world nor the saved world', async () => {
  await addIssue('Fix login')
  const store = memoryStore()
  const f = makeFixture({ store, linear: client(), clock: wallClock().read })
  linearTrigger(f, f.agent('Coder'))
  await poll(f)
  expect(issueTasks(f)).toHaveLength(1)
  f.server.flush()
  expect(JSON.stringify(f.server.snapshot())).not.toContain(KEY)
  expect(store.text).not.toBeNull()
  expect(store.text).not.toContain(KEY)
})

const MAIN_WORLD = {
  now: 5000,
  agents: {
    'ag-1': {
      id: 'ag-1', name: 'Builder', role: 'implementer', model: 'claude-sonnet-5', temperature: 0.3, concurrency: 1, timeoutMs: 120000,
      retry: { maxAttempts: 2, backoffMs: 1000, backoff: 'fixed' }, tools: ['bash'], systemPrompt: 'Build it.', status: 'idle',
      position: { x: 10, y: 20 }, completed: 1, failed: 0, groupId: 'gr-1',
    },
  },
  sandboxes: {
    'sb-1': {
      id: 'sb-1', name: 'builder-a', kind: 'docker', host: 'docker.internal', image: 'ghcr.io/factory/dev:node22', state: 'running', stateSince: 5000,
      progress: 1, metrics: { cpu: 4, mem: 20, disk: 31 }, history: [], leases: [], capacity: 2, restartPending: false, position: { x: 10, y: 400 }, groupId: null,
    },
  },
  triggers: {
    'tr-1': {
      id: 'tr-1', name: 'Nightly sweep', kind: 'cron', intervalMs: 18000, enabled: false, lastFiredAt: null, fired: 3,
      template: 'Sweep open issues', position: { x: -200, y: 20 }, groupId: 'gr-1',
    },
  },
  edges: {
    'ed-1': { id: 'ed-1', kind: 'triggers', source: 'tr-1', target: 'ag-1' },
    'ed-2': { id: 'ed-2', kind: 'runs-in', source: 'ag-1', target: 'sb-1' },
  },
  groups: { 'gr-1': { id: 'gr-1', name: 'Group 1' } },
  sim: { paused: true, speed: 2 },
  tasks: {
    'tk-1': {
      id: 'tk-1', flowId: 'fl-1', agentId: 'ag-1', title: 'Sweep open issues', prompt: 'Sweep open issues\n\nTriggered by Nightly sweep.', priority: 'normal',
      status: 'succeeded', origin: { kind: 'trigger', id: 'tr-1' }, input: null, createdAt: 1000, attempts: 1, retryAt: null, blockedOn: null,
    },
    'tk-2': {
      id: 'tk-2', flowId: 'fl-2', agentId: 'ag-1', title: 'by hand', prompt: 'p', priority: 'high',
      status: 'queued', origin: { kind: 'manual' }, input: null, createdAt: 4000, attempts: 0, retryAt: null, blockedOn: null,
    },
  },
  runs: {
    'run-1': {
      id: 'run-1', taskId: 'tk-1', agentId: 'ag-1', sandboxId: 'sb-1', title: 'Sweep open issues', attempt: 1, status: 'succeeded', execution: 'simulated',
      progress: 1, durationMs: 12500, startedAt: 1000, endedAt: 13500, tokens: 4250,
      output: { summary: 'The implementer completed "Sweep open issues".', artifacts: [{ kind: 'note', label: 'Completion note', url: null }] }, error: null,
    },
  },
  events: [{ id: 7, ts: 13500, kind: 'run', subject: { kind: 'run', id: 'run-1' }, msg: 'Builder finished “Sweep open issues”' }],
}

test('a world file saved by main loads with every record intact, agents that do not deliver, and an empty intake', () => {
  const store = memoryStore()
  store.text = JSON.stringify(MAIN_WORLD)
  const f = makeFixture({ store, isolate: false })
  const w = f.world()
  expect(w.now).toBe(5000)
  expect(w.sim).toEqual({ paused: true, speed: 2 })
  expect(w.agents).toEqual({ 'ag-1': { ...MAIN_WORLD.agents['ag-1'], delivery: 'none' } })
  expect(w.sandboxes).toEqual(MAIN_WORLD.sandboxes)
  expect(w.triggers).toEqual({ 'tr-1': { ...MAIN_WORLD.triggers['tr-1'], linear: null } })
  expect(w.edges).toEqual(MAIN_WORLD.edges)
  expect(w.groups).toEqual(MAIN_WORLD.groups)
  expect(w.tasks).toEqual(MAIN_WORLD.tasks)
  expect(w.runs).toEqual(MAIN_WORLD.runs)
  expect(w.events).toEqual(MAIN_WORLD.events)
  expect(w.intake).toEqual({})
  expect(w.intakePolls).toEqual({})

  f.server.flush()
  const saved = JSON.parse(store.text!) as { intake: unknown; triggers: Record<string, { linear: unknown }> }
  expect(saved.intake).toEqual({})
  expect(saved.triggers['tr-1'].linear).toBeNull()
})

test('Linear settings saved before lifecycle states load with every state left alone', () => {
  const store = memoryStore()
  const saved = { team: 'team-eng', project: null, pickupState: 'state-eng-todo' }
  store.text = JSON.stringify({ ...MAIN_WORLD, triggers: { 'tr-1': { ...MAIN_WORLD.triggers['tr-1'], kind: 'linear', linear: saved } } })
  const f = makeFixture({ store, isolate: false })
  expect(f.world().triggers['tr-1' as TriggerId].linear).toEqual({ ...saved, startedState: null, finishedState: null, failedState: null })
})

test('the recommended states follow the team workflow by position', async () => {
  const withReview: WorkflowState[] = [
    { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 's-ready', name: 'Ready', type: 'unstarted', position: 3 },
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
    { id: 's-review', name: 'Code review', type: 'started', position: 5 },
    { id: 's-doing', name: 'In Progress', type: 'started', position: 4 },
    { id: 's-done', name: 'Done', type: 'completed', position: 6 },
  ]
  expect(recommendedStates(withReview)).toEqual({ pickupState: 's-todo', startedState: 's-doing', finishedState: 's-review', failedState: null })

  const withoutReview: WorkflowState[] = [
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
    { id: 's-doing', name: 'Doing', type: 'started', position: 1 },
    { id: 's-done', name: 'Done', type: 'completed', position: 2 },
    { id: 's-canceled', name: 'Canceled', type: 'canceled', position: 3 },
  ]
  expect(recommendedStates(withoutReview)).toEqual({ pickupState: 's-todo', startedState: 's-doing', finishedState: null, failedState: null })
  expect(recommendedStates([{ id: 's-done', name: 'Done', type: 'completed', position: 0 }]))
    .toEqual({ pickupState: null, startedState: null, finishedState: null, failedState: null })

  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const catalog = await f.api.linear.catalog()
  expect(catalog.teams.map((t) => [t.key, t.name, t.projects.map((p) => p.name)]))
    .toEqual([['ENG', 'Engineering', ['Alpha', 'Beta', 'Shared']], ['OPS', 'Operations', []], ['KAT', 'Kata', ['Shared', 'Gamma']]])
  expect(catalog.teams[0].states.map((s) => s.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled', 'Duplicate'])
  expect(recommendedStates(catalog.teams[0].states))
    .toEqual({ pickupState: 'state-eng-todo', startedState: 'state-eng-in-progress', finishedState: 'state-eng-in-review', failedState: null })
  expect(catalog.teams[2].states.map((s) => s.name))
    .toEqual(['Backlog', 'Todo', 'Start', 'In Progress', 'Agent Review', 'Human Review', 'Merging', 'Done', 'Canceled', 'Duplicate'])
  expect(recommendedStates(catalog.teams[2].states))
    .toEqual({ pickupState: 'state-kat-start', startedState: 'state-kat-in-progress', finishedState: 'state-kat-agent-review', failedState: null })
})

test('the catalog reads every page of teams, states and projects, each under Linear\'s complexity limit', async () => {
  const catalog = await client({ pageSize: 1 }).catalog()
  expect(catalog.teams.map((t) => [t.key, t.states.length, t.projects.map((p) => p.id)]))
    .toEqual([['ENG', 7, ['project-alpha', 'project-beta', 'project-shared']], ['OPS', 7, []], ['KAT', 10, ['project-shared', 'project-gamma']]])
  expect(catalog.teams[2].states[2]).toEqual({ id: 'state-kat-start', name: 'Start', type: 'unstarted', position: 2 })
  expect(((await control({ op: 'stats' })) as { requests: Record<string, number> }).requests)
    .toEqual({ FactoryTeams: 3, FactoryWorkflowStates: 24, FactoryProjects: 4 })

  const nested = 'query { teams(first: 100) { nodes { id states(first: 100) { nodes { id } } projects(first: 100) { nodes { id } } } } }'
  expect(complexity(nested, {})).toBe(20_100)
  expect(complexity('query { teams(first: 100) { nodes { id states { nodes { id } } } } }', {})).toBe(5_100)
  expect(complexity(PROJECTS_QUERY, { first: 50 })).toBe(550)
  expect(complexity(PROJECT_TEAMS_QUERY, { first: 50 })).toBe(50)
})

test('the catalog lists a project under every team it is shared with, past the first page of its teams', async () => {
  for (let n = 1; n <= 51; n++) await control({ op: 'addTeam', key: `T${n}`, projects: ['Shared'] })
  const catalog = await client().catalog()
  expect(catalog.teams).toHaveLength(54)
  expect(catalog.teams.filter((t) => t.projects.some((p) => p.id === 'project-shared')).map((t) => t.key))
    .toEqual(['ENG', 'KAT', ...Array.from({ length: 51 }, (_, i) => `T${i + 1}`)])
  expect(((await control({ op: 'stats' })) as { requests: Record<string, number> }).requests)
    .toEqual({ FactoryTeams: 2, FactoryWorkflowStates: 8, FactoryProjects: 1, FactoryProjectTeams: 2 })
})

test('the recommended pickup is Start when the workflow has one, else the first unstarted state', () => {
  const pickup = (states: WorkflowState[]) => recommendedStates(states).pickupState
  expect(pickup([
    { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 's-start', name: 'Start', type: 'unstarted', position: 2 },
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
    { id: 's-doing', name: 'In Progress', type: 'started', position: 3 },
  ])).toBe('s-start')
  expect(pickup([
    { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
    { id: 's-restarted', name: 'Restarted', type: 'unstarted', position: 2 },
    { id: 's-doing', name: 'In Progress', type: 'started', position: 3 },
  ])).toBe('s-todo')
  expect(pickup([
    { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 's-start', name: 'Start', type: 'started', position: 1 },
    { id: 's-done', name: 'Done', type: 'completed', position: 2 },
  ])).toBeNull()
})

test('a new Linear trigger starts disabled, and preview pages through every match', async () => {
  for (let i = 1; i <= 7; i++) await addIssue(`Task ${i}`)
  await addIssue('Not yet', { state: 'Backlog' })
  const f = makeFixture({ linear: client({ pageSize: 3 }), clock: wallClock().read })
  const id = f.api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
  expect(f.world().triggers[id].enabled).toBe(true)
  f.api.triggers.update(id, { kind: 'linear' })
  expect(f.world().triggers[id]).toMatchObject({ kind: 'linear', enabled: false, linear: null })
  expect(() => f.api.triggers.update(id, { enabled: true })).toThrow('Choose a team and pickup state before enabling a Linear trigger.')
  expect(f.world().triggers[id].enabled).toBe(false)

  expect(await f.api.linear.preview(ENG)).toEqual({
    count: 7,
    issues: [1, 2, 3, 4, 5].map((n) => ({ identifier: `ENG-${n}`, title: `Task ${n}`, url: `https://linear.app/fake/issue/ENG-${n}/task-${n}` })),
  })

  f.api.triggers.update(id, { linear: ENG })
  f.api.triggers.update(id, { kind: 'cron' })
  expect(f.world().triggers[id]).toMatchObject({ kind: 'cron', linear: null })
})

test('the Linear client sends the key without Bearer and classifies a rejected key as auth', async () => {
  await expect(client({ apiKey: 'lin_api_wrong' }).catalog()).rejects.toMatchObject({
    intake: { kind: 'auth', message: 'Linear rejected LINEAR_API_KEY: Authentication required, not authenticated' },
  })
  await expect(client({ apiKey: undefined }).issues(ENG)).rejects.toBeInstanceOf(LinearError)
  expect(((await control({ op: 'stats' })) as { requests: Record<string, number> }).requests)
    .toEqual({ FactoryTeams: 1, FactoryWorkflowStates: 1, FactoryProjects: 1 })
})

test('the Linear client stops with an api error when Linear repeats a pagination cursor', async () => {
  const page = { data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } } } }
  const fetch = () => Promise.resolve(new Response(JSON.stringify(page)))
  await expect(client({ fetch }).issues(ENG)).rejects.toMatchObject({ intake: { kind: 'api', message: 'Linear repeated a pagination cursor' } })
})

test('the fake Linear rejects an unknown cursor instead of restarting at page one', async () => {
  const response = await fetch(fake.url, {
    method: 'POST',
    headers: { authorization: KEY },
    body: JSON.stringify({ operationName: 'FactoryIssues', variables: { filter: {}, first: 1, after: 'issue-gone' } }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ errors: [{ message: 'invalid cursor issue-gone' }] })
})

test('linear commands answer over HTTP and reject with the intake error message', async () => {
  await addIssue('Fix login')
  const ORIGIN = 'http://localhost:5173'
  const post = async (simulation: MockServer, method: string, args: unknown[]) => {
    const running = await startFactoryServer(simulation, { port: 0, origins: [ORIGIN] })
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/command`, {
        method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }),
      })
      return { status: response.status, body: await response.json() as { ok: boolean; result?: unknown; error?: string } }
    } finally {
      await running.close()
      await simulation.close()
    }
  }
  const preview = await post(new MockServer({ manual: true, linear: client() }), 'linear.preview', [ENG])
  expect(preview.status).toBe(200)
  expect(preview.body.result).toEqual({ count: 1, issues: [{ identifier: 'ENG-1', title: 'Fix login', url: 'https://linear.app/fake/issue/ENG-1/fix-login' }] })
  const missing = await post(new MockServer({ manual: true }), 'linear.catalog', [])
  expect(missing).toEqual({ status: 400, body: { ok: false, error: 'LINEAR_API_KEY is not set' } })
})

test('an intake task runs on a local sandbox with the Claude CLI to success', async () => {
  await addIssue('Fix login', { description: 'Users cannot log in.' })
  const root = mkdtempSync(join(tmpdir(), 'factory-intake-'))
  const executable = join(root, 'fake-claude')
  writeFileSync(executable, `#!/usr/bin/env node
require('node:fs').writeFileSync('prompt.txt', process.argv.at(-1))
console.log(JSON.stringify({ type: 'result', result: 'fixed', is_error: false, usage: { input_tokens: 3, output_tokens: 2 } }))
`)
  chmodSync(executable, 0o755)
  const server = new MockServer({ manual: true, localRunner: new ClaudeRunner(executable), localRoot: root, linear: client(), clock: wallClock().read })
  try {
    const api = createApi(server)
    for (const tr of Object.values(server.snapshot().triggers)) api.triggers.update(tr.id, { enabled: false })
    const coder = 'ag-coder' as AgentId
    api.graph.removeEdges(Object.values(server.snapshot().edges).filter((e) => e.kind === 'handoff' || (e.kind === 'runs-in' && e.source === coder)).map((e) => e.id))
    api.graph.connect(coder, 'sb-local-1' as SandboxId, 'runs-in')
    const trigger = api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
    api.triggers.update(trigger, { kind: 'linear' })
    api.graph.connect(trigger, coder, 'triggers')
    api.triggers.update(trigger, { linear: ENG, enabled: true })
    api.sim.advance(0)
    await api.sim.settled()
    api.sim.advance(1)
    const run = Object.values(server.snapshot().runs)[0]
    expect([run.title, run.execution]).toEqual(['ENG-1 Fix login', 'local'])
    await until(() => server.snapshot().runs[run.id].status === 'succeeded')
    expect(server.snapshot().runs[run.id].output?.summary).toBe('fixed')
    expect(server.snapshot().tasks[run.taskId].status).toBe('succeeded')
    expect(readFileSync(join(root, '.factory-runs', run.id, 'prompt.txt'), 'utf8')).toBe('Fix login\n\nUsers cannot log in.\n\nhttps://linear.app/fake/issue/ENG-1/fix-login')
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
