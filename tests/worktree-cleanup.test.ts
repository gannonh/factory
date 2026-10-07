/**
 * What a run leaves under `.factory-runs` (ADR 0009), against real git: a bare repository is `origin`, the sandbox root is
 * its clone, a fake `gh` serves pull requests, and the agent is an in-process runner that commits a file. Removal only
 * takes what it can prove Factory made: the worktree's lock reason and the branch's reflog must match the owner file.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { removeWorkdir } from '../server/runners'
import { MockServer } from '../server/simulation'
import type { RunId } from '../src/domain/types'
import { memoryStore, RNG } from './fixture'
import { ranOf } from './ran'
import {
  CODER, ENG_1, LOCAL, addReviewer, agentRunner, clock, coderRuns, control, factory, git, linear, nextRun, poll, realGit, repository, seen, tempDir, until, workdirOf,
  type Factory,
} from './rework-delivery-fixture'

const worktreePaths = (root: string) => git(root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
const runWorktrees = (root: string) => worktreePaths(root).filter((path) => path.includes('/.factory-runs/'))
const localBranches = (root: string) => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)
const originBranches = (origin: string) => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)
const ownerFile = (f: Pick<Factory, 'root'>, id: string) => join(f.root, '.factory-runs', `${id}.owner`)
const enqueue = (f: Factory, title = 'Add change') => f.api.agents.enqueue(CODER, { title, prompt: 'p', priority: 'normal' })
const warnings = (server: MockServer) => server.snapshot().logs.filter((line) => line.level === 'warn').map((line) => line.msg)
const removals = (server: MockServer) => server.snapshot().logs.filter((line) => line.level === 'info' && line.msg.startsWith('removed ')).map((line) => [line.runId, line.msg])
const restart = (root: string, store = memoryStore()) => new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: root, linear: linear(), clock, store })
type Owner = { branch: string; initialHead: string; token: string; server: { pid: number; started: string } }
const readOwner = (f: Pick<Factory, 'root'>, id: string) => JSON.parse(readFileSync(ownerFile(f, id), 'utf8')) as Owner
const processStart = (pid: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).trim()

/** Starts a run whose agent never answers and waits until its worktree is there. */
async function startHanging(f: Factory) {
  enqueue(f)
  f.api.sim.advance(1)
  await until(() => seen.length === 1)
  const [run] = coderRuns(f)
  expect(runWorktrees(f.root)).toEqual([workdirOf(f, run)])
  return run
}

/** A run killed with its server, whose worktree, branch and owner file are all still there. */
async function killedRun(repo: ReturnType<typeof repository>, store = memoryStore()) {
  const f = factory(repo.root, agentRunner(() => 'hang'), undefined, store)
  f.api.agents.update(CODER, { retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } })
  const run = await startHanging(f)
  await f.server.close()
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main'])
  return { f, run, workdir: workdirOf(f, run), branch: `factory-${run.id}` }
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
  expect(warnings(f.server)).toEqual([])
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

test('a repository with SHA-256 object ids loses its run branch like any other', async () => {
  const repo = repository('sha256')
  const f = factory(repo.root, agentRunner())
  f.api.agents.update(CODER, { delivery: 'none' })
  enqueue(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(ranOf(run).head).toMatch(/^[0-9a-f]{64}$/)
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(warnings(f.server)).toEqual([])
  await f.server.close()
})

test('on a git older than 2.36 a run in a git root fails, naming the floor, and leaves nothing', async () => {
  const repo = repository()
  const bin = join(tempDir(), 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!/bin/sh
for arg in "$@"; do
  [ "$arg" = version ] && { echo "git version 2.35.1"; exit 0; }
  [ "$arg" = --reason ] && { echo "error: unknown option \\\`reason'" >&2; exit 129; }
done
exec ${realGit} "$@"
`)
  chmodSync(join(bin, 'git'), 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous}`
  try {
    const f = factory(repo.root, agentRunner())
    f.api.agents.update(CODER, { retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } })
    enqueue(f)
    const delivering = await nextRun(f)
    expect(delivering).toMatchObject({ status: 'failed', error: "delivery failed: git worktree add: error: unknown option `reason' (locking the worktree needs git 2.36 or later; this is git 2.35.1)" })

    f.api.agents.update(CODER, { delivery: 'none' })
    enqueue(f)
    const plain = await nextRun(f)
    expect(plain).toMatchObject({ status: 'failed', error: "git worktree add: error: unknown option `reason' (locking the worktree needs git 2.36 or later; this is git 2.35.1)" })

    expect(seen).toEqual([])
    expect(runWorktrees(repo.root)).toEqual([])
    expect(localBranches(repo.root)).toEqual(['main'])
    expect(readdirSync(join(repo.root, '.factory-runs'))).toEqual([])
    await f.server.close()
  } finally { process.env.PATH = previous }
})

test('a run in a root that is not a git repository keeps its plain directory and logs no removal failure', async () => {
  const root = tempDir()
  const f = factory(root, { execution: 'local', start: (_input, emit) => emit({ kind: 'complete', status: 'succeeded', result: 'Done.' }), kill() {} })
  f.api.agents.update(CODER, { delivery: 'none' })
  enqueue(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(existsSync(workdirOf(f, run))).toBe(true)
  expect(warnings(f.server)).toEqual([])
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

test('a post-checkout hook that fails after git made the worktree and branch fails the run, and the run still leaves nothing', async () => {
  const repo = repository()
  writeFileSync(join(repo.root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n')
  chmodSync(join(repo.root, '.git', 'hooks', 'post-checkout'), 0o755)
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  f.api.agents.update(CODER, { retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } })
  await poll(f)
  const issueRun = await nextRun(f)
  expect(issueRun.status).toBe('failed')
  expect(issueRun.error).toMatch(/^delivery failed: git worktree add: .*hook says no/s)

  f.api.agents.update(CODER, { delivery: 'none' })
  enqueue(f)
  const plainRun = await nextRun(f)
  expect(plainRun.status).toBe('failed')
  expect(plainRun.error).toContain('hook says no')

  expect(seen).toEqual([])
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(originBranches(repo.origin)).toEqual(['main'])
  expect(readdirSync(join(repo.root, '.factory-runs'))).toEqual([])
  expect(warnings(f.server).filter((msg) => msg.includes('worktree'))).toEqual([])
  await f.server.close()
})

test('an agent cannot lock its worktree, since Factory holds the lock as its mark, and the run still cleans up', async () => {
  const repo = repository()
  const refusals: string[] = []
  let token = ''
  const f = factory(repo.root, agentRunner(undefined, undefined, (_task, workdir) => {
    token = (JSON.parse(readFileSync(`${workdir}.owner`, 'utf8')) as Owner).token
    try { git(workdir, 'worktree', 'lock', '.') } catch (error) { refusals.push((error as { stderr: string }).stderr.trim()) }
  }))
  enqueue(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(token).toMatch(new RegExp(`^factory ${run.id} [0-9a-f]{16}$`))
  expect(refusals).toEqual([`fatal: '.' is already locked, reason: ${token}`])
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  await f.server.close()
})

test('a worktree an agent unlocked and relocked is no longer provably Factory’s, so it stays, with a warning, and its owner file goes; the next start keeps it too', async () => {
  const repo = repository()
  const store = memoryStore()
  const f = factory(repo.root, agentRunner(undefined, undefined, (_task, workdir) => {
    git(workdir, 'worktree', 'unlock', '.')
    git(workdir, 'worktree', 'lock', '--reason', 'mine now', '.')
  }), undefined, store)
  f.api.agents.update(CODER, { delivery: 'none' })
  enqueue(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main'])
  expect(existsSync(ownerFile(f, run.id))).toBe(false)
  expect(warnings(f.server)).toEqual([
    `left alone: worktree ${workdirOf(f, run)} (its lock reason is not this run's mark); branch factory-${run.id} (checked out there)`,
  ])
  await f.server.close()

  // Now there is no owner file, and this server knows the run ended, but the lock is one Factory did not write.
  const restarted = restart(repo.root, store)
  await restarted.settled()
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main'])
  expect(warnings(restarted)).toEqual([`left alone: worktree ${workdirOf(f, run)} (no owner file, and locked: mine now)`])
  await restarted.close()
})

test('run-private fetch refs under refs/factory/<run id>/ go with the worktree', async () => {
  const repo = repository()
  const f = factory(repo.root, agentRunner(undefined, undefined, (_task, workdir) => {
    git(workdir, 'update-ref', `refs/factory/${coderRuns(f)[0].id}/0`, 'HEAD')
    git(workdir, 'update-ref', 'refs/factory/other-run/0', 'HEAD')
  }))
  enqueue(f)
  const run = await nextRun(f)

  expect(run.status).toBe('succeeded')
  expect(git(repo.root, 'for-each-ref', '--format=%(refname)', 'refs/factory/')).toBe('refs/factory/other-run/0')
  await f.server.close()
})

test('changing a local sandbox’s root is refused while a run is on it, and accepted once the run ended', async () => {
  const repo = repository()
  const other = repository()
  const f = factory(repo.root, agentRunner(() => 'hang'))
  const run = await startHanging(f)

  expect(() => f.api.sandboxes.update(LOCAL, { host: other.root })).toThrow('a run is in progress on this sandbox; change its root once it ends')
  expect(f.server.snapshot().sandboxes[LOCAL].host).toBe(repo.root)
  f.api.tasks.cancel(run.taskId)
  await f.api.sim.settled()
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])

  f.api.sandboxes.update(LOCAL, { host: other.root })
  expect(f.server.snapshot().sandboxes[LOCAL].host).toBe(other.root)
  await f.server.close()
})

test('a server stopped during a run removes the run’s worktree and branch when the next one starts', async () => {
  const repo = repository()
  const store = memoryStore()
  const { f, run } = await killedRun(repo, store)

  const restarted = restart(repo.root, store)
  await restarted.settled()

  expect(restarted.snapshot().runs[run.id]).toMatchObject({ status: 'failed', error: 'interrupted by restart' })
  expect(runWorktrees(repo.root)).toEqual([])
  expect(existsSync(workdirOf(f, run))).toBe(false)
  expect(existsSync(ownerFile(f, run.id))).toBe(false)
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(warnings(restarted)).toEqual([])
  await restarted.close()
})

test('a run the saved world never recorded is removed at the next start too', async () => {
  const repo = repository()
  const { run } = await killedRun(repo)

  const restarted = restart(repo.root)
  await restarted.settled()

  expect(restarted.snapshot().runs[run.id]).toBeUndefined()
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  await restarted.close()
})

test('a start after a crash part way through the removal finishes it, whichever step was reached', async () => {
  const repo = repository()
  const { f, run, workdir } = await killedRun(repo)
  // The crash came after the directory was deleted but before its registration was pruned.
  rmSync(workdir, { recursive: true, force: true })
  expect(git(repo.root, 'worktree', 'list', '--porcelain')).toContain(workdir)

  const restarted = restart(repo.root)
  await restarted.settled()
  expect(git(repo.root, 'worktree', 'list', '--porcelain')).not.toContain('.factory-runs')
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(existsSync(ownerFile(f, run.id))).toBe(false)

  // Removing again, or removing a run Factory never made a worktree for, changes nothing.
  expect(await removeWorkdir(repo.root, run.id, true)).toEqual({ left: [], legacy: [] })
  expect(await removeWorkdir(repo.root, 'run-never-made' as RunId, false)).toEqual({ left: [], legacy: [] })
  expect(localBranches(repo.root)).toEqual(['main'])
  await restarted.close()
})

test('a worktree whose .git file the agent deleted is still removed, since its registration carries Factory’s mark', async () => {
  const repo = repository()
  const { f, run, workdir } = await killedRun(repo)
  rmSync(join(workdir, '.git'))

  const restarted = restart(repo.root)
  await restarted.settled()
  expect(existsSync(workdir)).toBe(false)
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(existsSync(ownerFile(f, run.id))).toBe(false)
  await restarted.close()
})

test('a stale owner file, left by a crash after the removal, does not authorize removing a worktree someone made at the same path', async () => {
  const repo = repository()
  const { f, run, workdir, branch } = await killedRun(repo)
  git(repo.root, 'worktree', 'remove', '--force', '--force', workdir)
  git(repo.root, 'branch', '-D', branch)
  git(repo.root, 'worktree', 'add', '--quiet', '-b', 'mine', workdir, 'origin/main')
  writeFileSync(join(workdir, 'unsaved.txt'), 'hours of work')

  const restarted = restart(repo.root)
  await restarted.settled()

  expect(runWorktrees(repo.root)).toEqual([workdir])
  expect(readFileSync(join(workdir, 'unsaved.txt'), 'utf8')).toBe('hours of work')
  expect(localBranches(repo.root)).toEqual(['main', 'mine'])
  expect(existsSync(ownerFile(f, run.id))).toBe(false)
  expect(warnings(restarted)).toEqual([`left alone: worktree ${workdir} (its lock reason is not this run's mark)`])
  await restarted.close()
})

test('a branch someone recreated after a crash between the branch deletion and the owner file deletion stays', async () => {
  const repo = repository()
  const { f, run, workdir, branch } = await killedRun(repo)
  git(repo.root, 'worktree', 'remove', '--force', '--force', workdir)
  git(repo.root, 'branch', '-D', branch)
  git(repo.root, 'branch', branch, 'origin/main')
  const recreated = git(repo.root, 'rev-parse', branch)
  const { initialHead } = readOwner(f, run.id)

  const restarted = restart(repo.root)
  await restarted.settled()

  expect(localBranches(repo.root)).toEqual([branch, 'main'])
  expect(git(repo.root, 'rev-parse', branch)).toBe(recreated)
  expect(existsSync(ownerFile(f, run.id))).toBe(false)
  expect(warnings(restarted)).toEqual([`left alone: branch ${branch} (its reflog does not start at ${initialHead})`])
  await restarted.close()
})

test('nothing under a .factory-runs that became a symlink is removed at a restart', async () => {
  const repo = repository()
  const { run, workdir } = await killedRun(repo)
  const elsewhere = join(tempDir(), 'elsewhere')
  renameSync(join(repo.root, '.factory-runs'), elsewhere)
  symlinkSync(elsewhere, join(repo.root, '.factory-runs'))
  writeFileSync(join(elsewhere, run.id, 'unsaved.txt'), 'hours of work')

  const restarted = restart(repo.root)
  await restarted.settled()
  expect(readdirSync(elsewhere).sort()).toEqual([run.id, `${run.id}.owner`])
  expect(readFileSync(join(elsewhere, run.id, 'unsaved.txt'), 'utf8')).toBe('hours of work')
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main'])
  expect(warnings(restarted)).toEqual([`worktree of run ${run.id} not removed, the next start retries: ${join(repo.root, '.factory-runs')} is a symlink to ${elsewhere}; Factory needs a directory there`])
  expect(git(repo.root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${workdir}`)
  await restarted.close()
})

test('a worktree whose owner server is still alive is left alone, and removed once that server is gone or its pid was reused', async () => {
  const repo = repository()
  const { f, run } = await killedRun(repo)
  const owner = readOwner(f, run.id)
  expect(owner).toEqual({ branch: `factory-${run.id}`, initialHead: git(repo.root, 'rev-parse', 'HEAD'), token: `factory ${run.id} ${owner.token.split(' ')[2]}`, server: { pid: process.pid, started: processStart(process.pid) } })
  expect(owner.token.split(' ')[2]).toMatch(/^[0-9a-f]{16}$/)

  writeFileSync(ownerFile(f, run.id), JSON.stringify({ ...owner, server: { pid: process.ppid, started: processStart(process.ppid) } }))
  const beside = restart(repo.root)
  await beside.settled()
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])
  expect(warnings(beside)).toEqual([])
  await beside.close()

  // The owner server could not read its own start time, so a live pid cannot be shown to be a reused one.
  writeFileSync(ownerFile(f, run.id), JSON.stringify({ ...owner, server: { pid: process.ppid, started: '' } }))
  const unknown = restart(repo.root)
  await unknown.settled()
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main'])
  expect(warnings(unknown)).toEqual([])
  await unknown.close()

  // The same pid, but a process started at another time: the owner server died and its pid was reused.
  writeFileSync(ownerFile(f, run.id), JSON.stringify({ ...owner, server: { pid: process.ppid, started: 'Mon Jan  1 00:00:00 2001' } }))
  const reused = restart(repo.root)
  await reused.settled()
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  await reused.close()
})

test('a worktree whose owner file holds a pid no process can have is left alone', async () => {
  const repo = repository()
  const { f, run } = await killedRun(repo)
  const owner = readOwner(f, run.id)
  writeFileSync(ownerFile(f, run.id), JSON.stringify({ ...owner, server: { pid: 1.5, started: 'Mon Jan  1 00:00:00 2001' } }))
  const restarted = restart(repo.root)
  await restarted.settled()
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main'])
  await restarted.close()
})

test('a server restoring a world whose run another live server still works on leaves that run’s worktree and branch alone', async () => {
  const repo = repository()
  const store = memoryStore()
  const f = factory(repo.root, agentRunner(() => 'hang'), undefined, store)
  f.api.agents.update(CODER, { retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } })
  const run = await startHanging(f)
  f.server.flush()
  const owner = readOwner(f, run.id)
  // Both servers share this process's pid here, so the live owner is stood in by this process's parent.
  writeFileSync(ownerFile(f, run.id), JSON.stringify({ ...owner, server: { pid: process.ppid, started: processStart(process.ppid) } }))

  const second = restart(repo.root, store)
  await second.settled()
  expect(second.snapshot().runs[run.id]).toMatchObject({ status: 'failed', error: 'interrupted by restart' })
  expect(runWorktrees(repo.root)).toEqual([workdirOf(f, run)])
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main'])
  expect(existsSync(ownerFile(f, run.id))).toBe(true)
  expect(warnings(second)).toEqual([`left alone: the worktree and branch of run ${run.id} (server process ${process.ppid}, which made them, is still running)`])
  await second.close()

  // The server that made them removes them once its run ends.
  writeFileSync(ownerFile(f, run.id), JSON.stringify(owner))
  f.api.tasks.cancel(run.taskId)
  await f.api.sim.settled()
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(existsSync(ownerFile(f, run.id))).toBe(false)
  await f.server.close()
})

test('a worktree from before owner files is removed with its factory-<run id> branch only when this server knows its run ended, and that removal is logged with the branch’s commit; someone else’s stays', async () => {
  const repo = repository()
  const store = memoryStore()
  const { f, run } = await killedRun(repo, store)
  const head = git(repo.root, 'rev-parse', `factory-${run.id}`)
  // A worktree from before owner files has no owner file and no lock.
  rmSync(ownerFile(f, run.id))
  git(repo.root, 'worktree', 'unlock', workdirOf(f, run))
  git(repo.root, 'worktree', 'add', '--quiet', '-b', 'mine', join(repo.root, '.factory-runs', 'by-hand'), 'origin/main')

  // A server with another data directory does not know the run, so it may be another server's live run.
  const stranger = restart(repo.root)
  await stranger.settled()
  expect(runWorktrees(repo.root)).toEqual([join(repo.root, '.factory-runs', 'by-hand'), workdirOf(f, run)])
  expect(localBranches(repo.root)).toEqual([`factory-${run.id}`, 'main', 'mine'])
  expect(warnings(stranger).sort()).toEqual([
    `left alone: worktree ${join(repo.root, '.factory-runs', 'by-hand')} (no owner file, and this server does not know run by-hand to have ended)`,
    `left alone: worktree ${workdirOf(f, run)} (no owner file, and this server does not know run ${run.id} to have ended)`,
  ].sort())
  await stranger.close()

  const restarted = restart(repo.root, store)
  await restarted.settled()
  expect(runWorktrees(repo.root)).toEqual([join(repo.root, '.factory-runs', 'by-hand')])
  expect(localBranches(repo.root)).toEqual(['main', 'mine'])
  expect(warnings(restarted)).toEqual([`left alone: worktree ${join(repo.root, '.factory-runs', 'by-hand')} (no owner file, and this server does not know run by-hand to have ended)`])
  expect(removals(restarted)).toEqual([[run.id, `removed worktree ${workdirOf(f, run)} and branch factory-${run.id}, made before owner files; its commits can be recovered from ${head} until git prunes them`]])
  await restarted.close()
})

test('a run started while .factory-runs is a symlink fails before any worktree is made', async () => {
  const repo = repository()
  const elsewhere = join(tempDir(), 'elsewhere')
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, join(repo.root, '.factory-runs'))
  const f = factory(repo.root, agentRunner())
  f.api.agents.update(CODER, { retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } })
  enqueue(f)
  const run = await nextRun(f)

  expect(run).toMatchObject({ status: 'failed', error: `${join(repo.root, '.factory-runs')} is a symlink to ${elsewhere}; Factory needs a directory there` })
  expect(seen).toEqual([])
  expect(readdirSync(elsewhere)).toEqual([])
  expect(runWorktrees(repo.root)).toEqual([])
  expect(localBranches(repo.root)).toEqual(['main'])
  await f.server.close()
})
