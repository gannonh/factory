/**
 * Pull request delivery (ADR 0009) against real git: a bare repository is `origin`, the sandbox root is
 * its clone, a fake `gh` on PATH records each call, and the fake Linear server receives write-back.
 * The agent is an in-process runner that commits a file in its working directory, like a real agent would.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { startFakeLinear, type FakeLinear } from '../scripts/fake-linear'
import { createApi, type InProcessApi } from '../server/api'
import { runCommand } from '../server/commands'
import { createLinearClient, type LinearClient } from '../server/linear'
import { MockServer } from '../server/simulation'
import { SimulatedRunner, type Runner } from '../server/runners'
import { fileStore } from '../server/worldFile'
import { createHistory } from '../src/history'
import type { AgentId, EdgeId, IssueId, Run, SandboxId, TriggerId } from '../src/domain/types'
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

type GhCall = { cwd: string; argv: string[] }

/** A fake `gh` first on PATH. It answers `pr create` with pull request 40 plus its call count, or fails once after `failNext`. */
function fakeGh() {
  const dir = tempDir()
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'gh.log')
  const failMarker = join(dir, 'fail-next')
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n')
if (fs.existsSync(${JSON.stringify(failMarker)})) {
  fs.rmSync(${JSON.stringify(failMarker)})
  console.error('GraphQL: was submitted too quickly (createPullRequest)')
  process.exit(1)
}
const count = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length
console.log('https://github.com/example/factory/pull/' + (40 + count))
`)
  chmodSync(join(bin, 'gh'), 0o755)
  return {
    bin,
    calls: (): GhCall[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as GhCall) : [],
    failNext: () => writeFileSync(failMarker, ''),
  }
}

let gh: ReturnType<typeof fakeGh>
const previousPath = process.env.PATH
beforeEach(async () => {
  await control({ op: 'reset' })
  gh = fakeGh()
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
  expect(gh.calls()).toEqual([{ cwd: workdir, argv: ['pr', 'create', '--head', branch, '--base', 'main', '--title', 'Add change', '--body', 'Implemented Add change.'] }])

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
  expect(gh.calls().map((c) => c.argv)).toEqual([[
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
  expect(first.error).toBe('delivery failed: git push: ! [remote rejected] eng-1-fix-login -> eng-1-fix-login (pre-receive hook declined)')
  expect(f.server.snapshot().tasks[first.taskId].status).toBe('waiting')
  expect(gh.calls()).toEqual([])

  const second = await nextAttempt(f)
  const workdir = workdirOf(repo.root, second)
  expect(second.status).toBe('succeeded')
  expect(git(workdir, 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(remoteBranches(repo.origin)).toEqual(['eng-1-fix-login-2', 'main'])
  expect(git(repo.root, 'rev-parse', 'refs/heads/eng-1-fix-login')).toBe(git(workdirOf(repo.root, first), 'rev-parse', 'HEAD'))
  expect(gh.calls().map((c) => c.argv.slice(0, 4))).toEqual([['pr', 'create', '--head', 'eng-1-fix-login-2']])
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
  expect(gh.calls().map((c) => c.argv.slice(2, 4))).toEqual([['--head', 'eng-1-fix-login'], ['--head', 'eng-1-fix-login-2']])
  const after = await issue('ENG-1')
  expect(after.attachments).toEqual([{ id: 'attachment-1', url: 'https://github.com/example/factory/pull/42', title: 'Pull request #42' }])
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
