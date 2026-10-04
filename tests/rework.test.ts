/**
 * Rework rounds (ADR 0012) against real git: a bare repository is `origin`, the sandbox root is its clone, a fake `gh`
 * on PATH serves pull request state and review feedback, and the fake Linear server holds the issue and its comments.
 * The agent is an in-process runner that commits a file in its working directory, like a real agent would.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { createApi, type InProcessApi } from '../server/api'
import { createLinearClient } from '../server/linear'
import { linearFeedback, reworkable } from '../server/rounds'
import { MockServer } from '../server/simulation'
import type { WorldStore } from '../server/worldFile'
import { intakeStatus } from '../src/components/linearIntake'
import { LINEAR_POLL_MS, roundOfFlow, type AgentId, type EdgeId, type IntakeRecord, type IssueId, type LinearSettings, type Run, type SandboxId, type Task, type TriggerId } from '../src/domain/types'
import { fakeGh } from './fake-gh'
import { makeFixture, memoryStore, RNG } from './fixture'

const roots: string[] = []
const tempDir = () => {
  const path = mkdtempSync(join(tmpdir(), 'factory-rework-'))
  roots.push(path)
  return path
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

const CODER = 'ag-coder' as AgentId
const LOCAL = 'sb-local-1' as SandboxId
const KEY = 'lin_api_test_rework'
const ENG_1 = 'issue-eng-1' as IssueId
const ISSUE_URL = 'https://linear.app/fake/issue/ENG-1/fix-login'
const PR_41 = 'https://github.com/example/factory/pull/41'
const PR_42 = 'https://github.com/example/factory/pull/42'
const LIFECYCLE: LinearSettings = {
  team: 'team-eng', project: null, pickupState: 'state-eng-todo', startedState: 'state-eng-in-progress', finishedState: 'state-eng-in-review', failedState: null,
}
const NO_STATES: LinearSettings = { ...LIFECYCLE, startedState: null, finishedState: null }

let fake: FakeLinear
beforeAll(async () => { fake = await startFakeLinear({ apiKey: KEY }) })
afterAll(() => fake.close())

async function control(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(fake.controlUrl, { method: 'POST', body: JSON.stringify(body) })
  return response.json()
}
type FakeIssue = { state: string; comments: Array<{ id: string; body: string; author: string }>; attachments: Array<{ url: string }> }
const issue = (identifier: string) => control({ op: 'issue', identifier }) as Promise<FakeIssue>
const moveIssue = (identifier: string, state: string) => control({ op: 'moveIssue', identifier, state })
const linear = () => createLinearClient({ url: fake.url, apiKey: KEY })

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitFile(repo: string, file: string, message: string) {
  writeFileSync(join(repo, file), `${message}\n`)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', message)
}

/** A bare `origin` whose default branch is `main`, and the sandbox `root` clone. */
function repository() {
  const dir = tempDir()
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '--bare', '--initial-branch=main', origin)
  const seed = join(dir, 'seed')
  git(dir, 'clone', '--quiet', origin, seed)
  for (const repo of [seed]) { git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test') }
  commitFile(seed, 'base.txt', 'base')
  git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
  const root = join(dir, 'root')
  git(dir, 'clone', '--quiet', origin, root)
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  return { origin, root }
}

let gh: ReturnType<typeof fakeGh>
const previousPath = process.env.PATH
beforeEach(async () => {
  await control({ op: 'reset' })
  gh = fakeGh(tempDir())
  process.env.PATH = `${gh.bin}:${previousPath}`
})
afterEach(() => { process.env.PATH = previousPath })

const seen: Task[] = []
beforeEach(() => { seen.length = 0 })

/** The agent: records each task it is given, then commits one file and succeeds, or fails, or never answers. */
function agentRunner(outcome: (task: Task) => 'commit' | 'fail' | 'hang' = () => 'commit') {
  return {
    execution: 'local' as const,
    start({ run, task, workdir }: { run: Run; task: Task; workdir: string }, emit: (event: { kind: 'complete'; status: 'succeeded' | 'failed'; result: string | null; reason?: string }) => void) {
      seen.push(task)
      const what = outcome(task)
      if (what === 'hang') return
      if (what === 'fail') return emit({ kind: 'complete', status: 'failed', result: null, reason: 'tests failed' })
      commitFile(workdir, 'change.txt', `change for ${task.title} (attempt ${run.attempt})`)
      emit({ kind: 'complete', status: 'succeeded', result: `Implemented ${task.title}.` })
    },
    kill() {},
  }
}

type Factory = { server: MockServer; api: InProcessApi; trigger: TriggerId; root: string }
const WALL = 1_000_000
/** Factory's wall clock in `factory()`. Feedback times in these tests are set against it. */
let wall = WALL
beforeEach(() => { wall = WALL })

/** The seeded world with Coder delivering from the local sandbox at `root`, fed by a Linear trigger on ENG's Todo. */
function factory(root: string, runner: ReturnType<typeof agentRunner>, settings = LIFECYCLE, store?: WorldStore): Factory {
  const server = new MockServer({ manual: true, rng: RNG, localRunner: runner, localRoot: root, linear: linear(), clock: () => wall, store })
  const api = createApi(server)
  const world = server.snapshot()
  for (const trigger of Object.values(world.triggers)) api.triggers.update(trigger.id, { enabled: false })
  const drop = Object.values(world.edges).filter((e) => (e.kind === 'runs-in' && e.source === CODER && e.target !== LOCAL) || e.kind === 'handoff')
  api.graph.removeEdges(drop.map((e) => e.id as EdgeId))
  api.agents.update(CODER, { delivery: 'pull-request', retry: { maxAttempts: 2, backoffMs: 0, backoff: 'fixed' } })
  const trigger = api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
  api.triggers.update(trigger, { kind: 'linear', name: 'Linear intake' })
  api.graph.connect(trigger, CODER, 'triggers')
  api.triggers.update(trigger, { enabled: true, linear: settings })
  return { server, api, trigger, root }
}

async function until(check: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** One poll of the trigger, on demand, as Fire does it. */
async function poll(f: Factory) {
  await f.api.triggers.fire(f.trigger)
  await f.api.sim.settled()
}

const coderRuns = ({ server }: Pick<Factory, 'server'>): Run[] =>
  Object.values(server.snapshot().runs).filter((r) => r.agentId === CODER).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))

/** Starts Coder's next run and waits for it to end and for its write-back. */
async function nextRun(f: Pick<Factory, 'server' | 'api'>): Promise<Run> {
  const before = coderRuns(f).length
  f.api.sim.advance(1)
  await until(() => coderRuns(f).length > before && coderRuns(f).at(-1)!.status !== 'running')
  await f.api.sim.settled()
  return coderRuns(f).at(-1)!
}

const issueTasks = (f: Factory) => Object.values(f.server.snapshot().tasks).filter((t) => t.origin.kind === 'issue').sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
const record = (f: Factory): IntakeRecord => f.server.snapshot().intake[ENG_1]
const workdirOf = (f: Factory, run: Run) => join(f.root, '.factory-runs', run.id)
const short = (repo: string) => git(repo, 'rev-parse', '--short=7', 'HEAD')

test('a delivered issue moved back to Todo reworks on the same pull request with the review and Linear feedback, then a merged PR starts fresh', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  await poll(f)
  const first = await nextRun(f)
  const firstHead = git(workdirOf(f, first), 'rev-parse', 'HEAD')
  expect(first.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #41', url: PR_41 })
  expect((await issue('ENG-1')).state).toBe('In Review')
  expect(record(f)).toMatchObject({ round: 1, phase: 'ended', left: true, result: { outcome: 'finished', pr: { kind: 'pr', label: 'Pull request #41', url: PR_41 }, output: { ...first.output, runId: first.id } } })

  // Review feedback since round 1 was taken counts, even from before Factory's note. An empty approval and a review from
  // before the round do not.
  const at = (offset: number) => new Date(WALL + offset).toISOString()
  gh.review(41, 'yan', 'Stale review from before the round.', at(-1000))
  gh.review(41, 'zed', 'Rename the handler.', at(1000))
  gh.review(41, 'alice', 'Please handle the empty password case.', at(2000))
  gh.review(41, 'erin', '', at(2001))
  gh.inline(41, 'bob', 'This throws on null.\nGuard it.', 'src/login.ts', 12, at(2002))
  gh.conversation(41, 'carol', 'Can we add a test?', at(2003))
  await control({ op: 'addComment', identifier: 'ENG-1', author: 'Dana', body: 'Also log the failed attempt.' })
  await moveIssue('ENG-1', 'Todo')

  wall = WALL + 5000
  gh.failNext('view')
  await poll(f)
  expect(issueTasks(f)).toHaveLength(1)
  expect(f.server.snapshot().logs.map((l) => l.msg)).toContain(
    `ENG-1: could not read ${PR_41}, so its next round waits for the next poll: gh pr view: no pull requests found for "${PR_41}"`,
  )

  await poll(f)
  const second = issueTasks(f)[1]
  expect(second).toMatchObject({
    title: 'ENG-1 Fix login (round 2)',
    agentId: CODER,
    prompt: `Fix login

${ISSUE_URL}

## Rework round 2

Continue on pull request #41 (${PR_41}). Commit your changes on top of the current HEAD and do not rebase, amend or push; Factory pushes them to the pull request's branch \`eng-1-fix-login\`.

### Review comments on the pull request
- **zed** (review): Rename the handler.
- **alice** (review): Please handle the empty password case.
- **bob** on \`src/login.ts:12\`: This throws on null.
  Guard it.
- **carol**: Can we add a test?

### Linear comments since the last round
- **Dana**: Also log the failed attempt.`,
    input: { ...first.output, runId: first.id },
  })
  expect(gh.calls().filter((c) => c.argv[0] === 'api').map((c) => c.argv.at(-1)).sort()).toEqual([
    'repos/example/factory/issues/41/comments?per_page=100', 'repos/example/factory/pulls/41/comments?per_page=100', 'repos/example/factory/pulls/41/reviews?per_page=100',
  ])
  expect(gh.calls().find((c) => c.argv[0] === 'api')?.argv.slice(0, 6)).toEqual(['api', '--hostname', 'github.com', '--paginate', '--jq', '.[] | @json'])
  expect(record(f)).toMatchObject({
    round: 2, flowId: second.flowId, phase: 'taken', left: false,
    rework: { kind: 'continue', pr: { url: PR_41 }, branch: 'eng-1-fix-login', base: 'main' },
    past: [{ round: 1, flowId: issueTasks(f)[0].flowId, result: { outcome: 'finished' } }],
  })
  const world = f.server.snapshot()
  expect(intakeStatus(world, world.triggers[f.trigger]).rounds).toEqual(['ENG-1 round 2'])
  expect(roundOfFlow(world, issueTasks(f)[0].flowId)?.round).toBe(1)
  expect(roundOfFlow(world, second.flowId)?.round).toBe(2)

  const secondRun = await nextRun(f)
  const workdir = workdirOf(f, secondRun)
  expect(secondRun.status).toBe('succeeded')
  expect(prViews()).toBe(3)
  expect(seen.at(-1)?.prompt).toBe(second.prompt)
  expect(git(workdir, 'branch', '--show-current')).toBe(`factory-${secondRun.id}`)
  expect(git(workdir, 'rev-parse', 'HEAD~1')).toBe(firstHead)
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login')).toBe(git(workdir, 'rev-parse', 'HEAD'))
  expect(gh.creates()).toHaveLength(1)
  expect(Object.keys(gh.prs())).toEqual(['eng-1-fix-login'])
  let after = await issue('ENG-1')
  expect(after.attachments.map((a) => a.url)).toEqual([PR_41])
  expect(after.comments.map((c) => c.author)).toEqual(['Factory', 'Dana', 'Factory'])
  expect(after.comments[2].body).toBe(`**Factory finished this issue (round 2).**

Continued on pull request #41.

**Coder** · run ${secondRun.id}
Implemented ENG-1 Fix login (round 2).
- branch: eng-1-fix-login
- commit: ${short(workdir)} change for ENG-1 Fix login (round 2) (attempt 1)
- pr: [Pull request #41](${PR_41})

Signed by Factory. Runs: ${secondRun.id}. Agents: Coder.`)
  expect(after.comments[0].body.startsWith('**Factory finished this issue.**\n\n**Coder**')).toBe(true)

  // Round 3 reads only the review made after round 2 was taken, although round 2's note came after it.
  gh.review(41, 'frank', 'Handle the locked account too.', at(6000))
  gh.setState('eng-1-fix-login', 'MERGED')
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  const third = issueTasks(f)[2]
  expect(third).toMatchObject({
    title: 'ENG-1 Fix login (round 3)',
    prompt: `Fix login

${ISSUE_URL}

## Rework round 3

Pull request #41 (${PR_41}) was merged, so this round starts a fresh branch and opens a new pull request.

### Review comments on the pull request
- **frank** (review): Handle the locked account too.`,
    input: { ...secondRun.output, runId: secondRun.id },
  })
  const thirdRun = await nextRun(f)
  const thirdDir = workdirOf(f, thirdRun)
  expect(git(thirdDir, 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(git(thirdDir, 'rev-parse', 'HEAD~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
  expect(gh.creates().map((c) => c.argv.slice(2, 4))).toEqual([['--head', 'eng-1-fix-login'], ['--head', 'eng-1-fix-login-2']])
  after = await issue('ENG-1')
  expect(after.attachments.map((a) => a.url)).toEqual([PR_41, PR_42])
  expect(after.comments.at(-1)?.body).toBe(`**Factory finished this issue (round 3).**

Pull request #41 was merged, so this round opened a new pull request.

**Coder** · run ${thirdRun.id}
Implemented ENG-1 Fix login (round 3).
- branch: eng-1-fix-login-2
- commit: ${short(thirdDir)} change for ENG-1 Fix login (round 3) (attempt 1)
- pr: [Pull request #42](${PR_42})

Signed by Factory. Runs: ${thirdRun.id}. Agents: Coder.`)
  expect(record(f)).toMatchObject({ round: 3, rework: { kind: 'fresh', state: 'merged' }, result: { pr: { url: PR_42 } } })
  await f.server.close()
})

/** Round 1 delivers pull request #41, and the issue goes back to Todo so round 2 is taken to continue on it. */
async function roundTwoTaken(f: Factory) {
  await poll(f)
  await nextRun(f)
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  expect(record(f)).toMatchObject({ round: 2, rework: { kind: 'continue', pr: { url: PR_41 }, branch: 'eng-1-fix-login' } })
}

const prViews = () => gh.calls().filter((c) => c.argv[1] === 'view' && c.argv[2] === PR_41).length

test.each([
  ['deleted', true],
  ['kept', false],
] as const)('a pull request merged with its branch %s while round 2 waits makes the round start fresh and open a new pull request', async (_label, deleteBranch) => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  await roundTwoTaken(f)
  const mergedTip = git(repo.origin, 'rev-parse', 'refs/heads/eng-1-fix-login')
  gh.setState('eng-1-fix-login', 'MERGED')
  if (deleteBranch) git(repo.origin, 'update-ref', '-d', 'refs/heads/eng-1-fix-login')
  const views = prViews()

  const run = await nextRun(f)
  const workdir = workdirOf(f, run)
  expect(run.status).toBe('succeeded')
  expect(prViews()).toBe(views + 1)
  expect(git(workdir, 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(git(workdir, 'rev-parse', 'HEAD~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
  expect(git(repo.origin, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/eng-1-fix-login')).toBe(deleteBranch ? '' : `eng-1-fix-login ${mergedTip}`)
  expect(gh.creates().map((c) => c.argv.slice(2, 4))).toEqual([['--head', 'eng-1-fix-login'], ['--head', 'eng-1-fix-login-2']])
  expect(run.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #42', url: PR_42 })
  expect(record(f)).toMatchObject({ round: 2, phase: 'ended', rework: { kind: 'fresh', pr: { url: PR_41 }, state: 'merged' }, result: { pr: { url: PR_42 } } })
  expect(f.server.snapshot().logs.map((l) => l.msg)).toContain('pull request #41 was merged, so this run starts a fresh branch')
  const merged = `Pull request #41 (${PR_41}) was merged, so this round starts a fresh branch and opens a new pull request.`
  expect(seen.at(-1)?.prompt.split('\n\n').slice(-2)).toEqual(['## Rework round 2', merged])
  expect(issueTasks(f)[1].prompt).toBe(seen.at(-1)?.prompt)
  const after = await issue('ENG-1')
  expect(after.attachments.map((a) => a.url)).toEqual([PR_41, PR_42])
  expect(after.comments.at(-1)?.body.split('\n\n').slice(0, 2)).toEqual(['**Factory finished this issue (round 2).**', 'Pull request #41 was merged, so this round opened a new pull request.'])
  await f.server.close()
})

test('an unreadable pull request fails round 2’s run without guessing a branch, and the retry starts fresh once it reads the merge', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  await roundTwoTaken(f)
  gh.setState('eng-1-fix-login', 'MERGED')
  gh.failNext('view')

  const failed = await nextRun(f)
  expect(failed).toMatchObject({ status: 'failed', attempt: 1, error: `delivery failed: gh pr view: no pull requests found for "${PR_41}"` })
  expect(seen.map((t) => t.title)).toEqual(['ENG-1 Fix login'])
  expect(record(f).rework).toMatchObject({ kind: 'continue' })

  const retried = await nextRun(f)
  expect(retried).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect(git(workdirOf(f, retried), 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(record(f).rework).toMatchObject({ kind: 'fresh', state: 'merged' })
  await f.server.close()
})

test('a restart after round 2’s run read the merge retries fresh without reading the pull request again', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const store = memoryStore()
  const f = factory(repo.root, agentRunner((task) => (task.title.endsWith('(round 2)') ? 'hang' : 'commit')), LIFECYCLE, store)
  await roundTwoTaken(f)
  gh.setState('eng-1-fix-login', 'CLOSED')
  f.api.sim.advance(1)
  await until(() => seen.some((t) => t.title === 'ENG-1 Fix login (round 2)'))
  await f.server.close()

  const server = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock: () => wall, store })
  const g = { server, api: createApi(server), trigger: f.trigger, root: repo.root }
  expect(record(g).rework).toMatchObject({ kind: 'fresh', pr: { url: PR_41 }, state: 'closed' })
  const closed = `Pull request #41 (${PR_41}) was closed, so this round starts a fresh branch and opens a new pull request.`
  expect(seen.at(-1)?.prompt.split('\n\n').at(-1)).toBe(closed)
  const views = prViews()
  const retried = await nextRun(g)
  expect(retried).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect(seen.at(-1)?.prompt.split('\n\n').at(-1)).toBe(closed)
  expect(prViews()).toBe(views)
  expect(git(workdirOf(g, retried), 'branch', '--show-current')).toBe('eng-1-fix-login-3')
  expect((await issue('ENG-1')).comments.at(-1)?.body.split('\n\n')[1]).toBe('Pull request #41 was closed, so this round opened a new pull request.')
  await server.close()
})

test('a run cancelled while it reads its pull request prepares no worktree and leaves the round as taken', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  await roundTwoTaken(f)
  gh.setState('eng-1-fix-login', 'MERGED')
  gh.holdView()
  const views = prViews()
  f.api.sim.advance(1)
  await until(() => prViews() === views + 1)
  const run = coderRuns(f)[1]
  f.api.tasks.cancel(run.taskId)
  gh.releaseView()
  await f.api.sim.settled()
  expect(coderRuns(f)[1].status).toBe('cancelled')
  expect(existsSync(workdirOf(f, run))).toBe(false)
  expect(git(repo.root, 'branch', '--list', 'eng-1-fix-login-*')).toBe('')
  expect(record(f).rework).toMatchObject({ kind: 'continue' })
  expect(seen.map((t) => t.title)).toEqual(['ENG-1 Fix login'])
  await f.server.close()
})

test('a server closed while a run reads its merged pull request changes and saves nothing for that run', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const store = memoryStore()
  const f = factory(repo.root, agentRunner(), LIFECYCLE, store)
  await roundTwoTaken(f)
  gh.setState('eng-1-fix-login', 'MERGED')
  gh.holdView()
  const views = prViews()
  f.api.sim.advance(1)
  await until(() => prViews() === views + 1)
  const run = coderRuns(f)[1]
  const closing = f.server.close()
  gh.releaseView()
  await closing
  expect(coderRuns(f)[1].status).toBe('running')
  expect(record(f).rework).toMatchObject({ kind: 'continue' })
  expect(existsSync(workdirOf(f, run))).toBe(false)
  const saved = JSON.parse(store.text!) as { intake: Record<string, IntakeRecord>; runs: Record<string, Run> }
  expect([saved.intake[ENG_1].rework?.kind, saved.runs[run.id].status]).toEqual(['continue', 'running'])
})

test('a failed issue that never left Todo does not loop, and runs again as a new round once moved away and back', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => (task.title.endsWith('(round 2)') ? 'commit' : 'fail')), NO_STATES)
  f.api.agents.update(CODER, { retry: { maxAttempts: 1 } })
  await poll(f)
  const failed = await nextRun(f)
  expect([failed.status, record(f).phase, (await issue('ENG-1')).state]).toEqual(['failed', 'ended', 'Todo'])
  await poll(f)
  await poll(f)
  expect(issueTasks(f)).toHaveLength(1)
  expect(record(f).left).toBe(false)

  await moveIssue('ENG-1', 'Backlog')
  await poll(f)
  expect(record(f).left).toBe(true)
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  expect(issueTasks(f).map((t) => [t.title, t.prompt])).toEqual([
    ['ENG-1 Fix login', `Fix login\n\n${ISSUE_URL}`],
    ['ENG-1 Fix login (round 2)', `Fix login\n\n${ISSUE_URL}\n\n## Rework round 2\n\nThe previous round failed without a pull request, so this round starts fresh.`],
  ])
  const rerun = await nextRun(f)
  expect(rerun.status).toBe('succeeded')
  const notes = (await issue('ENG-1')).comments.map((c) => c.body.split('\n')[0])
  expect(notes).toEqual(['**Factory could not finish this issue.**', '**Factory finished this issue (round 2).**'])
  await f.server.close()
})

test('a restart during round 2 leaves one round 2 and posts one round 2 note', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const store = memoryStore()
  const f = factory(repo.root, agentRunner((task) => (task.title.endsWith('(round 2)') ? 'hang' : 'commit')), LIFECYCLE, store)
  await poll(f)
  await nextRun(f)
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  f.api.sim.advance(1)
  await until(() => seen.some((t) => t.title === 'ENG-1 Fix login (round 2)'))
  await f.server.close()

  const server = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock: () => WALL, store })
  const g = { server, api: createApi(server), trigger: f.trigger, root: repo.root }
  expect(coderRuns(g).at(-1)).toMatchObject({ status: 'failed', error: 'interrupted by restart' })
  await poll(g)
  const retried = await nextRun(g)
  await poll(g)
  expect(retried).toMatchObject({ status: 'succeeded', attempt: 2, title: 'ENG-1 Fix login (round 2)' })
  expect(issueTasks(g).map((t) => t.title)).toEqual(['ENG-1 Fix login', 'ENG-1 Fix login (round 2)'])
  expect(record(g)).toMatchObject({ round: 2, phase: 'ended', past: [{ round: 1 }] })
  const notes = (await issue('ENG-1')).comments.map((c) => c.body.split('\n')[0])
  expect(notes).toEqual(['**Factory finished this issue.**', '**Factory finished this issue (round 2).**'])
  expect(gh.creates()).toHaveLength(1)
  await server.close()
})

test('an intake record saved before rounds loads as round 1 with nothing past, and its open round takes nothing new', async () => {
  await control({ op: 'addIssue', title: 'Fix login' })
  const store = memoryStore()
  const first = makeFixture({ store, linear: linear(), clock: () => WALL })
  const trigger = first.api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
  first.api.triggers.update(trigger, { kind: 'linear', name: 'Linear intake' })
  first.api.graph.connect(trigger, first.agent('Coder'), 'triggers')
  first.api.triggers.update(trigger, { enabled: true, linear: NO_STATES })
  await first.api.triggers.fire(trigger)
  await first.api.sim.settled()
  first.server.flush()
  const saved = JSON.parse(store.text!) as { intake: Record<string, Record<string, unknown>> }
  for (const old of Object.values(saved.intake)) for (const key of ['round', 'rework', 'result', 'left', 'past']) delete old[key]
  store.text = JSON.stringify(saved)

  const second = makeFixture({ store, isolate: false, linear: linear(), clock: () => WALL })
  expect(second.world().intake[ENG_1]).toMatchObject({ round: 1, rework: null, result: null, left: false, past: [] })
  await second.api.triggers.fire(trigger)
  await second.api.sim.settled()
  expect(Object.values(second.world().tasks).filter((t) => t.origin.kind === 'issue')).toHaveLength(1)
})

test('a delivered record saved before rounds continues on the pull request its attach write names', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const store = memoryStore()
  const f = factory(repo.root, agentRunner(), LIFECYCLE, store)
  await poll(f)
  await nextRun(f)
  await f.server.close()
  const saved = JSON.parse(store.text!) as { intake: Record<string, Record<string, unknown>> }
  for (const old of Object.values(saved.intake)) for (const key of ['round', 'rework', 'result', 'left', 'past']) delete old[key]
  store.text = JSON.stringify(saved)

  const server = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock: () => wall, store })
  const g = { server, api: createApi(server), trigger: f.trigger, root: repo.root }
  expect(record(g)).toMatchObject({ round: 1, result: null, left: false })
  await poll(g)
  expect(record(g).left).toBe(true)
  await moveIssue('ENG-1', 'Todo')
  await poll(g)
  expect(record(g)).toMatchObject({
    round: 2, rework: { kind: 'continue', pr: { kind: 'pr', label: 'Pull request #41', url: PR_41 }, branch: 'eng-1-fix-login', base: 'main' },
  })
  expect(issueTasks(g)[1].prompt).toContain(`Continue on pull request #41 (${PR_41}).`)
  await server.close()
})

const moveSteps = (f: Factory) => record(f).writes.map((w) => [w.kind === 'move' ? `move ${w.step}` : w.kind, w.status.state])

test('a finished move still failing when the issue left Todo never lands after a person moves the issue back', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner(), { ...LIFECYCLE, startedState: null })
  await poll(f)
  await control({ op: 'failNext', operation: 'FactoryMoveIssue' })
  await nextRun(f)
  expect([(await issue('ENG-1')).state, record(f).left]).toEqual(['Todo', false])
  expect(moveSteps(f)).toEqual([['move finished', 'failed'], ['attach', 'landed'], ['note', 'landed']])

  await moveIssue('ENG-1', 'Backlog')
  await poll(f)
  expect(record(f).left).toBe(true)
  expect(moveSteps(f)).toEqual([['move finished', 'failed'], ['attach', 'landed'], ['note', 'landed']])

  // The retry comes due on the same tick as the next poll, and runs before the poll's answer starts round 2.
  await moveIssue('ENG-1', 'Todo')
  wall = WALL + LINEAR_POLL_MS
  f.api.sim.advance(1)
  await f.api.sim.settled()
  expect((await issue('ENG-1')).state).toBe('Todo')
  expect(moveSteps(f)).toEqual([['move finished', 'dropped'], ['attach', 'landed'], ['note', 'landed']])
  expect(issueTasks(f).map((t) => t.title)).toEqual(['ENG-1 Fix login', 'ENG-1 Fix login (round 2)'])
  await f.server.close()
})

test('a trigger that feeds no agent reads no comments or pull request for an issue back in Todo', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  await poll(f)
  await nextRun(f)
  const feeds = Object.values(f.server.snapshot().edges).filter((e) => e.kind === 'triggers' && e.source === f.trigger)
  f.api.graph.removeEdges(feeds.map((e) => e.id as EdgeId))
  await moveIssue('ENG-1', 'Todo')
  const ghCalls = gh.calls().length
  await poll(f)
  expect(issueTasks(f)).toHaveLength(1)
  expect(gh.calls()).toHaveLength(ghCalls)
  expect((await control({ op: 'stats' }) as { requests: Record<string, number> }).requests.FactoryIssueComments).toBeUndefined()

  f.api.graph.connect(f.trigger, CODER, 'triggers')
  await poll(f)
  expect(issueTasks(f).map((t) => t.title)).toEqual(['ENG-1 Fix login', 'ENG-1 Fix login (round 2)'])
  await f.server.close()
})

test('a failed read of one issue’s Linear comments holds only that issue, and the poll still cancels another', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  await poll(f)
  await nextRun(f)
  await control({ op: 'addIssue', title: 'Fix signup' })
  await poll(f)
  const eng2 = 'issue-eng-2' as IssueId
  expect(f.server.snapshot().intake[eng2]).toMatchObject({ phase: 'taken', cancel: null })

  await moveIssue('ENG-1', 'Todo')
  await moveIssue('ENG-2', 'Backlog')
  await control({ op: 'failNext', operation: 'FactoryIssueComments', message: 'comments unavailable' })
  await poll(f)
  expect(issueTasks(f).map((t) => [t.title, t.status])).toEqual([['ENG-1 Fix login', 'succeeded'], ['ENG-2 Fix signup', 'cancelled']])
  expect(f.server.snapshot().intake[eng2].cancel).toEqual({ kind: 'linear', reason: 'moved to Backlog in Linear' })
  expect(f.server.snapshot().logs.map((l) => l.msg)).toContain('ENG-1: could not read its Linear comments, so its next round waits for the next poll: Linear error: comments unavailable')

  await poll(f)
  expect(issueTasks(f).map((t) => t.title)).toEqual(['ENG-1 Fix login', 'ENG-2 Fix signup', 'ENG-1 Fix login (round 2)'])
  await f.server.close()
})

const ended = (fields: Partial<IntakeRecord>): IntakeRecord => ({
  issue: { backend: 'linear', id: ENG_1, identifier: 'ENG-1', url: ISSUE_URL, branchName: 'eng-1-fix-login' },
  trigger: 'tr-1' as TriggerId, flowId: 'fl-1' as IntakeRecord['flowId'], takenAt: 0, phase: 'ended', writes: [],
  states: { pickupState: 'state-eng-todo', startedState: null }, cancel: null, blockers: [], round: 1, rework: null, result: null, left: false, past: [], ...fields,
})

test.each([
  ['an open round', ended({ phase: 'started', left: true }), false],
  ['an ended round whose issue never left', ended({}), false],
  ['an ended round whose issue left', ended({ left: true }), true],
  ['an ended round of another trigger’s pickup state', ended({ states: { pickupState: 'state-eng-backlog', startedState: null } }), true],
  ['an ended round saved before states were kept', ended({ states: null }), false],
] as const)('reworkable: %s in Todo is %s', (_label, round, expected) => {
  expect(reworkable(round, 'state-eng-todo')).toBe(expected)
})

test('a Factory note with an unreadable time does not hide the Linear comments after the round started', () => {
  const record = ended({ takenAt: Date.parse('2026-10-01T00:00:00Z'), writes: [{ kind: 'note', outcome: 'finished', commentId: 'note-1', body: null, status: { state: 'landed', at: 0 } }] })
  expect(linearFeedback(record, [
    { id: 'note-1', body: 'Signed by Factory.', createdAt: 'not a time', author: 'Factory' },
    { id: 'c-1', body: 'Please handle the empty case.', createdAt: '2026-10-02T00:00:00Z', author: 'carol' },
  ])).toEqual([{ author: 'carol', body: 'Please handle the empty case.', at: Date.parse('2026-10-02T00:00:00Z'), kind: 'comment', place: null }])
})
