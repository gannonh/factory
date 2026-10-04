import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { createLinearClient, type LinearClient } from '../server/linear'
import { noteBody } from '../server/writeBack'
import { LINEAR_POLL_MS, type AgentId, type IssueId, type LinearSettings, type Run, type Task, type TaskId, type TriggerId, type World } from '../src/domain/types'
import { makeFixture, memoryStore, type Fixture } from './fixture'

const KEY = 'lin_api_test_writeback'
const COMMENT_ID = '5b7e1c2a-8f0d-4c3e-9a61-2d4f7b9e0c13'

let fake: FakeLinear
beforeAll(async () => { fake = await startFakeLinear({ apiKey: KEY }) })
afterAll(() => fake.close())
beforeEach(async () => { await control({ op: 'reset' }) })

async function control(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(fake.controlUrl, { method: 'POST', body: JSON.stringify(body) })
  return response.json()
}
const addIssue = (title: string, fields: Record<string, unknown> = {}) => control({ op: 'addIssue', title, ...fields })
const issue = (identifier: string) => control({ op: 'issue', identifier }) as Promise<{
  state: string; comments: Array<{ id: string; body: string }>; attachments: Array<{ id: string; url: string; title: string }>
}>
const requests = async () => ((await control({ op: 'stats' })) as { requests: Record<string, number> }).requests

const client = () => createLinearClient({ url: fake.url, apiKey: KEY })
const ENG_1 = 'issue-eng-1' as IssueId
const LIFECYCLE: LinearSettings = {
  team: 'team-eng', project: null, pickupState: 'state-eng-todo',
  startedState: 'state-eng-in-progress', finishedState: 'state-eng-in-review', failedState: 'state-eng-backlog',
}
const WRITES = ['FactoryMoveIssue', 'FactoryCreateComment']

function wallClock(start = 1_000_000) {
  const clock = { now: start, read: () => clock.now }
  return clock
}

function linearTrigger(f: Fixture, agent: AgentId, settings: LinearSettings = LIFECYCLE): TriggerId {
  const id = f.api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
  f.api.triggers.update(id, { kind: 'linear', name: 'Linear intake' })
  f.api.graph.connect(id, agent, 'triggers')
  f.api.triggers.update(id, { linear: settings, enabled: true })
  return id
}

async function step(f: Fixture, ms: number) {
  f.api.sim.advance(ms)
  await f.api.sim.settled()
}

async function untilFlowEnds(f: Fixture) {
  for (let i = 0; i < 200; i++) {
    await step(f, 400)
    if (f.world().intake[ENG_1].phase === 'ended') return
  }
  throw new Error('the flow did not end')
}

const runsInOrder = (f: Fixture): Run[] => Object.values(f.world().runs).sort((a, b) => a.startedAt - b.startedAt)
const writeSteps = (f: Fixture) => f.world().intake[ENG_1].writes.map((w) =>
  [w.kind === 'move' ? `move ${w.step}` : w.kind === 'attach' ? `attach ${w.url}` : `note ${w.outcome}`, w.status.state])
const failFast = (f: Fixture, agent: AgentId, maxAttempts: number) =>
  f.api.agents.update(agent, { timeoutMs: 5000, retry: { maxAttempts, backoffMs: 1000, backoff: 'fixed' } })

test('ensureState moves an issue once and leaves it alone when it is already there', async () => {
  await addIssue('Fix login')
  await client().ensureState(ENG_1, 'state-eng-in-progress', null)
  await client().ensureState(ENG_1, 'state-eng-in-progress', null)
  expect((await issue('ENG-1')).state).toBe('In Progress')
  expect(await requests()).toEqual({ FactoryIssueState: 2, FactoryMoveIssue: 1 })
})

test('ensureComment creates the comment under its id once', async () => {
  await addIssue('Fix login')
  await client().ensureComment(ENG_1, COMMENT_ID, 'Factory finished this issue.')
  await client().ensureComment(ENG_1, COMMENT_ID, 'Factory finished this issue.')
  expect((await issue('ENG-1')).comments).toMatchObject([{ id: COMMENT_ID, body: 'Factory finished this issue.' }])
  expect(await requests()).toEqual({ FactoryIssueComment: 2, FactoryCreateComment: 1 })
})

test('ensureAttachment links a URL once, however often it is repeated', async () => {
  await addIssue('Fix login')
  const url = 'https://github.com/example/factory/pull/41'
  await client().ensureAttachment(ENG_1, url, 'Pull request #41')
  await client().ensureAttachment(ENG_1, url, 'Pull request #41')
  expect((await issue('ENG-1')).attachments).toEqual([{ id: 'attachment-1', url, title: 'Pull request #41' }])
  expect(await requests()).toEqual({ FactoryIssueAttachment: 2, FactoryCreateAttachment: 1 })
})

test('a failed write rejects with the api error, and the fake refuses a second comment with the same id', async () => {
  await addIssue('Fix login')
  await control({ op: 'failNext', operation: 'FactoryMoveIssue', times: 1, message: 'rate limited' })
  await expect(client().ensureState(ENG_1, 'state-eng-done', null)).rejects.toMatchObject({ intake: { kind: 'api', message: 'Linear error: rate limited' } })
  expect((await issue('ENG-1')).state).toBe('Todo')
  await client().ensureState(ENG_1, 'state-eng-done', null)
  expect((await issue('ENG-1')).state).toBe('Done')

  await expect(client().ensureState('issue-gone' as IssueId, 'state-eng-done', null))
    .rejects.toMatchObject({ intake: { kind: 'api', message: 'Linear error: Entity not found: Issue' } })

  const create = (body: string) => fetch(fake.url, {
    method: 'POST',
    headers: { authorization: KEY },
    body: JSON.stringify({ operationName: 'FactoryCreateComment', variables: { input: { id: COMMENT_ID, issueId: ENG_1, body } } }),
  })
  expect((await create('first')).status).toBe(200)
  const duplicate = await create('second')
  expect(duplicate.status).toBe(400)
  expect(await duplicate.json()).toEqual({ errors: [{ message: `a comment with id ${COMMENT_ID} already exists` }] })
  expect((await issue('ENG-1')).comments).toMatchObject([{ id: COMMENT_ID, body: 'first' }])
})

test('a handoff flow moves the issue to started once, then to finished with one signed note listing both tasks in order', async () => {
  await addIssue('Plan the import')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const planner = f.agent('Planner')
  f.api.graph.connect(planner, f.agent('Coder'), 'handoff')
  linearTrigger(f, planner)
  await step(f, 0)
  expect(writeSteps(f)).toEqual([])

  await step(f, 1)
  expect((await issue('ENG-1')).state).toBe('In Progress')
  await step(f, 12_500)
  expect(runsInOrder(f).map((r) => r.status)).toEqual(['succeeded', 'running'])
  expect((await issue('ENG-1')).state).toBe('In Progress')
  expect(await requests()).toMatchObject({ FactoryMoveIssue: 1 })

  await step(f, 12_500)
  const [plannerRun, coderRun] = runsInOrder(f).map((r) => r.id)
  const after = await issue('ENG-1')
  expect(after.state).toBe('In Review')
  expect(after.comments).toMatchObject([{
    id: (f.world().intake[ENG_1].writes[2] as { commentId: string }).commentId,
    body: `**Factory finished this issue.**

**Planner** · run ${plannerRun}
The tech lead completed "ENG-1 Plan the import".
- note: Completion note for ENG-1 Plan the import

**Coder** · run ${coderRun}
The implementer completed "ENG-1 Plan the import → Coder".
- note: Completion note for ENG-1 Plan the import → Coder

Signed by Factory. Runs: ${plannerRun}, ${coderRun}. Agents: Planner, Coder.`,
  }])
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['move finished', 'landed'], ['note finished', 'landed']])
  expect(f.world().intake[ENG_1].phase).toBe('ended')
  expect(await requests()).toMatchObject({ FactoryMoveIssue: 2, FactoryCreateComment: 1 })
})

test('a task that fails with no retries left moves the issue to the failed state and posts the failure reason', async () => {
  await addIssue('Fix login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const coder = f.agent('Coder')
  failFast(f, coder, 1)
  linearTrigger(f, coder)
  await step(f, 0)
  await step(f, 1)
  await step(f, 5001)

  const [run] = runsInOrder(f)
  expect(f.world().tasks[run.taskId].status).toBe('failed')
  const after = await issue('ENG-1')
  expect(after.state).toBe('Backlog')
  expect(after.comments.map((c) => c.body)).toEqual([`**Factory could not finish this issue.**

**Coder** · run ${run.id}
Failed: timeout

Signed by Factory. Runs: ${run.id}. Agents: Coder.`])
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['move failed', 'landed'], ['note failed', 'landed']])
})

test('a failed attempt with a retry left writes nothing terminal, and the retry that succeeds finishes the issue', async () => {
  await addIssue('Fix login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const coder = f.agent('Coder')
  failFast(f, coder, 2)
  linearTrigger(f, coder)
  await step(f, 0)
  await step(f, 1)
  await step(f, 5001)

  const [first] = runsInOrder(f)
  expect(f.world().tasks[first.taskId].status).toBe('waiting')
  expect(f.world().intake[ENG_1].phase).toBe('started')
  expect(writeSteps(f)).toEqual([['move started', 'landed']])
  expect((await issue('ENG-1'))).toMatchObject({ state: 'In Progress', comments: [] })

  f.api.agents.update(coder, { timeoutMs: 120_000 })
  await step(f, 1000)
  await step(f, 12_500)
  const retry = runsInOrder(f)[1]
  expect([retry.attempt, retry.status]).toEqual([2, 'succeeded'])
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['move finished', 'landed'], ['note finished', 'landed']])
  const after = await issue('ENG-1')
  expect(after.state).toBe('In Review')
  expect(after.comments).toHaveLength(1)
  expect(after.comments[0].body).toContain(`**Coder** · run ${retry.id}\nThe implementer completed "ENG-1 Fix login".`)
  expect(after.comments[0].body).not.toContain(first.id)
})

function dying(dies: (write: string) => boolean) {
  const real = client()
  let reached = () => {}
  const died = new Promise<void>((resolve) => { reached = resolve })
  const hang = <T>() => { reached(); return new Promise<T>(() => {}) }
  const linear: LinearClient = {
    catalog: () => real.catalog(),
    issues: (filter) => real.issues(filter),
    issueStates: (ids) => real.issueStates(ids),
    comments: (issueId) => real.comments(issueId),
    ensureState: async (issueId, stateId, from) => {
      const moved = await real.ensureState(issueId, stateId, from)
      if (dies(stateId)) return hang<boolean>()
      return moved
    },
    ensureComment: async (issueId, commentId, body) => {
      await real.ensureComment(issueId, commentId, body)
      if (dies('note')) return hang()
    },
    ensureAttachment: (issueId, url, title) => real.ensureAttachment(issueId, url, title),
  }
  return { linear, died }
}

test.each([
  ['the started move', 'state-eng-in-progress'],
  ['the finished move', 'state-eng-in-review'],
  ['the note', 'note'],
])('a server killed between %s and its record converges after restart with one note', async (_label, write) => {
  await addIssue('Fix login')
  const store = memoryStore()
  const wall = wallClock()
  const { linear, died } = dying((w) => w === write)
  const first = makeFixture({ store, linear, clock: wall.read })
  const coder = first.agent('Coder')
  linearTrigger(first, coder)
  first.api.sim.advance(0)
  await first.api.sim.settled()
  first.api.sim.advance(1)
  if (write !== 'state-eng-in-progress') {
    await first.api.sim.settled()
    first.api.sim.advance(12_500)
  }
  await died
  expect(writeSteps(first).some(([, state]) => state === 'pending')).toBe(true)

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wall.read })
  await untilFlowEnds(second)
  await second.api.sim.settled()
  expect(writeSteps(second)).toEqual([['move started', 'landed'], ['move finished', 'landed'], ['note finished', 'landed']])
  const after = await issue('ENG-1')
  expect(after.state).toBe('In Review')
  expect(after.comments).toHaveLength(1)
  expect(after.comments[0].id).toBe((second.world().intake[ENG_1].writes[2] as { commentId: string }).commentId)
  expect(await requests()).toMatchObject({ FactoryMoveIssue: 2, FactoryCreateComment: 1 })
})

test('a failed move shows its reason, leaves the task alone, does not hold back the note, and lands on the next poll', async () => {
  await addIssue('Fix login')
  const wall = wallClock()
  const f = makeFixture({ linear: client(), clock: wall.read })
  linearTrigger(f, f.agent('Coder'))
  await step(f, 0)
  await step(f, 1)
  await control({ op: 'failNext', operation: 'FactoryMoveIssue', times: 1, message: 'rate limited' })
  await step(f, 12_500)

  const [run] = runsInOrder(f)
  expect(f.world().tasks[run.taskId].status).toBe('succeeded')
  expect(f.world().intake[ENG_1].writes.map((w) => w.status)).toEqual([
    { state: 'landed', at: 1_000_000 },
    { state: 'failed', at: 1_000_000, error: 'Linear error: rate limited' },
    { state: 'landed', at: 1_000_000 },
  ])
  const stuck = await issue('ENG-1')
  expect(stuck.state).toBe('In Progress')
  expect(stuck.comments).toHaveLength(1)
  expect(f.world().intake[ENG_1].writes[2]).toMatchObject({ kind: 'note', body: null })

  wall.now += LINEAR_POLL_MS - 1
  await step(f, 0)
  expect(await requests()).toMatchObject({ FactoryMoveIssue: 2 })
  expect(f.world().intake[ENG_1].writes[1].status.state).toBe('failed')

  wall.now += 1
  await step(f, 0)
  expect(f.world().tasks[run.taskId].status).toBe('succeeded')
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['move finished', 'landed'], ['note finished', 'landed']])
  expect(f.world().intake[ENG_1].writes[1].status).toEqual({ state: 'landed', at: 1_030_000 })
  const after = await issue('ENG-1')
  expect(after.state).toBe('In Review')
  expect(after.comments).toHaveLength(1)
})

test('an unset finished state posts the note and leaves the issue in the started state', async () => {
  await addIssue('Fix login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  linearTrigger(f, f.agent('Coder'), { ...LIFECYCLE, finishedState: null })
  await step(f, 0)
  await step(f, 1)
  await step(f, 12_500)
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['note finished', 'landed']])
  const after = await issue('ENG-1')
  expect(after.state).toBe('In Progress')
  expect(after.comments).toHaveLength(1)
})

test('cancelling an issue’s task while it waits on a retry moves the issue to the failed state with one note naming the task', async () => {
  await addIssue('Fix login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const coder = f.agent('Coder')
  failFast(f, coder, 2)
  linearTrigger(f, coder)
  await step(f, 0)
  await step(f, 1)
  await step(f, 5001)
  const [run] = runsInOrder(f)
  expect(f.world().tasks[run.taskId].status).toBe('waiting')
  f.api.tasks.cancel(run.taskId)
  await f.api.sim.settled()
  expect(f.world().intake[ENG_1].phase).toBe('ended')
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['move failed', 'landed'], ['note cancelled', 'landed']])
  const after = await issue('ENG-1')
  expect(after.state).toBe('Backlog')
  expect(after.comments.map((c) => c.body)).toEqual([
    `**Factory stopped work on this issue: “ENG-1 Fix login” was cancelled in Factory.**\n\n**Coder** · run ${run.id}\nCancelled before it finished.\n\nSigned by Factory. Runs: ${run.id}. Agents: Coder.`,
  ])
  expect(f.world().runs[run.id].status).toBe('failed')
  expect(f.world().tasks[run.taskId]).toMatchObject({ status: 'cancelled', retryAt: null })
})

test('a manual task never writes to Linear', async () => {
  await addIssue('Fix login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  const coder = f.agent('Coder')
  const trigger = linearTrigger(f, coder)
  f.api.triggers.update(trigger, { enabled: false })
  const manual = f.api.agents.enqueue(coder, { title: 'by hand', prompt: 'p', priority: 'normal' }) as TaskId
  await step(f, 1)
  await step(f, 12_500)
  expect(f.task(manual).status).toBe('succeeded')
  expect(Object.keys(await requests()).filter((op) => WRITES.includes(op))).toEqual([])
})

test('an intake record saved before write-back loads as ended and never writes', async () => {
  await addIssue('Fix login')
  const store = memoryStore()
  const first = makeFixture({ store, linear: client(), clock: wallClock().read })
  linearTrigger(first, first.agent('Coder'))
  await step(first, 0)
  first.server.flush()
  const saved = JSON.parse(store.text!) as { intake: Record<string, Record<string, unknown>> }
  delete saved.intake[ENG_1].phase
  delete saved.intake[ENG_1].writes
  store.text = JSON.stringify(saved)

  const second = makeFixture({ store, isolate: false, linear: client(), clock: wallClock().read })
  expect(second.world().intake[ENG_1]).toMatchObject({ phase: 'ended', writes: [] })
  await step(second, 1)
  await step(second, 12_500)
  expect(Object.values(second.world().tasks).find((t) => t.origin.kind === 'issue')?.status).toBe('succeeded')
  expect(second.world().intake[ENG_1]).toMatchObject({ phase: 'ended', writes: [] })
  expect(Object.keys(await requests()).filter((op) => WRITES.includes(op))).toEqual([])
  expect(await issue('ENG-1')).toMatchObject({ state: 'Todo', comments: [] })
})

test('the note lists tasks by creation then id, with artifact links, the failure reason and a cancelled task', () => {
  const task = (id: string, agentId: string, createdAt: number, status: Task['status']): Task => ({
    id: id as TaskId, flowId: 'fl-1' as Task['flowId'], agentId: agentId as AgentId, title: id, prompt: '', priority: 'normal', status,
    origin: { kind: 'manual' }, input: null, createdAt, attempts: 1, retryAt: null, blockedOn: null,
  })
  const run = (id: string, taskId: string, attempt: number, fields: Partial<Run>): Run => ({
    id: id as Run['id'], taskId: taskId as TaskId, agentId: 'ag-1' as AgentId, sandboxId: 'sb-1' as Run['sandboxId'], title: '', attempt,
    status: 'succeeded', execution: 'simulated', progress: 1, durationMs: 1, startedAt: attempt, endedAt: 2, tokens: 0, output: null, error: null, ...fields,
  })
  const world = {
    agents: { 'ag-review': { name: 'Reviewer' }, 'ag-qa': { name: 'QA' } } as unknown as World['agents'],
    runs: {
      'run-r': run('run-r', 'tk-b', 1, { output: { summary: 'Reviewed.', artifacts: [{ kind: 'pr', label: 'Pull request #7', url: 'https://github.com/o/r/pull/7' }, { kind: 'file', label: 'notes.md', url: null }] } }),
      'run-q1': run('run-q1', 'tk-c', 1, { status: 'failed', error: 'flaky' }),
      'run-q2': run('run-q2', 'tk-c', 2, { status: 'failed', error: 'timeout' }),
    } as World['runs'],
  }
  const tasks = [task('tk-c', 'ag-qa', 5, 'failed'), task('tk-b', 'ag-review', 1, 'succeeded'), task('tk-a', 'ag-gone', 1, 'cancelled')]
  expect(noteBody('failed', tasks, world)).toBe(`**Factory could not finish this issue.**

**ag-gone**
Cancelled before it finished.

**Reviewer** · run run-r
Reviewed.
- pr: [Pull request #7](https://github.com/o/r/pull/7)
- file: notes.md

**QA** · run run-q2
Failed: timeout

Signed by Factory. Runs: run-r, run-q2. Agents: ag-gone, Reviewer, QA.`)
})

test('a simulated run’s demo PR link is listed in the note but never attached to the issue', async () => {
  await addIssue('Review login')
  const f = makeFixture({ linear: client(), clock: wallClock().read })
  linearTrigger(f, f.agent('Reviewer'))
  await step(f, 0)
  await step(f, 1)
  await step(f, 12_500)
  expect(writeSteps(f)).toEqual([['move started', 'landed'], ['move finished', 'landed'], ['note finished', 'landed']])
  const after = await issue('ENG-1')
  expect(after.attachments).toEqual([])
  expect(after.comments[0].body).toMatch(/- pr: \[Pull request #\d+\]\(https:\/\/github\.com\/factory-demo\/factory\/pull\/\d+\)/)
  expect(Object.keys(await requests())).not.toContain('FactoryCreateAttachment')
})
