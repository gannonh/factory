/**
 * Rework rounds (ADR 0012) reached by handoff, and sibling runs of one round that reread its pull request at the same
 * time. See `rework-fixture.ts` for the repository, fake `gh` and fake Linear behind every test.
 */
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AgentId, EdgeId, Run } from '../src/domain/types'
import {
  CODER, CONTINUE_41, LIFECYCLE, LOCAL, MERGED_41, NO_STATES, PR_41, PR_42, agentRunner, coderRuns, control, factory, gh, git, moveIssue, poll, prViews,
  pullRequestLogs, record, repository, seen, short, tempDir, until, workdirOf, type Factory,
} from './rework-fixture'

const PLANNER = 'ag-planner' as AgentId
const REVIEWER = 'ag-reviewer' as AgentId
const QA = 'ag-qa' as AgentId

/** `factory()` with the trigger feeding Planner, who hands off to Coder, who hands off to Reviewer, all on the local sandbox. Only Coder delivers. */
function handoffFactory(root: string, runner = agentRunner(), settings = LIFECYCLE): Factory {
  const f = factory(root, runner, settings)
  const drop = Object.values(f.server.snapshot().edges).filter((e) => (e.kind === 'triggers' && e.source === f.trigger) || (e.kind === 'runs-in' && e.source === REVIEWER))
  f.api.graph.removeEdges(drop.map((e) => e.id as EdgeId))
  f.api.graph.connect(f.trigger, PLANNER, 'triggers')
  f.api.graph.connect(PLANNER, CODER, 'handoff')
  f.api.graph.connect(CODER, REVIEWER, 'handoff')
  f.api.graph.connect(REVIEWER, LOCAL, 'runs-in')
  return f
}

/**
 * Runs tasks one at a time until none is pending or running, or until `stop` holds. Each pass yields a real tick, so a
 * task that never starts fails the test at the deadline instead of spinning on microtasks.
 */
async function drain(f: Factory, stop: () => boolean = () => false, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  const busy = () => Object.values(f.server.snapshot().tasks).some((t) => t.status === 'queued' || t.status === 'waiting' || t.status === 'running')
  while (busy() && !stop()) {
    if (Date.now() > end) throw new Error('drain: tasks never settled')
    f.api.sim.advance(1)
    await until(() => !Object.values(f.server.snapshot().runs).some((r) => r.status === 'running'))
    await f.api.sim.settled()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const lastRunOf = (f: Factory, agentId: AgentId): Run => Object.values(f.server.snapshot().runs).filter((r) => r.agentId === agentId).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1)).at(-1)!

/** Planner's round 2 output, which Coder's round 2 prompt starts with. */
const plannerOutput = (f: Factory) => {
  const planner = lastRunOf(f, PLANNER)
  return `Implemented ENG-1 Fix login (round 2).\nbranch: factory-${planner.id}\ncommit: ${short(workdirOf(f, planner))} change for ENG-1 Fix login (round 2) (attempt 1)`
}

/** The prompt of each of Coder's round 2 attempts. */
const coderRoundTwoPrompts = () => seen.filter((t) => t.agentId === CODER && t.title.includes('(round 2)')).map((t) => t.prompt)

/** The prompt each agent's run was given in a round, by agent name. */
const promptsOf = (f: Factory, round: number) => {
  const flowId = round === record(f).round ? record(f).flowId : record(f).past.find((p) => p.round === round)!.flowId
  return Object.fromEntries(seen.filter((t) => t.flowId === flowId).map((t) => [f.server.snapshot().agents[t.agentId].name, t.prompt]))
}

test('a delivering agent reached by handoff in round 2 is told to continue on the open pull request, and the agent after it is not', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = handoffFactory(repo.root)
  await poll(f)
  await drain(f)
  expect(record(f)).toMatchObject({ round: 1, phase: 'ended', result: { pr: { url: PR_41 } } })
  const planner1 = lastRunOf(f, PLANNER)
  expect(promptsOf(f, 1)['Coder']).toBe(`Implemented ENG-1 Fix login.\nbranch: factory-${planner1.id}\ncommit: ${short(workdirOf(f, planner1))} change for ENG-1 Fix login (attempt 1)`)

  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  await drain(f)
  const coder = lastRunOf(f, CODER)
  const prompts = promptsOf(f, 2)
  expect(prompts['Coder']).toBe(`${plannerOutput(f)}\n\n## Rework round 2\n\n${CONTINUE_41}`)
  expect(prompts['Reviewer']).toBe(`Implemented ENG-1 Fix login (round 2) → Coder.
branch: eng-1-fix-login
commit: ${short(workdirOf(f, coder))} change for ENG-1 Fix login (round 2) → Coder (attempt 1)
pr: Pull request #41 (${PR_41})`)
  expect(pullRequestLogs(f)).toEqual([])
  expect(git(workdirOf(f, coder), 'branch', '--show-current')).toBe(`factory-${coder.id}`)
  expect(gh.creates()).toHaveLength(1)
  expect(record(f)).toMatchObject({ round: 2, phase: 'ended', rework: { kind: 'continue' }, result: { pr: { url: PR_41 } } })
  await f.server.close()
})

test('a delivering agent reached by handoff in a round whose pull request merged while it waited is told the round starts fresh', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = handoffFactory(repo.root)
  await poll(f)
  await drain(f)
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  gh.setState('eng-1-fix-login', 'MERGED')
  await drain(f)
  const merged = `Pull request #41 (${PR_41}) was merged, so this round starts a fresh branch and opens a new pull request.`
  expect(promptsOf(f, 2)['Coder']).toBe(`${plannerOutput(f)}\n\n## Rework round 2\n\n${merged}`)
  expect(git(workdirOf(f, coderRuns(f).at(-1)!), 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(record(f)).toMatchObject({ round: 2, rework: { kind: 'fresh', state: 'merged' }, result: { pr: { url: PR_42 } } })
  await f.server.close()
})

test('a delivering agent reached by handoff in a round whose pull request moved to another branch while it waited is told the new branch', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = handoffFactory(repo.root)
  await poll(f)
  await drain(f)
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  git(repo.origin, 'branch', '-m', 'eng-1-fix-login', 'eng-1-login')
  gh.openPullRequest('eng-1-login', PR_41)
  await drain(f)
  const coder = lastRunOf(f, CODER)
  expect(promptsOf(f, 2)['Coder']).toBe(`${plannerOutput(f)}\n\n## Rework round 2\n\n${CONTINUE_41.replace('eng-1-fix-login', 'eng-1-login')}`)
  expect(git(repo.origin, 'rev-parse', 'eng-1-login')).toBe(git(workdirOf(f, coder), 'rev-parse', 'HEAD'))
  expect(pullRequestLogs(f)).toEqual(['pull request #41 moved to branch eng-1-login'])
  expect(record(f)).toMatchObject({ round: 2, rework: { kind: 'continue', branch: 'eng-1-login' }, result: { pr: { url: PR_41 } } })
  expect(gh.creates()).toHaveLength(1)
  await f.server.close()
})

test('a delivering agent reached by handoff in a round after a flow that failed without a pull request is told the round starts fresh', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = handoffFactory(repo.root, agentRunner((task) => (task.agentId === CODER && !task.title.includes('(round 2)') ? 'fail' : 'commit')), NO_STATES)
  f.api.agents.update(CODER, { retry: { maxAttempts: 1 } })
  await poll(f)
  await drain(f)
  expect(record(f)).toMatchObject({ round: 1, phase: 'ended', result: { outcome: 'failed', pr: null } })
  await moveIssue('ENG-1', 'Backlog')
  await poll(f)
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  await drain(f)
  const fresh = 'The previous round failed without a pull request, so this round starts fresh.'
  expect(promptsOf(f, 2)['Coder']).toBe(`${plannerOutput(f)}\n\n## Rework round 2\n\n${fresh}`)
  expect(record(f)).toMatchObject({ round: 2, rework: null, result: { outcome: 'finished', pr: { url: PR_41 } } })
  await f.server.close()
})

/** Coder fails its first round 2 attempt and retries once. */
const failsFirstRoundTwoAttempt = () => agentRunner((task) => (task.agentId === CODER && task.title.includes('(round 2)') && task.attempts === 1 ? 'fail' : 'commit'))

/** Runs round 1, takes round 2, and runs it until Coder's first round 2 attempt has failed. */
async function roundTwoCoderFailed(f: Factory) {
  await poll(f)
  await drain(f)
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  await drain(f, () => coderRuns(f).some((r) => r.status === 'failed'))
  expect(coderRuns(f).map((r) => r.status)).toEqual(['succeeded', 'failed'])
}

test('a delivering handoff retry after its pull request merged gets one rework section, with the fresh line', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = handoffFactory(repo.root, failsFirstRoundTwoAttempt())
  await roundTwoCoderFailed(f)
  gh.setState('eng-1-fix-login', 'MERGED')
  await drain(f)
  const merged = `Pull request #41 (${PR_41}) was merged, so this round starts a fresh branch and opens a new pull request.`
  expect(coderRoundTwoPrompts()).toEqual([
    `${plannerOutput(f)}\n\n## Rework round 2\n\n${CONTINUE_41}`,
    `${plannerOutput(f)}\n\n## Rework round 2\n\n${merged}`,
  ])
  expect(git(workdirOf(f, coderRuns(f).at(-1)!), 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  await f.server.close()
})

test('a handoff retry whose agent stopped delivering gets the upstream output alone', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = handoffFactory(repo.root, failsFirstRoundTwoAttempt())
  await roundTwoCoderFailed(f)
  f.api.agents.update(CODER, { delivery: 'none' })
  await drain(f)
  const retry = coderRuns(f).at(-1)!
  expect(retry).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect(coderRoundTwoPrompts()).toEqual([`${plannerOutput(f)}\n\n## Rework round 2\n\n${CONTINUE_41}`, plannerOutput(f)])
  expect(f.server.snapshot().tasks[retry.taskId].prompt).toBe(plannerOutput(f))
  expect(gh.creates()).toHaveLength(1)
  await f.server.close()
})

/** `factory()` with the trigger feeding Planner, who hands off to Coder and each sibling, all on the local sandbox. */
function fanOutFactory(root: string, runner = agentRunner(), siblings = [REVIEWER]): Factory {
  const f = factory(root, runner)
  const drop = Object.values(f.server.snapshot().edges).filter((e) => (e.kind === 'triggers' && e.source === f.trigger) || (e.kind !== 'triggers' && siblings.includes(e.source as AgentId)))
  f.api.graph.removeEdges(drop.map((e) => e.id as EdgeId))
  f.api.graph.connect(f.trigger, PLANNER, 'triggers')
  f.api.graph.connect(PLANNER, CODER, 'handoff')
  for (const sibling of siblings) {
    f.api.graph.connect(PLANNER, sibling, 'handoff')
    f.api.graph.connect(sibling, LOCAL, 'runs-in')
  }
  return f
}

/** Round 1 delivers #41 through Coder. Round 2 is taken with each sibling delivering too, and only its Planner run has run. */
async function roundTwoPlanned(f: Factory, siblings = [REVIEWER]) {
  await poll(f)
  await drain(f)
  expect(record(f)).toMatchObject({ round: 1, phase: 'ended', result: { pr: { url: PR_41 } } })
  for (const agent of [CODER, ...siblings]) f.api.agents.update(agent, { delivery: 'pull-request', retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } })
  f.api.sandboxes.update(LOCAL, { capacity: 3 })
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  for (const agent of [CODER, ...siblings]) f.api.agents.setPaused(agent, true)
  const planned = () => Object.values(f.server.snapshot().runs).filter((r) => r.agentId === PLANNER && r.status === 'succeeded').length === 2
  await drain(f, planned)
  expect(planned()).toBe(true)
}

/** A `git` first on PATH that waits before every fetch while it is held, so a test can act while a worktree is prepared. */
function heldGit() {
  const dir = tempDir()
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const [hold, waiting] = [join(dir, 'hold'), join(dir, 'waiting')]
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh
for a in "$@"; do
  if [ "$a" = fetch ]; then
    if [ -e '${hold}' ]; then touch '${waiting}'; fi
    while [ -e '${hold}' ]; do sleep 0.02; done
    break
  fi
done
exec '${real}' "$@"
`)
  chmodSync(join(bin, 'git'), 0o755)
  writeFileSync(hold, '')
  return { bin, waiting: () => existsSync(waiting), release: () => rmSync(hold, { force: true }) }
}

test('a run that continues the pull request is told so when a parallel run saves the merge while its worktree is prepared', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = fanOutFactory(repo.root)
  await roundTwoPlanned(f)
  const git_ = heldGit()
  process.env.PATH = `${git_.bin}:${process.env.PATH}`
  f.api.agents.setPaused(CODER, false)
  f.api.sim.advance(1)
  await until(git_.waiting)
  gh.setState('eng-1-fix-login', 'MERGED')
  f.api.agents.setPaused(REVIEWER, false)
  f.api.sim.advance(1)
  await until(() => pullRequestLogs(f).length > 0)
  const continues = `${plannerOutput(f)}\n\n## Rework round 2\n\n${CONTINUE_41}`
  expect(f.server.snapshot().tasks[lastRunOf(f, CODER).taskId].prompt).toBe(continues)
  git_.release()
  await drain(f)
  expect(pullRequestLogs(f)).toEqual(['pull request #41 was merged, so this run starts a fresh branch'])
  expect(promptsOf(f, 2)).toEqual({
    Planner: expect.any(String),
    Coder: continues,
    Reviewer: `${plannerOutput(f)}\n\n## Rework round 2\n\n${MERGED_41}`,
  })
  await f.server.close()
}, 30_000)

test.each([
  ['older', ['pull request #41 was retargeted to develop', 'pull request #41 was retargeted to release']],
  ['newer', ['pull request #41 was retargeted to release']],
] as const)('sibling runs that read two retargets of the pull request, the %s read landing first, leave the round on the newest base', async (first, logs) => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  // Reviewer's round 2 agent never answers. When its older read lands first, its delivery would open a second pull request
  // against the stale base (KAT-3664), and in the fake gh that replaces #41 before Coder reads it again.
  const f = fanOutFactory(repo.root, agentRunner((task) => (task.agentId === REVIEWER && task.title.includes('(round 2)') ? 'hang' : 'commit')))
  await roundTwoPlanned(f)
  for (const base of ['develop', 'release']) git(repo.origin, 'branch', base, 'main')
  gh.holdState('OPEN', 'eng-1-fix-login', 'develop')
  gh.holdState('OPEN', 'eng-1-fix-login', 'release')
  const views = prViews()
  gh.openPullRequest('eng-1-fix-login', PR_41, 'develop')
  f.api.agents.setPaused(REVIEWER, false)
  f.api.sim.advance(1)
  await until(() => prViews() === views + 1)
  gh.openPullRequest('eng-1-fix-login', PR_41, 'release')
  f.api.agents.setPaused(CODER, false)
  f.api.sim.advance(1)
  await until(() => prViews() === views + 2)
  const [landsFirst, landsSecond] = first === 'older' ? ['develop', 'release'] : ['release', 'develop']
  gh.releaseState('OPEN', 'eng-1-fix-login', landsFirst)
  await until(() => pullRequestLogs(f).length === 1)
  gh.releaseState('OPEN', 'eng-1-fix-login', landsSecond)
  const second = lastRunOf(f, first === 'older' ? CODER : REVIEWER)
  const startedFrom = () => f.server.snapshot().logs.find((l) => l.runId === second.id && l.msg.startsWith('working directory: '))?.msg
  await until(() => startedFrom() !== undefined)
  expect(startedFrom()).toBe(`working directory: ${workdirOf(f, second)} on branch eng-1-fix-login from origin/release`)
  expect(pullRequestLogs(f)).toEqual(logs)
  expect(record(f).rework).toEqual({ kind: 'continue', pr: { kind: 'pr', label: 'Pull request #41', url: PR_41 }, branch: 'eng-1-fix-login', base: 'release' })
  await f.server.close()
}, 30_000)

test('a merged read after a parallel read saved a branch move still makes the run start fresh', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = fanOutFactory(repo.root)
  await roundTwoPlanned(f)
  git(repo.origin, 'branch', '-m', 'eng-1-fix-login', 'eng-1-login')
  gh.openPullRequest('eng-1-login', PR_41)
  gh.holdState('OPEN', 'eng-1-login')
  gh.holdState('MERGED', 'eng-1-login')
  const views = prViews()
  f.api.agents.setPaused(REVIEWER, false)
  f.api.sim.advance(1)
  await until(() => prViews() === views + 1)
  gh.setState('eng-1-login', 'MERGED')
  f.api.agents.setPaused(CODER, false)
  f.api.sim.advance(1)
  await until(() => prViews() === views + 2)
  gh.releaseState('OPEN', 'eng-1-login')
  await until(() => pullRequestLogs(f).length === 1)
  gh.releaseState('MERGED', 'eng-1-login')
  await drain(f)
  const [coder, reviewer] = [lastRunOf(f, CODER), lastRunOf(f, REVIEWER)]
  expect(pullRequestLogs(f)).toEqual(['pull request #41 moved to branch eng-1-login', 'pull request #41 was merged, so this run starts a fresh branch'])
  expect(record(f)).toMatchObject({ round: 2, rework: { kind: 'fresh', state: 'merged' } })
  expect(promptsOf(f, 2)['Coder']).toBe(`${plannerOutput(f)}\n\n## Rework round 2\n\n${MERGED_41}`)
  expect(promptsOf(f, 2)['Reviewer']).toBe(`${plannerOutput(f)}\n\n## Rework round 2\n\n${CONTINUE_41.replace('eng-1-fix-login', 'eng-1-login')}`)
  expect(git(workdirOf(f, coder), 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(git(workdirOf(f, reviewer), 'branch', '--show-current')).toBe(`factory-${reviewer.id}`)
  await f.server.close()
}, 30_000)

test('a run whose second read of the pull request is overtaken too fails without guessing its base', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const siblings = [REVIEWER, QA]
  const f = fanOutFactory(repo.root, agentRunner((task) => (siblings.includes(task.agentId) && task.title.includes('(round 2)') ? 'hang' : 'commit')), siblings)
  await roundTwoPlanned(f, siblings)
  for (const base of ['b1', 'b2', 'b3', 'b4']) {
    git(repo.origin, 'branch', base, 'main')
    gh.holdState('OPEN', 'eng-1-fix-login', base)
  }
  const views = prViews()
  const readFrom = async (agent: AgentId, base: string, reads: number) => {
    gh.openPullRequest('eng-1-fix-login', PR_41, base)
    f.api.agents.setPaused(agent, false)
    f.api.sim.advance(1)
    await until(() => prViews() === views + reads)
  }
  await readFrom(CODER, 'b1', 1)
  await readFrom(REVIEWER, 'b2', 2)
  gh.releaseState('OPEN', 'eng-1-fix-login', 'b2')
  await until(() => pullRequestLogs(f).length === 1)
  await readFrom(QA, 'b3', 3)
  gh.openPullRequest('eng-1-fix-login', PR_41, 'b4')
  gh.releaseState('OPEN', 'eng-1-fix-login', 'b1')
  await until(() => prViews() === views + 4)
  gh.releaseState('OPEN', 'eng-1-fix-login', 'b3')
  await until(() => pullRequestLogs(f).length === 2)
  gh.releaseState('OPEN', 'eng-1-fix-login', 'b4')
  await until(() => lastRunOf(f, CODER).status === 'failed')
  expect(lastRunOf(f, CODER).error).toBe('delivery failed: pull request #41 changed again while this run read it')
  expect(pullRequestLogs(f)).toEqual(['pull request #41 was retargeted to b2', 'pull request #41 was retargeted to b3'])
  expect(record(f).rework).toMatchObject({ kind: 'continue', branch: 'eng-1-fix-login', base: 'b3' })
  await f.server.close()
}, 30_000)

test('the fake gh holds a read of a pull request whose branches contain a slash until it is released', async () => {
  gh.openPullRequest('feature/login', PR_41, 'release/1')
  gh.holdState('OPEN', 'feature/login', 'release/1')
  let answer: string | null = null
  const read = new Promise<void>((resolve) => execFile('gh', ['pr', 'view', PR_41], (_error, stdout) => { answer = stdout; resolve() }))
  await until(() => prViews() === 1)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(answer).toBeNull()
  gh.releaseState('OPEN', 'feature/login', 'release/1')
  await read
  expect(JSON.parse(answer!)).toMatchObject({ headRefName: 'feature/login', baseRefName: 'release/1', state: 'OPEN' })
})
