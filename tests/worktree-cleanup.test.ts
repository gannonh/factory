/**
 * What a run leaves under `.factory-runs` (ADR 0009), against real git: a bare repository is `origin`, the sandbox root is
 * its clone, a fake `gh` serves pull requests, and the agent is an in-process runner that commits a file.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { removeWorkdir } from '../server/runners'
import { MockServer } from '../server/simulation'
import type { RunId } from '../src/domain/types'
import { memoryStore, RNG } from './fixture'
import {
  CODER, ENG_1, addReviewer, agentRunner, clock, coderRuns, control, factory, git, linear, nextRun, poll, repository, seen, tempDir, until, workdirOf,
  type Factory,
} from './rework-delivery-fixture'

const worktreePaths = (root: string) => git(root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
const runWorktrees = (root: string) => worktreePaths(root).filter((path) => path.includes('/.factory-runs/'))
const localBranches = (root: string) => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)
const originBranches = (origin: string) => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)
const ownerFile = (f: Pick<Factory, 'root'>, id: string) => join(f.root, '.factory-runs', `${id}.owner`)
const enqueue = (f: Factory, title = 'Add change') => f.api.agents.enqueue(CODER, { title, prompt: 'p', priority: 'normal' })

/** Starts a run whose agent never answers and waits until its worktree is there. */
async function startHanging(f: Factory) {
  enqueue(f)
  f.api.sim.advance(1)
  await until(() => seen.length === 1)
  const [run] = coderRuns(f)
  expect(runWorktrees(f.root)).toEqual([workdirOf(f, run)])
  return run
}

test('a succeeded delivering run leaves no worktree, registration or local branch, its pushed branch stays on origin, and the handoff still carries its output', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner())
  addReviewer(f, 'none')
  enqueue(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(runWorktrees(repo.root)).toEqual([])
  expect(existsSync(workdirOf(f, run))).toBe(false)
  expect(existsSync(ownerFile(f, run.id))).toBe(false)
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(originBranches(repo.origin)).toEqual([`factory-${run.id}`, 'main'])
  expect(run.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #41', url: 'https://github.com/example/factory/pull/41' })
  const handoff = Object.values(f.server.snapshot().tasks).find((t) => t.origin.kind === 'handoff')!
  expect(handoff.input).toEqual({ ...run.output, runId: run.id })
  expect(handoff.prompt).toContain('pr: Pull request #41 (https://github.com/example/factory/pull/41)')
  await f.server.close()
})

test('an issue run’s delivery branch leaves the sandbox root and stays on origin, so the next attempt takes no suffix for it', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  await poll(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(originBranches(repo.origin)).toEqual(['eng-1-fix-login', 'main'])
  expect(f.server.snapshot().intake[ENG_1].prBranches).toEqual(['eng-1-fix-login'])
  await f.server.close()
})

test('a run with delivery off leaves no factory-<run id> branch either', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner())
  f.api.agents.update(CODER, { delivery: 'none' })
  enqueue(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(originBranches(repo.origin)).toEqual(['main'])
  await f.server.close()
})

test('a run in a root that is not a git repository keeps its plain directory and logs no removal failure', async () => {
  const root = tempDir()
  const f = factory(root, { execution: 'local', start: (_input, emit) => emit({ kind: 'complete', status: 'succeeded', result: 'Done.' }), kill() {} })
  f.api.agents.update(CODER, { delivery: 'none' })
  enqueue(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(existsSync(workdirOf(f, run))).toBe(true)
  expect(f.server.snapshot().logs.filter((line) => line.level === 'warn')).toEqual([])
  await f.server.close()
})

test('a failed run and a cancelled run leave no worktree or branch', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner((task) => (task.title === 'Fails' ? 'fail' : 'hang')))
  f.api.agents.update(CODER, { retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } })
  enqueue(f, 'Fails')
  const failed = await nextRun(f)
  expect(failed).toMatchObject({ status: 'failed', error: 'tests failed' })

  enqueue(f, 'Hangs')
  f.api.sim.advance(1)
  await until(() => seen.length === 2)
  const hanging = coderRuns(f)[1]
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, hanging)])
  f.api.tasks.cancel(hanging.taskId)
  await f.api.sim.settled()

  expect(f.server.snapshot().runs[hanging.id].status).toBe('cancelled')
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(originBranches(repo.origin)).toEqual(['main'])
  expect([failed.id, hanging.id].map((id) => existsSync(join(repo.root, '.factory-runs', id)) || existsSync(ownerFile(f, id)))).toEqual([false, false])
  await f.server.close()
})

test('a run whose push is rejected fails and leaves neither its worktree nor its local branch, and nothing on origin', async () => {
  const repo = repository()
  writeFileSync(join(repo.origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "pushes are frozen" >&2\nexit 1\n')
  chmodSync(join(repo.origin, 'hooks', 'pre-receive'), 0o755)
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  f.api.agents.update(CODER, { retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } })
  await poll(f)
  const run = await nextRun(f)

  expect(run).toMatchObject({ status: 'failed', error: 'delivery failed: git push: ! [remote rejected] HEAD -> eng-1-fix-login (pre-receive hook declined)' })
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(originBranches(repo.origin)).toEqual(['main'])
  await f.server.close()
})

test('a server stopped during a run removes the run’s worktree and branch when the next one starts', async () => {
  const repo = repository()
  const store = memoryStore()
  const f = factory(repo.root, agentRunner(() => 'hang'), undefined, store)
  const run = await startHanging(f)
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main'])
  await f.server.close()
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])

  const restarted = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock, store })
  await restarted.settled()

  expect(restarted.snapshot().runs[run.id]).toMatchObject({ status: 'failed', error: 'interrupted by restart' })
  expect(runWorktrees(repo.root)).toEqual([])
  expect(existsSync(workdirOf(f, run))).toBe(false)
  expect(existsSync(ownerFile(f, run.id))).toBe(false)
  expect(localBranches(repo.root)).toEqual(['main'])
  await restarted.close()
})

test('a run the saved world never recorded is removed at the next start too', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner(() => 'hang'))
  const run = await startHanging(f)
  await f.server.close()

  const restarted = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock, store: memoryStore() })
  await restarted.settled()

  expect(restarted.snapshot().runs[run.id]).toBeUndefined()
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  await restarted.close()
})

test('a start after a crash part way through the removal finishes it, whichever step was reached', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner(() => 'hang'))
  const run = await startHanging(f)
  await f.server.close()
  // The crash came after the directory was deleted but before its registration was pruned.
  rmSync(workdirOf(f, run), { recursive: true, force: true })
  expect(git(repo.root, 'worktree', 'list', '--porcelain')).toContain(workdirOf(f, run))

  const restarted = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock, store: memoryStore() })
  await restarted.settled()
  expect(git(repo.root, 'worktree', 'list', '--porcelain')).not.toContain('.factory-runs')
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(existsSync(ownerFile(f, run.id))).toBe(false)

  // Removing again, or removing a run Factory never made a worktree for, changes nothing.
  await removeWorkdir(repo.root, run.id)
  await removeWorkdir(repo.root, 'run-never-made' as RunId)
  expect(localBranches(repo.root)).toEqual(['main'])
  await restarted.close()
})

test('a worktree whose owner server is still alive is left alone, and removed once that server is gone', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner(() => 'hang'))
  const run = await startHanging(f)
  await f.server.close()
  const owner = JSON.parse(readFileSync(ownerFile(f, run.id), 'utf8')) as { branch: string; pid: number }
  expect(owner).toEqual({ branch: `factory-${run.id}`, pid: process.pid })

  writeFileSync(ownerFile(f, run.id), JSON.stringify({ ...owner, pid: process.ppid }))
  const beside = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock, store: memoryStore() })
  await beside.settled()
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])
  await beside.close()

  writeFileSync(ownerFile(f, run.id), JSON.stringify({ ...owner, pid: 2 ** 22 + 1 }))
  const after = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock, store: memoryStore() })
  await after.settled()
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  await after.close()
})

test('a worktree from before owner files is removed with its factory-<run id> branch, and a worktree of someone else’s is not', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner(() => 'hang'))
  const run = await startHanging(f)
  await f.server.close()
  rmSync(ownerFile(f, run.id))
  git(repo.root, 'worktree', 'add', '--quiet', '-b', 'mine', join(repo.root, '.factory-runs', 'by-hand'), 'origin/main')

  const restarted = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock, store: memoryStore() })
  await restarted.settled()

  expect(runWorktrees(repo.root)).toEqual([join(repo.root, '.factory-runs', 'by-hand')])
  expect(localBranches(repo.root)).toEqual(['main', 'mine'])
  await restarted.close()
})

