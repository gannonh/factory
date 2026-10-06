/**
 * Pull request delivery (ADR 0009) against real git: a bare repository is `origin`, the sandbox root is
 * its clone, a fake `gh` on PATH records each call, and the fake Linear server receives write-back.
 * The agent is an in-process runner that commits a file in its working directory, like a real agent would.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { createApi, type InProcessApi } from '../server/api'
import { runCommand } from '../server/commands'
import { createLinearClient, type LinearClient } from '../server/linear'
import { MockServer } from '../server/simulation'
import { SimulatedRunner, deliver, failureReason, prepareWorkdir, type Recheck, type Runner } from '../server/runners'
import { fileStore } from '../server/worldFile'
import { createHistory } from '../src/history'
import type { AgentId, EdgeId, IssueId, Run, RunId, SandboxId, TriggerId } from '../src/domain/types'
import { fakeGh } from './fake-gh'
import { makeFixture, RNG } from './fixture'

const roots: string[] = []
const tempDir = (prefix = 'factory-delivery-') => {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

const CODER = 'ag-coder' as AgentId
const REVIEWER = 'ag-reviewer' as AgentId
const LOCAL = 'sb-local-1' as SandboxId
const KEY = 'lin_api_test_delivery'
const ENG_1 = 'issue-eng-1' as IssueId
const ISSUE_URL = 'https://linear.app/fake/issue/ENG-1/fix-login'

let fake: FakeLinear
beforeAll(async () => { fake = await startFakeLinear({ apiKey: KEY }) })
afterAll(() => fake.close())

async function control(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(fake.controlUrl, { method: 'POST', body: JSON.stringify(body) })
  return response.json()
}
type FakeIssue = { comments: Array<{ id: string; body: string }>; attachments: Array<{ id: string; url: string; title: string }> }
const issue = (identifier: string) => control({ op: 'issue', identifier }) as Promise<FakeIssue>
const requests = async () => ((await control({ op: 'stats' })) as { requests: Record<string, number> }).requests

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitFile(repo: string, file: string, message: string) {
  writeFileSync(join(repo, file), `${message}\n`)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', message)
}

function identify(repo: string) {
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
}

/** A bare `origin` whose default branch is `main`, a `seed` clone that can move it, and the sandbox `root` clone. */
function repository() {
  const dir = tempDir()
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '--bare', '--initial-branch=main', origin)
  const seed = join(dir, 'seed')
  git(dir, 'clone', '--quiet', origin, seed)
  identify(seed)
  commitFile(seed, 'base.txt', 'base')
  git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
  const root = join(dir, 'root')
  git(dir, 'clone', '--quiet', origin, root)
  identify(root)
  return { origin, seed, root }
}

const remoteBranches = (origin: string) => git(origin, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/').split('\n')

let gh: ReturnType<typeof fakeGh>
const previousPath = process.env.PATH
beforeEach(async () => {
  await control({ op: 'reset' })
  gh = fakeGh(tempDir())
  process.env.PATH = `${gh.bin}:${previousPath}`
})
afterEach(() => { process.env.PATH = previousPath })

/** The agent: commits one file per attempt unless `commits` is off, then reports its result. */
function agentRunner(behaviour = { commits: true }): Runner {
  return {
    execution: 'local',
    start({ run, task, workdir }, emit) {
      if (behaviour.commits) commitFile(workdir, 'change.txt', `change for ${task.title} (attempt ${run.attempt})`)
      emit({ kind: 'complete', status: 'succeeded', result: `Implemented ${task.title}.` })
    },
    kill() {},
  }
}

type Factory = { server: MockServer; api: InProcessApi }

/** The seeded world with Coder delivering from the local sandbox at `root`, retrying once at once. Handoffs are kept only when asked. */
function factory(root: string, runner: Runner, options: { handoff?: boolean; linear?: LinearClient } = {}): Factory {
  const server = new MockServer({ manual: true, rng: RNG, localRunner: runner, localRoot: root, linear: options.linear, clock: () => 1_000_000 })
  const api = createApi(server)
  const world = server.snapshot()
  for (const trigger of Object.values(world.triggers)) api.triggers.update(trigger.id, { enabled: false })
  const drop = Object.values(world.edges).filter((e) => (e.kind === 'runs-in' && e.source === CODER && e.target !== LOCAL) || (!options.handoff && e.kind === 'handoff'))
  api.graph.removeEdges(drop.map((e) => e.id as EdgeId))
  api.agents.update(CODER, { delivery: 'pull-request', retry: { maxAttempts: 2, backoffMs: 0, backoff: 'fixed' } })
  return { server, api }
}

function linearIntake({ api }: Factory) {
  const id = api.graph.createNode('trigger', { x: 0, y: 0 }) as TriggerId
  api.triggers.update(id, { kind: 'linear', name: 'Linear intake' })
  api.graph.connect(id, CODER, 'triggers')
  api.triggers.update(id, {
    enabled: true,
    linear: { team: 'team-eng', project: null, pickupState: 'state-eng-todo', startedState: 'state-eng-in-progress', finishedState: 'state-eng-in-review', failedState: null },
  })
}

async function until(check: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the run')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const coderRuns = ({ server }: Factory): Run[] =>
  Object.values(server.snapshot().runs).filter((r) => r.agentId === CODER).sort((a, b) => a.attempt - b.attempt)

/** Starts Coder's next attempt and waits for it to end. */
async function nextAttempt(f: Factory): Promise<Run> {
  const before = coderRuns(f).length
  f.api.sim.advance(1)
  await until(() => coderRuns(f).length > before && coderRuns(f).at(-1)!.status !== 'running')
  await f.api.sim.settled()
  return coderRuns(f).at(-1)!
}

/** Takes ENG-1 into a flow on Coder and runs its first attempt. */
async function takeIssue(f: Factory): Promise<Run> {
  linearIntake(f)
  f.api.sim.advance(0)
  await f.api.sim.settled()
  return nextAttempt(f)
}

const workdirOf = (root: string, run: Run) => join(root, '.factory-runs', run.id)
const short = (repo: string, ref = 'HEAD') => git(repo, 'rev-parse', '--short=7', ref)
const linear = () => createLinearClient({ url: fake.url, apiKey: KEY })

test('the delivery setting is saved through agents.update, survives a restart, and refuses unknown values', async () => {
  const worldFile = join(tempDir(), 'world.json')
  const options = { manual: true, rng: RNG, localRunner: new SimulatedRunner(RNG), store: fileStore(worldFile) }
  const first = new MockServer(options)
  expect(first.snapshot().agents[CODER].delivery).toBe('none')
  runCommand(first, 'agents.update', [CODER, { delivery: 'pull-request' }])
  expect(() => runCommand(first, 'agents.update', [CODER, { delivery: 'push' }]))
    .toThrow('agents.update: args[1].delivery: expected one of none, pull-request')
  expect(first.snapshot().agents[CODER].delivery).toBe('pull-request')
  await first.close()

  const second = new MockServer(options)
  expect(second.snapshot().agents[CODER].delivery).toBe('pull-request')
  await second.close()
})

test('a delivery change from the inspector is one undo step', async () => {
  const fixture = makeFixture()
  const history = createHistory(fixture.api, fixture.world)
  await history.updateAgent(CODER, { delivery: 'pull-request' })
  expect(fixture.world().agents[CODER].delivery).toBe('pull-request')
  await history.undo()
  expect(fixture.world().agents[CODER].delivery).toBe('none')
  await history.redo()
  expect(fixture.world().agents[CODER].delivery).toBe('pull-request')
})

test('with delivery off, a run branches from the local HEAD and pushes nothing', async () => {
  const repo = repository()
  commitFile(repo.root, 'local.txt', 'local work')
  const localHead = git(repo.root, 'rev-parse', 'HEAD')
  const f = factory(repo.root, agentRunner())
  f.api.agents.update(CODER, { delivery: 'none' })
  f.api.agents.enqueue(CODER, { title: 'Add change', prompt: 'p', priority: 'normal' })
  const run = await nextAttempt(f)

  const workdir = workdirOf(repo.root, run)
  expect(run.status).toBe('succeeded')
  expect(git(workdir, 'rev-parse', 'HEAD~1')).toBe(localHead)
  expect(run.output).toEqual({ summary: 'Implemented Add change.', artifacts: [
    { kind: 'branch', label: `factory-${run.id}`, url: null },
    { kind: 'commit', label: `${short(workdir)} change for Add change (attempt 1)`, url: null },
  ] })
  expect(remoteBranches(repo.origin)).toEqual(['main'])
  expect(gh.calls()).toEqual([])
  await f.server.close()
})

test('a delivering manual run pushes factory-<runId>, opens one PR without an issue URL, and hands the PR to the next agent', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner(), { handoff: true })
  f.api.agents.enqueue(CODER, { title: 'Add change', prompt: 'p', priority: 'normal' })
  const run = await nextAttempt(f)

  const workdir = workdirOf(repo.root, run)
  const branch = `factory-${run.id}`
  const pr = { kind: 'pr', label: 'Pull request #41', url: 'https://github.com/example/factory/pull/41' }
  expect(run.output).toEqual({ summary: 'Implemented Add change.', artifacts: [
    { kind: 'branch', label: branch, url: null },
    { kind: 'commit', label: `${short(workdir)} change for Add change (attempt 1)`, url: null },
    pr,
  ] })
  expect(remoteBranches(repo.origin)).toEqual([branch, 'main'])
  expect(git(repo.origin, 'rev-parse', branch)).toBe(git(workdir, 'rev-parse', 'HEAD'))
  expect(gh.creates()).toEqual([{ cwd: workdir, argv: ['pr', 'create', '--head', branch, '--base', 'main', '--title', 'Add change', '--body', 'Implemented Add change.'] }])

  const handoff = Object.values(f.server.snapshot().tasks).find((t) => t.origin.kind === 'handoff' && t.origin.runId === run.id)!
  expect(handoff.agentId).toBe(REVIEWER)
  expect(handoff.input).toEqual({ ...run.output, runId: run.id })
  expect(handoff.prompt).toContain('pr: Pull request #41 (https://github.com/example/factory/pull/41)')
  await f.server.close()
})

test('an issue run cuts the issue branch from the fetched origin main, opens a PR with the issue URL, attaches it once and lists it in the note', async () => {
  const repo = repository()
  commitFile(repo.seed, 'upstream.txt', 'upstream change')
  git(repo.seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
  const originMain = git(repo.seed, 'rev-parse', 'HEAD')
  git(repo.root, 'checkout', '--quiet', '-b', 'local-work')
  commitFile(repo.root, 'local.txt', 'local work')
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner(), { linear: linear() })
  const run = await takeIssue(f)

  const workdir = workdirOf(repo.root, run)
  expect(run.status).toBe('succeeded')
  expect(git(workdir, 'branch', '--show-current')).toBe('eng-1-fix-login')
  expect(git(workdir, 'rev-parse', 'HEAD~1')).toBe(originMain)
  expect([existsSync(join(workdir, 'upstream.txt')), existsSync(join(workdir, 'local.txt'))]).toEqual([true, false])
  expect(f.server.snapshot().logs.map((l) => l.msg)).toContain(`working directory: ${workdir} on branch eng-1-fix-login from origin/main`)
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login')).toBe(git(workdir, 'rev-parse', 'HEAD'))
  expect(gh.creates().map((c) => c.argv)).toEqual([[
    'pr', 'create', '--head', 'eng-1-fix-login', '--base', 'main', '--title', 'ENG-1 Fix login', '--body', `Implemented ENG-1 Fix login.\n\n${ISSUE_URL}`,
  ]])

  const after = await issue('ENG-1')
  expect(after.attachments).toEqual([{ id: 'attachment-1', url: 'https://github.com/example/factory/pull/41', title: 'Pull request #41' }])
  expect(after.comments.map((c) => c.body)).toEqual([`**Factory finished this issue.**

**Coder** · run ${run.id}
Implemented ENG-1 Fix login.
- branch: eng-1-fix-login
- commit: ${short(workdir)} change for ENG-1 Fix login (attempt 1)
- pr: [Pull request #41](https://github.com/example/factory/pull/41)

Signed by Factory. Runs: ${run.id}. Agents: Coder.`])
  expect(f.server.snapshot().intake[ENG_1].writes.map((w) => [w.kind, w.status.state])).toEqual([
    ['move', 'landed'], ['move', 'landed'], ['attach', 'landed'], ['note', 'landed'],
  ])
  expect(await requests()).toMatchObject({ FactoryCreateAttachment: 1 })
  await f.server.close()
})

test('a delivering run with no commits opens no PR, and the output and the issue note say so', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner({ commits: false }), { linear: linear() })
  const run = await takeIssue(f)

  expect(run.output).toEqual({ summary: 'Implemented ENG-1 Fix login.', artifacts: [
    { kind: 'branch', label: 'eng-1-fix-login', url: null },
    { kind: 'note', label: 'No changes; no pull request opened', url: null },
  ] })
  expect(remoteBranches(repo.origin)).toEqual(['main'])
  expect(gh.calls()).toEqual([])
  const after = await issue('ENG-1')
  expect(after.attachments).toEqual([])
  expect(after.comments.map((c) => c.body)).toEqual([`**Factory finished this issue.**

**Coder** · run ${run.id}
Implemented ENG-1 Fix login.
- branch: eng-1-fix-login
- note: No changes; no pull request opened

Signed by Factory. Runs: ${run.id}. Agents: Coder.`])
  await f.server.close()
})

test('a rejected push fails the run with delivery failed, and the retry delivers on a suffixed branch', async () => {
  const repo = repository()
  const frozen = join(repo.origin, 'frozen')
  writeFileSync(frozen, '')
  writeFileSync(join(repo.origin, 'hooks', 'pre-receive'), `#!/bin/sh\nif [ -e '${frozen}' ]; then rm '${frozen}'; echo 'pushes are frozen' >&2; exit 1; fi\n`)
  chmodSync(join(repo.origin, 'hooks', 'pre-receive'), 0o755)
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner(), { linear: linear() })
  const first = await takeIssue(f)

  expect(first.status).toBe('failed')
  expect(first.error).toBe('delivery failed: git push: ! [remote rejected] HEAD -> eng-1-fix-login (pre-receive hook declined)')
  expect(f.server.snapshot().tasks[first.taskId].status).toBe('waiting')
  expect(gh.calls()).toEqual([])

  const second = await nextAttempt(f)
  const workdir = workdirOf(repo.root, second)
  expect(second.status).toBe('succeeded')
  expect(git(workdir, 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(remoteBranches(repo.origin)).toEqual(['eng-1-fix-login-2', 'main'])
  expect(git(repo.root, 'rev-parse', 'refs/heads/eng-1-fix-login')).toBe(git(workdirOf(repo.root, first), 'rev-parse', 'HEAD'))
  expect(gh.creates().map((c) => c.argv.slice(0, 4))).toEqual([['pr', 'create', '--head', 'eng-1-fix-login-2']])
  expect((await issue('ENG-1')).attachments.map((a) => a.url)).toEqual(['https://github.com/example/factory/pull/41'])
  await f.server.close()
})

test('a failed PR creation fails the run, the retry leaves the pushed branch untouched, and the issue gets one attachment', async () => {
  const repo = repository()
  gh.failNext()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner(), { linear: linear() })
  const first = await takeIssue(f)
  const firstHead = git(workdirOf(repo.root, first), 'rev-parse', 'HEAD')

  expect(first.status).toBe('failed')
  expect(first.error).toBe('delivery failed: gh pr create: GraphQL: was submitted too quickly (createPullRequest)')
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login')).toBe(firstHead)

  const second = await nextAttempt(f)
  expect(second.status).toBe('succeeded')
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login')).toBe(firstHead)
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login-2')).toBe(git(workdirOf(repo.root, second), 'rev-parse', 'HEAD'))
  expect(gh.creates().map((c) => c.argv.slice(2, 4))).toEqual([['--head', 'eng-1-fix-login'], ['--head', 'eng-1-fix-login-2']])
  const after = await issue('ENG-1')
  expect(after.attachments).toEqual([{ id: 'attachment-1', url: 'https://github.com/example/factory/pull/41', title: 'Pull request #41' }])
  expect(after.comments).toHaveLength(1)
  expect(after.comments[0].body.match(/- pr: /g)).toHaveLength(1)
  expect(await requests()).toMatchObject({ FactoryCreateAttachment: 1 })
  await f.server.close()
})

test('a delivering agent on a root with no origin remote fails the run before the agent starts', async () => {
  const root = tempDir()
  git(root, 'init', '--quiet')
  identify(root)
  commitFile(root, 'base.txt', 'base')
  let starts = 0
  const f = factory(root, { execution: 'local', start: () => { starts += 1 }, kill: () => {} })
  f.api.agents.update(CODER, { retry: { maxAttempts: 1 } })
  f.api.agents.enqueue(CODER, { title: 'Add change', prompt: 'p', priority: 'normal' })
  const run = await nextAttempt(f)
  expect([run.status, run.error, starts]).toEqual(['failed', 'delivery failed: sandbox root has no origin remote', 0])
  await f.server.close()
})

test('a pull request the agent opened itself is reused, not opened twice', async () => {
  const repo = repository()
  const runner: Runner = {
    execution: 'local',
    start({ run, task, workdir }, emit) {
      commitFile(workdir, 'change.txt', `change for ${task.title}`)
      gh.openPullRequest(`factory-${run.id}`, 'https://github.com/example/factory/pull/7')
      emit({ kind: 'complete', status: 'succeeded', result: 'Opened my own PR.' })
    },
    kill() {},
  }
  const f = factory(repo.root, runner)
  f.api.agents.enqueue(CODER, { title: 'Add change', prompt: 'p', priority: 'normal' })
  const run = await nextAttempt(f)

  expect(run.status).toBe('succeeded')
  expect(run.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #7', url: 'https://github.com/example/factory/pull/7' })
  expect(gh.creates()).toEqual([])
  await f.server.close()
})

test('commits an agent made on a branch of its own are delivered on the planned branch', async () => {
  const repo = repository()
  const runner: Runner = {
    execution: 'local',
    start({ task, workdir }, emit) {
      git(workdir, 'checkout', '--quiet', '-b', 'agent-side-branch')
      commitFile(workdir, 'change.txt', `change for ${task.title}`)
      emit({ kind: 'complete', status: 'succeeded', result: 'Committed on my own branch.' })
    },
    kill() {},
  }
  const f = factory(repo.root, runner)
  f.api.agents.enqueue(CODER, { title: 'Add change', prompt: 'p', priority: 'normal' })
  const run = await nextAttempt(f)

  const workdir = workdirOf(repo.root, run)
  expect(run.status).toBe('succeeded')
  expect(git(repo.origin, 'rev-parse', `factory-${run.id}`)).toBe(git(workdir, 'rev-parse', 'HEAD'))
  expect(gh.creates().map((c) => c.argv.slice(2, 4))).toEqual([['--head', `factory-${run.id}`]])
  expect(run.output?.artifacts.filter((a) => a.kind === 'branch')).toEqual([{ kind: 'branch', label: `factory-${run.id}`, url: null }])
  await f.server.close()
})

/** A new delivery branch never asks the server again. */
const NEVER_RECHECKED: Recheck = { request: () => Promise.reject(new Error('a new branch is never rechecked')), proceed: () => false }

test('a pull request for a GitHub origin names that repository', async () => {
  const repo = repository()
  const workdir = join(repo.root, 'wt')
  git(repo.root, 'worktree', 'add', '--quiet', '-b', 'feature-x', workdir, 'origin/main')
  const initialHead = git(workdir, 'rev-parse', 'HEAD')
  commitFile(workdir, 'change.txt', 'change')
  git(repo.root, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  git(repo.root, 'remote', 'set-url', '--push', 'origin', repo.origin)

  const delivered = await deliver({ root: repo.root, path: workdir, initialHead, delivery: { kind: 'new', branch: 'feature-x', base: 'main' } }, { title: 'T', body: 'B' }, NEVER_RECHECKED)

  expect(delivered).toMatchObject({ kind: 'pull-request', branch: 'feature-x', base: 'main', pr: { kind: 'pr', label: 'Pull request #41', url: 'https://github.com/example/factory/pull/41' } })
  expect(gh.calls().map((c) => c.argv)).toEqual([
    ['pr', 'view', 'feature-x', '--repo', 'github.com/acme/widgets', '--json', 'url,state,baseRefName'],
    ['pr', 'create', '--head', 'feature-x', '--base', 'main', '--title', 'T', '--body', 'B', '--repo', 'github.com/acme/widgets'],
  ])
})

test('a branch another actor creates on origin while the run works is not taken over by the run’s push', async () => {
  const repo = repository()
  const workdir = join(repo.root, 'wt')
  git(repo.root, 'worktree', 'add', '--quiet', '-b', 'feature-x', workdir, 'origin/main')
  const initialHead = git(workdir, 'rev-parse', 'HEAD')
  commitFile(workdir, 'change.txt', 'change')
  // The name was free when the worktree was prepared; someone else creates it at main before the push, so the run's
  // push would fast-forward their branch and can attach its commit to their pull request.
  git(repo.seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feature-x')
  const otherTip = git(repo.origin, 'rev-parse', 'refs/heads/feature-x')

  await expect(deliver({ root: repo.root, path: workdir, initialHead, delivery: { kind: 'new', branch: 'feature-x', base: 'main' } }, { title: 'T', body: 'B' }, NEVER_RECHECKED))
    .rejects.toThrow('delivery failed: git push')
  expect(git(repo.origin, 'rev-parse', 'refs/heads/feature-x')).toBe(otherTip)
  expect(gh.creates()).toEqual([])
})

test('a pull request whose branch moves while its commit is pushed fails the run instead of reporting a delivery', async () => {
  const repo = repository()
  const workdir = join(repo.root, 'wt')
  git(repo.root, 'worktree', 'add', '--quiet', '-b', 'feature-x', workdir, 'origin/main')
  const initialHead = git(workdir, 'rev-parse', 'HEAD')
  commitFile(workdir, 'change.txt', 'change')
  const pr = { kind: 'pr' as const, label: 'Pull request #41', url: 'https://github.com/example/factory/pull/41' }
  const answers = [
    { kind: 'continue' as const, pr, branch: 'feature-x', base: 'main' },
    { kind: 'continue' as const, pr, branch: 'feature-y', base: 'main' },
  ]
  const recheck: Recheck = { request: async () => answers.shift()!, proceed: () => true }

  await expect(deliver({ root: repo.root, path: workdir, initialHead, delivery: { kind: 'continue', branch: 'feature-x', base: 'main' } }, { title: 'T', body: 'B' }, recheck))
    .rejects.toThrow('delivery failed: pull request #41 moved to branch feature-y while this run delivered')
  // The push to the branch read before the move still happened; the retry delivers on the pull request's current branch.
  expect(git(repo.origin, 'rev-parse', 'refs/heads/feature-x')).toBe(git(workdir, 'rev-parse', 'HEAD'))
})

test('a continuing run pushes to the branch its pre-push read names, not the one prepared, and reports the base it last read', async () => {
  const repo = repository()
  const workdir = join(repo.root, 'wt')
  git(repo.root, 'worktree', 'add', '--quiet', '-b', 'feature-x', workdir, 'origin/main')
  const initialHead = git(workdir, 'rev-parse', 'HEAD')
  commitFile(workdir, 'change.txt', 'change')
  const pr = { kind: 'pr' as const, label: 'Pull request #41', url: 'https://github.com/example/factory/pull/41' }
  // The run was prepared on develop. A sibling's read of the pull request saved a rename and a retarget before the push,
  // and another retarget landed while the push ran.
  const answers = [
    { kind: 'continue' as const, pr, branch: 'feature-y', base: 'release' },
    { kind: 'continue' as const, pr, branch: 'feature-y', base: 'hotfix' },
  ]
  let reads = 0
  const recheck: Recheck = { request: async () => { reads += 1; return answers.shift()! }, proceed: () => true }

  const delivered = await deliver({ root: repo.root, path: workdir, initialHead, delivery: { kind: 'continue', branch: 'feature-x', base: 'develop' } }, { title: 'T', body: 'B' }, recheck)

  expect(delivered).toMatchObject({ kind: 'pull-request', branch: 'feature-y', base: 'hotfix', pr })
  expect(reads).toBe(2)
  expect(git(repo.origin, 'rev-parse', 'refs/heads/feature-y')).toBe(git(workdir, 'rev-parse', 'HEAD'))
  expect(git(repo.origin, 'branch', '--list', 'feature-x')).toBe('')
  expect(gh.creates()).toEqual([])
})

test('two runs preparing the same branch at once get distinct names', async () => {
  const repo = repository()
  const [a, b] = await Promise.all([
    prepareWorkdir(repo.root, 'run-a' as RunId, { kind: 'new', branch: 'eng-1-fix-login', retired: [] }),
    prepareWorkdir(repo.root, 'run-b' as RunId, { kind: 'new', branch: 'eng-1-fix-login', retired: [] }),
  ])
  // The per-repository queue fully serializes the name choice, so the two runs always get distinct names, but which
  // prepare reaches the queue first depends on OS scheduling of the git/fetch steps before it, so compare as a set.
  expect([a.delivery?.branch, b.delivery?.branch].sort()).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2'])
})

const PR_41 = { kind: 'pr' as const, label: 'Pull request #41', url: 'https://github.com/example/factory/pull/41' }
const continuing = (branch: string): Recheck => ({ request: async () => ({ kind: 'continue', pr: PR_41, branch, base: 'main' }), proceed: () => true })
const resume = (root: string, runId: string, branch: string) => prepareWorkdir(root, runId as RunId, { kind: 'continue', pr: PR_41, branch, base: 'main' })

function originHook(repo: { origin: string }, name: 'pre-receive' | 'post-receive', script: string) {
  writeFileSync(join(repo.origin, 'hooks', name), `#!/bin/sh\n${script}\n`)
  chmodSync(join(repo.origin, 'hooks', name), 0o755)
}

test('a Coder and a Reviewer continuing one pull request both deliver while their pushes and fetches overlap, across 60 pairs', async () => {
  const repo = repository()
  const pairs = Array.from({ length: 60 }, (_, i) => `feature-${i}`)
  // A pause after origin takes a push widens the window in which a push has updated origin but not yet the clone's
  // remote-tracking ref, so a fetch of the same ref that starts then fails on every run of the race, not on one in a few.
  originHook(repo, 'post-receive', 'sleep 0.05')
  for (const branch of pairs) git(repo.seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
  const coders = await Promise.all(pairs.map((branch, i) => resume(repo.root, `coder-${i}`, branch)))
  coders.forEach((coder, i) => commitFile(coder.path, 'coder.txt', `coder change ${i}`))
  const delivered: Array<{ coder: string; reviewer: string }> = []
  const failures: string[] = []
  // Four lanes of pairs run side by side. In each pair the Reviewer's start is queued first and the Coder starts delivering
  // 0 to 80 ms later, so across the pairs the push lands at every point of the Reviewer's fetch.
  await Promise.all([0, 1, 2, 3].map(async (lane) => {
    for (let i = lane; i < pairs.length; i += 4) {
      const branch = pairs[i]
      const starting = resume(repo.root, `reviewer-${i}`, branch)
      await new Promise((resolve) => setTimeout(resolve, (i % 9) * 10))
      const [coder, reviewer] = await Promise.allSettled([deliver(coders[i], { title: 'T', body: 'B' }, continuing(branch)), starting])
      if (coder.status === 'rejected') { failures.push(String(coder.reason)); continue }
      if (reviewer.status === 'rejected') { failures.push(String(reviewer.reason)); continue }
      // The Reviewer may have started before the Coder's push, so its agent takes the Coder's commit first, as any agent
      // that finds its branch behind origin does, then adds its own and delivers.
      git(reviewer.value.path, 'fetch', '--quiet', '--refmap=', 'origin', `refs/heads/${branch}`)
      git(reviewer.value.path, 'merge', '--quiet', '--ff-only', 'FETCH_HEAD')
      commitFile(reviewer.value.path, 'reviewer.txt', `reviewer change ${i}`)
      const second = await deliver(reviewer.value, { title: 'T', body: 'B' }, continuing(branch)).then((result) => result.kind, (error: unknown) => { failures.push(String(error)); return 'failed' })
      delivered.push({ coder: coder.value.kind, reviewer: second })
    }
  }))
  expect(failures).toEqual([])
  expect(delivered).toEqual(Array.from({ length: 60 }, () => ({ coder: 'pull-request', reviewer: 'pull-request' })))
  pairs.forEach((branch, i) => expect(git(repo.origin, 'log', '--format=%s', `main..refs/heads/${branch}`)).toBe(`reviewer change ${i}\ncoder change ${i}`))
  expect(git(repo.root, 'for-each-ref', 'refs/factory')).toBe('')
}, 180_000)

test('deliveries to different branches in one root push in parallel', async () => {
  const repo = repository()
  const branches = ['alpha', 'beta', 'gamma', 'delta']
  for (const branch of branches) git(repo.seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
  const runs = await Promise.all(branches.map((branch) => resume(repo.root, `run-${branch}`, branch)))
  runs.forEach((run, i) => commitFile(run.path, 'change.txt', `change ${branches[i]}`))
  // Each push waits in origin until all four are there at once, so a push that has to wait for another one's turn times out and fails.
  const barrier = join(tempDir(), 'barrier')
  originHook(repo, 'pre-receive', `mkdir -p ${barrier}\ntouch ${barrier}/$$\nfor i in $(seq 100); do\n  [ "$(ls ${barrier} | wc -l)" -ge 4 ] && exit 0\n  sleep 0.05\ndone\necho 'pushes did not overlap' >&2\nexit 1`)
  const results = await Promise.allSettled(runs.map((run, i) => deliver(run, { title: 'T', body: 'B' }, continuing(branches[i]))))
  expect(results.map((result) => result.status === 'fulfilled' ? result.value.kind : String(result.reason))).toEqual(['pull-request', 'pull-request', 'pull-request', 'pull-request'])
}, 30_000)

test("a slow push to one branch does not hold up a run starting on another branch's pull request", async () => {
  const repo = repository()
  const held = join(tempDir(), 'held')
  const release = `${held}.release`
  originHook(repo, 'pre-receive', `while read old new ref; do\n  if [ "$ref" = refs/heads/slow ]; then\n    touch ${held}\n    for i in $(seq 200); do [ -e ${release} ] && break; sleep 0.05; done\n  fi\ndone`)
  for (const branch of ['slow', 'other']) git(repo.seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
  const slow = await resume(repo.root, 'run-slow', 'slow')
  commitFile(slow.path, 'slow.txt', 'slow change')
  const pushing = deliver(slow, { title: 'T', body: 'B' }, continuing('slow'))
  for (let i = 0; i < 200 && !existsSync(held); i++) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(existsSync(held)).toBe(true)
  const started = await Promise.race([
    resume(repo.root, 'run-other', 'other').then(() => 'prepared'),
    new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 3000)),
  ])
  writeFileSync(release, '')
  expect(started).toBe('prepared')
  expect((await pushing).kind).toBe('pull-request')
}, 30_000)

test('a git or gh step that times out reports the timeout, not its last output line', () => {
  expect(failureReason(Object.assign(new Error('Command failed'), { killed: true, stderr: 'Creating pull request for x into main\n' }))).toBe('timed out')
  expect(failureReason(Object.assign(new Error('Command failed'), { killed: false, stderr: 'remote: hi\nfatal: unable to access\n' }))).toBe('fatal: unable to access')
})

test('a pull request the agent opened against another base is not reused', async () => {
  const repo = repository()
  const runner: Runner = {
    execution: 'local',
    start({ run, task, workdir }, emit) {
      commitFile(workdir, 'change.txt', `change for ${task.title}`)
      gh.openPullRequest(`factory-${run.id}`, 'https://github.com/example/factory/pull/7', 'release')
      emit({ kind: 'complete', status: 'succeeded', result: 'Opened a PR against release.' })
    },
    kill() {},
  }
  const f = factory(repo.root, runner)
  f.api.agents.enqueue(CODER, { title: 'Add change', prompt: 'p', priority: 'normal' })
  const run = await nextAttempt(f)

  expect(run.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #42', url: 'https://github.com/example/factory/pull/42' })
  expect(gh.creates().map((c) => c.argv.slice(2, 6))).toEqual([['--head', `factory-${run.id}`, '--base', 'main']])
  await f.server.close()
})
