import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { createLinearClient, type IssueState, type LinearClient } from '../server/linear'
import { flowAction, reconcileRecord } from '../server/writeBack'
import { LINEAR_POLL_MS, type AgentId, type FlowId, type IntakeRecord, type IssueId, type LinearSettings, type Run, type Task, type TaskId, type TriggerId, type World } from '../src/domain/types'
import { makeFixture, memoryStore, type Fixture } from './fixture'

const KEY = 'lin_api_test_cancel'

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
const issue = (identifier: string) => control({ op: 'issue', identifier }) as Promise<{ state: string; comments: Array<{ id: string; body: string }> }>
const requests = async () => ((await control({ op: 'stats' })) as { requests: Record<string, number> }).requests

const client = () => createLinearClient({ url: fake.url, apiKey: KEY })
const ENG_1 = 'issue-eng-1' as IssueId
const ENG_2 = 'issue-eng-2' as IssueId
const LIFECYCLE: LinearSettings = {
  team: 'team-eng', project: null, pickupState: 'state-eng-todo',
  startedState: 'state-eng-in-progress', finishedState: 'state-eng-in-review', failedState: 'state-eng-backlog',
}

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

/** Takes the pickup issues and starts their first runs. */
async function start(f: Fixture) {
  await step(f, 0)
  await step(f, 1)
}

/** Lets one poll interval of wall time pass, so the next tick polls again. */
async function nextPoll(f: Fixture, wall: { now: number }) {
  wall.now += LINEAR_POLL_MS
  await step(f, 1)
}

const runsInOrder = (f: Fixture): Run[] => Object.values(f.world().runs).sort((a, b) => a.startedAt - b.startedAt)
const writeSteps = (f: Fixture, id: IssueId = ENG_1) =>
  f.world().intake[id].writes.map((w) => [w.kind === 'move' ? `move ${w.step}` : `note ${w.outcome}`, w.status.state])

const state = (name: string, type: IssueState['type']): IssueState => ({ id: `state-eng-${name.toLowerCase().replace(/\s+/g, '-')}`, name, type })
const TODO = state('Todo', 'unstarted')
const IN_PROGRESS = state('In Progress', 'started')
const CANCELED = state('Canceled', 'canceled')
const BACKLOG = state('Backlog', 'backlog')
const DONE = state('Done', 'completed')

test.each([
  ['in the pickup state', TODO, true, { kind: 'none' }],
  ['in the started state', IN_PROGRESS, true, { kind: 'none' }],
  ['in a canceled state', CANCELED, true, { kind: 'cancel', reason: 'canceled in Linear' }],
  ['deleted', null, true, { kind: 'cancel', reason: 'canceled in Linear' }],
  ['moved to a backlog state', BACKLOG, true, { kind: 'cancel', reason: 'moved to Backlog in Linear' }],
  ['moved to a completed state', DONE, true, { kind: 'cancel', reason: 'moved to Done in Linear' }],
  ['in the pickup state with its flow ended', TODO, false, { kind: 'none' }],
  ['in a canceled state with its flow ended', CANCELED, false, { kind: 'none' }],
  ['deleted with its flow ended', null, false, { kind: 'none' }],
  ['moved elsewhere with its flow ended', BACKLOG, false, { kind: 'none' }],
] as const)('an issue %s: flowAction decides %j', (_label, issueState, open, action) => {
  expect(flowAction(issueState, open, LIFECYCLE)).toEqual(action)
})

test('without a started state, an issue moved to a started state has left the trigger', () => {
  expect(flowAction(IN_PROGRESS, true, { pickupState: TODO.id, startedState: null })).toEqual({ kind: 'cancel', reason: 'moved to In Progress in Linear' })
})

test('an issue canceled in Linear stops its running flow within one poll, with one note and no state write', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const coder = f.agent('Coder')
  const trigger = linearTrigger(f, coder)
  await start(f)
  const [run] = runsInOrder(f)
  expect(run.status).toBe('running')
  expect((await issue('ENG-1')).state).toBe('In Progress')

  await moveIssue('ENG-1', 'Canceled')
  await nextPoll(f, wall)
  expect(f.world().runs[run.id]).toMatchObject({ status: 'cancelled', error: 'canceled in Linear' })
  expect(f.world().tasks[run.taskId]).toMatchObject({ status: 'cancelled', retryAt: null })
  expect(f.world().intake[ENG_1]).toMatchObject({ phase: 'ended', cancel: { kind: 'linear', reason: 'canceled in Linear' } })
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['note cancelled', 'landed']])
  expect(f.world().intakePolls[trigger].error).toBeNull()
  expect(f.world().events.map((e) => e.msg)).toContain('ENG-1 canceled in Linear: cancelled its flow')

  const after = await issue('ENG-1')
  expect(after.state).toBe('Canceled')
  expect(after.comments.map((c) => c.body)).toEqual([
    `**Factory stopped work on this issue: canceled in Linear.**\n\n**Coder** · run ${run.id}\nCancelled before it finished.\n\nSigned by Factory. Runs: ${run.id}. Agents: Coder.`,
  ])

  await step(f, 60_000)
  await nextPoll(f, wall)
  expect(runsInOrder(f)).toHaveLength(1)
  expect((await issue('ENG-1')).comments).toHaveLength(1)
  expect(await requests()).toMatchObject({ FactoryMoveIssue: 1, FactoryCreateComment: 1 })
})

test('a queued issue moved out of the pickup state leaves the queue cancelled without starting, and its note names the state', async () => {
  await addIssue('Fix login')
  await addIssue('Fix logout')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const coder = f.agent('Coder')
  f.api.agents.update(coder, { concurrency: 1 })
  linearTrigger(f, coder)
  await start(f)
  const queued = Object.values(f.world().tasks).find((t) => t.title === 'ENG-2 Fix logout')!
  expect(queued.status).toBe('queued')

  await moveIssue('ENG-2', 'Backlog')
  await nextPoll(f, wall)
  expect(f.world().tasks[queued.id]).toMatchObject({ status: 'cancelled', attempts: 0 })
  expect(Object.values(f.world().runs).some((r) => r.taskId === queued.id)).toBe(false)
  expect(runsInOrder(f).map((r) => r.status)).toEqual(['running'])
  expect(writeSteps(f, ENG_2)).toEqual([['note cancelled', 'landed']])

  const after = await issue('ENG-2')
  expect(after.state).toBe('Backlog')
  expect(after.comments.map((c) => c.body)).toEqual([
    '**Factory stopped work on this issue: moved to Backlog in Linear.**\n\n**Coder**\nCancelled before it finished.\n\nSigned by Factory. Runs: none. Agents: Coder.',
  ])
})

test('a deleted issue cancels its flow and the trigger stays healthy', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  await start(f)
  const [run] = runsInOrder(f)

  await control({ op: 'deleteIssue', identifier: 'ENG-1' })
  await nextPoll(f, wall)
  expect(f.world().runs[run.id].status).toBe('cancelled')
  expect(f.world().intakePolls[trigger]).toEqual({ at: wall.now, error: null })
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['note cancelled', 'landed']])
  expect((await issue('ENG-1')).comments[0].body).toMatch(/^\*\*Factory stopped work on this issue: canceled in Linear\.\*\*/)

  await nextPoll(f, wall)
  expect(f.world().intakePolls[trigger].error).toBeNull()
})

test('cancelling one task of a flow in Factory cancels the whole flow and moves the issue to the failed state with one note', async () => {
  await addIssue('Plan the import')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const planner = f.agent('Planner')
  const coder = f.agent('Coder')
  const reviewer = f.agent('Reviewer')
  f.api.graph.connect(planner, coder, 'handoff')
  f.api.graph.connect(planner, reviewer, 'handoff')
  f.api.agents.setPaused(reviewer, true)
  linearTrigger(f, planner)
  await start(f)
  await step(f, 12_500)
  const [plannerRun, coderRun] = runsInOrder(f)
  expect([plannerRun.status, coderRun.status]).toEqual(['succeeded', 'running'])
  const review = Object.values(f.world().tasks).find((t) => t.agentId === reviewer)!
  expect(review.status).toBe('queued')

  f.api.tasks.cancel(review.id)
  await f.api.sim.settled()
  expect(f.world().runs[coderRun.id]).toMatchObject({ status: 'cancelled', error: 'cancelled by operator' })
  expect(f.world().tasks[review.id].status).toBe('cancelled')
  expect(f.world().intake[ENG_1]).toMatchObject({ phase: 'ended', cancel: { kind: 'factory', task: review.title } })
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['move failed', 'landed'], ['note cancelled', 'landed']])

  const after = await issue('ENG-1')
  expect(after.state).toBe('Backlog')
  expect(after.comments).toHaveLength(1)
  expect(after.comments[0].body.split('\n\n')[0]).toBe(`**Factory stopped work on this issue: “${review.title}” was cancelled in Factory.**`)

  await nextPoll(f, wall)
  expect((await issue('ENG-1')).comments).toHaveLength(1)
})

test('a Factory move still waiting to retry is dropped once the issue leaves the trigger’s states', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  linearTrigger(f, f.agent('Coder'))
  await control({ op: 'failNext', operation: 'FactoryMoveIssue', times: 1, message: 'rate limited' })
  await start(f)
  expect(writeSteps(f)).toEqual([['move started', 'failed']])

  await moveIssue('ENG-1', 'Backlog')
  await nextPoll(f, wall)
  expect(writeSteps(f)).toEqual([['move started', 'dropped'], ['note cancelled', 'landed']])
  await nextPoll(f, wall)
  expect((await issue('ENG-1')).state).toBe('Backlog')
  expect(await requests()).toMatchObject({ FactoryMoveIssue: 1 })
})

test('a finished move is dropped when a person moved the issue before the flow ended', async () => {
  await addIssue('Fix login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  linearTrigger(f, f.agent('Coder'))
  await start(f)
  await moveIssue('ENG-1', 'Done')
  await step(f, 12_500)
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['move finished', 'dropped'], ['note finished', 'landed']])
  expect((await issue('ENG-1')).state).toBe('Done')
})

test('a refresh that fails shows its error on the trigger and leaves the flow running', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  await start(f)
  await moveIssue('ENG-1', 'Canceled')
  await control({ op: 'failNext', operation: 'FactoryIssueStates', times: 1, message: 'rate limited' })
  await nextPoll(f, wall)
  expect(f.world().intakePolls[trigger].error).toEqual({ kind: 'api', message: 'Linear error: rate limited' })
  expect(runsInOrder(f).map((r) => r.status)).toEqual(['running'])

  await nextPoll(f, wall)
  expect(f.world().intakePolls[trigger].error).toBeNull()
  expect(runsInOrder(f).map((r) => r.status)).toEqual(['cancelled'])
})

test('a cancelled issue moved back to the pickup state starts no new flow', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  await start(f)
  await moveIssue('ENG-1', 'Canceled')
  await nextPoll(f, wall)
  await moveIssue('ENG-1', 'Todo')
  await nextPoll(f, wall)
  await step(f, 1)
  expect(Object.values(f.world().tasks)).toHaveLength(1)
  expect(f.world().intakePolls[trigger].error).toBeNull()
  expect((await issue('ENG-1')).comments).toHaveLength(1)
})

test('a server killed between a cancel from Linear and its note posts the note exactly once after restart', async () => {
  await addIssue('Fix login')
  const store = memoryStore()
  const wall = wallClock()
  const real = client()
  let reached = () => {}
  const died = new Promise<void>((resolve) => { reached = resolve })
  const dying: LinearClient = {
    ...real,
    ensureComment: async (issueId, commentId, body) => {
      await real.ensureComment(issueId, commentId, body)
      reached()
      return new Promise<void>(() => {})
    },
  }
  const first = makeFixture({ store, linear: dying, clock: wall.read })
  linearTrigger(first, first.agent('Coder'))
  await start(first)
  await moveIssue('ENG-1', 'Canceled')
  wall.now += LINEAR_POLL_MS
  first.api.sim.advance(1)
  await died
  expect(writeSteps(first)).toEqual([['move started', 'landed'], ['note cancelled', 'pending']])

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wall.read })
  await step(second, 1)
  expect(writeSteps(second)).toEqual([['move started', 'landed'], ['note cancelled', 'landed']])
  const after = await issue('ENG-1')
  expect(after.comments).toHaveLength(1)
  expect(after.comments[0].id).toBe((second.world().intake[ENG_1].writes[1] as { commentId: string }).commentId)
  expect(await requests()).toMatchObject({ FactoryCreateComment: 1 })
})

test('changing the trigger’s started state does not cancel flows it has already taken', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const trigger = linearTrigger(f, f.agent('Coder'))
  await start(f)
  f.api.triggers.update(trigger, { linear: { ...LIFECYCLE, startedState: 'state-eng-in-review' } })
  await nextPoll(f, wall)
  expect(runsInOrder(f).map((r) => r.status)).toEqual(['running'])
  expect(f.world().intake[ENG_1].cancel).toBeNull()
})

test('a move dropped by a cancel from Linear while it is in flight stays dropped when its answer fails', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const real = client()
  let release = (_err: Error) => {}
  const linear: LinearClient = {
    ...real,
    ensureState: () => new Promise<boolean>((_resolve, reject) => { release = reject }),
  }
  const f = makeFixture({ linear, clock: wall.read })
  linearTrigger(f, f.agent('Coder'))
  await step(f, 0)
  f.api.sim.advance(1)
  expect(writeSteps(f)).toEqual([['move started', 'pending']])

  await moveIssue('ENG-1', 'Canceled')
  wall.now += LINEAR_POLL_MS
  f.api.sim.advance(1)
  for (let i = 0; i < 200 && f.world().intake[ENG_1].cancel === null; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  release(new Error('socket hang up'))
  await f.api.sim.settled()
  expect(writeSteps(f)).toEqual([['move started', 'dropped'], ['note cancelled', 'landed']])
})

test('a run still running in a saved world whose flow was cancelled restores as cancelled and does not retry', async () => {
  await addIssue('Fix login')
  const store = memoryStore()
  const wall = wallClock()
  const first = makeFixture({ store, linear: client(), clock: wall.read })
  linearTrigger(first, first.agent('Coder'))
  await start(first)
  first.server.flush()
  const [run] = runsInOrder(first)
  const saved = JSON.parse(store.text!) as World
  saved.intake[ENG_1] = { ...saved.intake[ENG_1], cancel: { kind: 'linear', reason: 'canceled in Linear' } }
  store.text = JSON.stringify(saved)

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wall.read })
  expect(second.world().runs[run.id]).toMatchObject({ status: 'cancelled', error: 'its flow was cancelled' })
  expect(second.world().tasks[run.taskId]).toMatchObject({ status: 'cancelled', retryAt: null })
  await step(second, 60_000)
  expect(Object.values(second.world().runs)).toHaveLength(1)
})

test('an operator’s cancel decides the note even when another task in the flow failed', () => {
  const flowId = 'fl-1' as FlowId
  const task = (id: string, title: string, status: Task['status'], createdAt: number): Task => ({
    id: id as TaskId, flowId, agentId: 'ag-coder' as AgentId, title, prompt: '', priority: 'normal', status,
    origin: { kind: 'manual' }, input: null, createdAt, attempts: 1, retryAt: null, blockedOn: null,
  })
  const record: IntakeRecord = {
    issue: { backend: 'linear', id: ENG_1, identifier: 'ENG-1', url: 'https://linear.app/fake/issue/ENG-1', branchName: 'eng-1' },
    trigger: 'tr-1' as TriggerId, flowId, takenAt: 0, phase: 'started', writes: [], states: LIFECYCLE, cancel: { kind: 'factory', task: 'Review' },
  }
  const world = { agents: {}, runs: {}, triggers: { ['tr-1' as TriggerId]: { linear: LIFECYCLE } } } as unknown as World
  const next = reconcileRecord(record, [task('tk-a', 'Build', 'failed', 1), task('tk-b', 'Review', 'cancelled', 2)], world, () => 'comment-1')
  expect(next.writes).toEqual([
    { kind: 'move', step: 'failed', stateId: 'state-eng-backlog', status: { state: 'pending' } },
    {
      kind: 'note', outcome: 'cancelled', commentId: 'comment-1', status: { state: 'pending' },
      body: '**Factory stopped work on this issue: “Review” was cancelled in Factory.**\n\n**ag-coder**\nFailed: no reason recorded\n\n**ag-coder**\nCancelled before it finished.\n\nSigned by Factory. Runs: none. Agents: ag-coder.',
    },
  ])
})

test('an issue taken before the trigger’s started state changed moves to the started state it was taken with, and keeps running', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  const coder = f.agent('Coder')
  f.api.agents.setPaused(coder, true)
  const trigger = linearTrigger(f, coder)
  await step(f, 0)
  f.api.triggers.update(trigger, { linear: { ...LIFECYCLE, startedState: 'state-eng-in-review' } })
  f.api.agents.setPaused(coder, false)
  await step(f, 1)
  expect((await issue('ENG-1')).state).toBe('In Progress')
  await nextPoll(f, wall)
  expect(runsInOrder(f).map((r) => r.status)).toEqual(['running'])
  expect(f.world().intake[ENG_1].cancel).toBeNull()
})
