/**
 * Shared fixture for the rework suites (ADR 0012), against real git: a bare repository is `origin`, the sandbox root is
 * its clone, a fake `gh` on PATH serves pull request state and review feedback, and the fake Linear server holds the
 * issue and its comments. The agent is an in-process runner that commits a file in its working directory, like a real
 * agent would. Importing this module registers the hooks that reset all of that before each test.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { createApi, type InProcessApi } from '../server/api'
import { createLinearClient } from '../server/linear'
import { MockServer } from '../server/simulation'
import type { WorldStore } from '../server/worldFile'
import type { AgentId, EdgeId, IntakeRecord, IssueId, LinearSettings, Run, SandboxId, Task, TriggerId } from '../src/domain/types'
import { fakeGh } from './fake-gh'
import { RNG } from './fixture'

const roots: string[] = []
export const tempDir = () => {
  const path = mkdtempSync(join(tmpdir(), 'factory-rework-'))
  roots.push(path)
  return path
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

export const CODER = 'ag-coder' as AgentId
export const LOCAL = 'sb-local-1' as SandboxId
const KEY = 'lin_api_test_rework'
export const ENG_1 = 'issue-eng-1' as IssueId
export const ISSUE_URL = 'https://linear.app/fake/issue/ENG-1/fix-login'
export const PR_41 = 'https://github.com/example/factory/pull/41'
export const PR_42 = 'https://github.com/example/factory/pull/42'
export const LIFECYCLE: LinearSettings = {
  team: 'team-eng', project: null, pickupState: 'state-eng-todo', startedState: 'state-eng-in-progress', finishedState: 'state-eng-in-review', failedState: null,
}
export const NO_STATES: LinearSettings = { ...LIFECYCLE, startedState: null, finishedState: null }

let fake: FakeLinear
beforeAll(async () => { fake = await startFakeLinear({ apiKey: KEY }) })
afterAll(() => fake.close())

export async function control(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(fake.controlUrl, { method: 'POST', body: JSON.stringify(body) })
  return response.json()
}
type FakeIssue = { state: string; comments: Array<{ id: string; body: string; author: string }>; attachments: Array<{ url: string }> }
export const issue = (identifier: string) => control({ op: 'issue', identifier }) as Promise<FakeIssue>
export const moveIssue = (identifier: string, state: string) => control({ op: 'moveIssue', identifier, state })
export const linear = () => createLinearClient({ url: fake.url, apiKey: KEY })

/** The real git, resolved before any test puts a fake first on PATH. The tests and the agent use it; Factory does not. */
export const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function commitFile(repo: string, file: string, message: string) {
  writeFileSync(join(repo, file), `${message}\n`)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', message)
}

/** A bare `origin` whose default branch is `main`, the sandbox `root` clone, and the `seed` clone that plays GitHub's merges. */
export function repository() {
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
  return { origin, root, seed }
}

export let gh: ReturnType<typeof fakeGh>
const previousPath = process.env.PATH
beforeEach(async () => {
  await control({ op: 'reset' })
  gh = fakeGh(tempDir())
  process.env.PATH = `${gh.bin}:${previousPath}`
})
afterEach(() => { process.env.PATH = previousPath })

/** Every task the agent was given, in order. */
export const seen: Task[] = []
beforeEach(() => { seen.length = 0 })

/**
 * The agent: records each task it is given, then commits one file (change.txt by default) and succeeds, or fails, or
 * never answers. `after` runs in its working directory once it has committed, before it reports.
 */
export function agentRunner(
  outcome: (task: Task) => 'commit' | 'fail' | 'hang' = () => 'commit',
  file: (task: Task) => string = () => 'change.txt',
  after: (task: Task, workdir: string, attempt: number) => void = () => {},
) {
  return {
    execution: 'local' as const,
    start({ run, task, workdir }: { run: Run; task: Task; workdir: string }, emit: (event: { kind: 'complete'; status: 'succeeded' | 'failed'; result: string | null; reason?: string }) => void) {
      seen.push(task)
      const what = outcome(task)
      if (what === 'hang') return
      if (what === 'fail') return emit({ kind: 'complete', status: 'failed', result: null, reason: 'tests failed' })
      commitFile(workdir, file(task), `change for ${task.title} (attempt ${run.attempt})`)
      after(task, workdir, run.attempt)
      emit({ kind: 'complete', status: 'succeeded', result: `Implemented ${task.title}.` })
    },
    kill() {},
  }
}

export type Factory = { server: MockServer; api: InProcessApi; trigger: TriggerId; root: string }
export const WALL = 1_000_000
let wall = WALL
beforeEach(() => { wall = WALL })
/** Factory's wall clock in `factory()`. Feedback times in these tests are set against it. */
export const clock = () => wall
export const setWall = (ms: number) => { wall = ms }

/** The seeded world with Coder delivering from the local sandbox at `root`, fed by a Linear trigger on ENG's Todo. */
export function factory(root: string, runner: ReturnType<typeof agentRunner>, settings = LIFECYCLE, store?: WorldStore): Factory {
  const server = new MockServer({ manual: true, rng: RNG, localRunner: runner, localRoot: root, linear: linear(), clock, store })
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

export async function until(check: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** One poll of the trigger, on demand, as Fire does it. */
export async function poll(f: Factory) {
  await f.api.triggers.fire(f.trigger)
  await f.api.sim.settled()
}

export const agentRuns = ({ server }: Pick<Factory, 'server'>, agent: AgentId): Run[] =>
  Object.values(server.snapshot().runs).filter((r) => r.agentId === agent).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))
export const coderRuns = (f: Pick<Factory, 'server'>): Run[] => agentRuns(f, CODER)

/** Starts the agent's next run and waits for it to end and for its write-back. */
export async function nextRun(f: Pick<Factory, 'server' | 'api'>, agent = CODER): Promise<Run> {
  const before = agentRuns(f, agent).length
  f.api.sim.advance(1)
  await until(() => agentRuns(f, agent).length > before && agentRuns(f, agent).at(-1)!.status !== 'running')
  await f.api.sim.settled()
  return agentRuns(f, agent).at(-1)!
}

export const REVIEWER = 'ag-reviewer' as AgentId

/** Reviewer runs on the local sandbox and Coder hands off to it; it delivers pull requests too unless `delivery` says otherwise. */
export function addReviewer(f: Factory, delivery: 'pull-request' | 'none' = 'pull-request') {
  const touching = Object.values(f.server.snapshot().edges).filter((e) => e.source === REVIEWER || e.target === REVIEWER)
  f.api.graph.removeEdges(touching.map((e) => e.id as EdgeId))
  f.api.graph.connect(REVIEWER, LOCAL, 'runs-in')
  f.api.graph.connect(CODER, REVIEWER, 'handoff')
  f.api.agents.update(REVIEWER, { delivery, retry: { maxAttempts: 2, backoffMs: 0, backoff: 'fixed' } })
}

export const issueTasks = (f: Factory) => Object.values(f.server.snapshot().tasks).filter((t) => t.origin.kind === 'issue').sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
export const record = (f: Factory): IntakeRecord => f.server.snapshot().intake[ENG_1]
export const workdirOf = (f: Factory, run: Run) => join(f.root, '.factory-runs', run.id)
export const short = (repo: string) => git(repo, 'rev-parse', '--short=7', 'HEAD')
export const prViews = () => gh.calls().filter((c) => c.argv[1] === 'view' && c.argv[2] === PR_41).length

/** Round 1 delivers pull request #41, and the issue goes back to Todo so round 2 is taken to continue on it. */
export async function roundTwoTaken(f: Factory) {
  await poll(f)
  await nextRun(f)
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  expect(record(f)).toMatchObject({ round: 2, rework: { kind: 'continue', pr: { url: PR_41 }, branch: 'eng-1-fix-login' } })
}
