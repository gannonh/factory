/**
 * Where a rework round's commits go (ADR 0012) when its pull request is merged or closed while the round waits or while
 * its agent works: the run-start and delivery-time reads, the replay onto the default branch, retired branch names and
 * cancels during delivery.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createApi } from '../server/api'
import { intakeRecord } from '../server/records'
import { MockServer } from '../server/simulation'
import type { IntakeRecord, Run, Task } from '../src/domain/types'
import { memoryStore, RNG } from './fixture'
import {
  ENG_1, ISSUE_URL, PR_41, PR_42, LIFECYCLE, REVIEWER, addReviewer, agentRunner, agentRuns, clock, coderRuns, commitFile, control, factory, gh, git,
  issue, issueTasks, linear, moveIssue, nextRun, poll, prViews, realGit, record, repository, roundTwoTaken, seen, tempDir, until, workdirOf, type Factory,
} from './rework-delivery-fixture'

/** Squash-merges `branch` into origin's `main`, as GitHub does, then commits `edit` to change.txt on `main` when given. */
function squashMerge(repo: { seed: string }, branch: string, edit?: string) {
  git(repo.seed, 'fetch', '--quiet', 'origin')
  git(repo.seed, 'checkout', '--quiet', '-B', 'main', 'origin/main')
  git(repo.seed, 'merge', '--squash', `origin/${branch}`)
  git(repo.seed, 'commit', '--quiet', '-m', 'Fix login (#41)')
  if (edit) commitFile(repo.seed, 'change.txt', edit)
  git(repo.seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
}

/**
 * GitHub deleting a merged PR's branch, and the sandbox root losing the local copy that `run` (round 1's by default)
 * worked on, so only Factory's rule keeps the name retired.
 */
function deleteBranch(f: Factory, repo: { origin: string; root: string }, branch: string, run: Run = coderRuns(f)[0]) {
  git(repo.origin, 'update-ref', '-d', `refs/heads/${branch}`)
  git(repo.root, 'worktree', 'remove', '--force', workdirOf(f, run))
  git(repo.root, 'branch', '-D', branch)
}

/**
 * Puts a `git` first on PATH that runs the sh `script` and then the real git. The script sees `$sub` and `$next`, the
 * subcommand and its first argument after any `-C <dir>`, and `$real`, the real git.
 */
function wrapGit(script: string) {
  const dir = tempDir()
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'git'), `#!/bin/sh
real=${realGit}
sub="$1"; next="$2"
if [ "$1" = -C ]; then sub="$3"; next="$4"; fi
${script}
exec "$real" "$@"
`)
  chmodSync(join(dir, 'bin', 'git'), 0o755)
  process.env.PATH = `${join(dir, 'bin')}:${process.env.PATH}`
  return dir
}

/** Once `hold` is called, git stops at the next `<command> [<arg>]` until `release`. */
function holdGit(command: string, arg = '') {
  const dir = tempDir()
  const marker = join(dir, 'hold')
  const reached = join(dir, 'reached')
  wrapGit(`if [ "$sub" = ${command} ] && { [ -z "${arg}" ] || [ "$next" = "${arg}" ]; } && [ -e ${marker} ]; then
  touch ${reached}; while [ -e ${marker} ]; do sleep 0.02; done
fi`)
  return { hold: () => writeFileSync(marker, ''), reached: () => existsSync(reached), release: () => rmSync(marker, { force: true }) }
}

/**
 * Once `take(n)` is called, each of the next `n` pushes to `refs/heads/<name>` finds `<name>` already created on
 * `origin` at `main` by someone else, as another clone racing for the same fresh name would. With `translated`, every
 * push not run under `LC_ALL=C` prints git's "(stale info)" in German, as a git whose catalog translates it would.
 */
function takeBranches(origin: string, translated = false) {
  const left = join(tempDir(), 'left')
  wrapGit(`if [ "$sub" = push ] && [ -s ${left} ] && [ "$(cat ${left})" -gt 0 ]; then
  for a in "$@"; do case "$a" in *:refs/heads/*) "$real" -C ${origin} update-ref "\${a#*:}" refs/heads/main;; esac; done
  echo $(($(cat ${left}) - 1)) > ${left}
fi
if ${translated} && [ "$sub" = push ] && [ "$LC_ALL" != C ]; then
  err=$(mktemp); "$real" "$@" 2>"$err"; code=$?
  sed 's/(stale info)/(veraltete Informationen)/' "$err" >&2; rm -f "$err"; exit $code
fi`)
  return { take: (n: number) => writeFileSync(left, String(n)) }
}

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

  const server = new MockServer({ manual: true, rng: RNG, localRunner: agentRunner(), localRoot: repo.root, linear: linear(), clock, store })
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

const ROUND_2 = (task: Task) => task.title.endsWith('(round 2)')
/** The run's worktree as delivery left it, the root's stash list, and how many worktrees remain besides the root. */
const untouched = (f: Factory, run: Run) => ({
  branch: git(workdirOf(f, run), 'branch', '--show-current'),
  head: git(workdirOf(f, run), 'rev-parse', 'HEAD'),
  status: git(workdirOf(f, run), 'status', '--porcelain'),
  stash: git(f.root, 'stash', 'list'),
  worktrees: git(f.root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length - 1,
})
const MERGED_LINE = `Pull request #41 (${PR_41}) was merged, so this round starts a fresh branch and opens a new pull request.`
const MERGED_NOTE = ['**Factory finished this issue (round 2).**', 'Pull request #41 was merged, so this round opened a new pull request.']
const refs = (repo: string, pattern: string) => git(repo, 'for-each-ref', '--format=%(refname:short)', pattern)

test.each([
  ['deleted', true],
  ['kept', false],
] as const)('a pull request squash-merged with its branch %s while round 2’s agent works gets no push, and only the run’s commit opens a new pull request from main', async (_label, deleted) => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  let mergedTip = ''
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) {
      mergedTip = git(repo.origin, 'rev-parse', 'refs/heads/eng-1-fix-login')
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      if (deleted) deleteBranch(f, repo, 'eng-1-fix-login')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)
  const views = prViews()

  const run = await nextRun(f)
  const workdir = workdirOf(f, run)
  expect(run.status).toBe('succeeded')
  expect(prViews()).toBe(views + 2)
  expect(git(repo.origin, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/eng-1-fix-login')).toBe(deleted ? '' : `eng-1-fix-login ${mergedTip}`)
  expect(git(workdir, 'rev-parse', 'HEAD~1')).toBe(mergedTip)
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login-2~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
  expect(git(repo.origin, 'log', '--format=%s', 'main..eng-1-fix-login-2')).toBe('change for ENG-1 Fix login (round 2) (attempt 1)')
  expect(gh.creates().map((c) => c.argv.slice(2, 6))).toEqual([['--head', 'eng-1-fix-login', '--base', 'main'], ['--head', 'eng-1-fix-login-2', '--base', 'main']])
  expect(run.output?.artifacts).toEqual([
    { kind: 'branch', label: 'eng-1-fix-login-2', url: null },
    { kind: 'commit', label: `${git(repo.origin, 'rev-parse', '--short=7', 'eng-1-fix-login-2')} change for ENG-1 Fix login (round 2) (attempt 1)`, url: null },
    { kind: 'pr', label: 'Pull request #42', url: PR_42 },
  ])
  expect(record(f)).toMatchObject({ round: 2, phase: 'ended', rework: { kind: 'fresh', pr: { url: PR_41 }, state: 'merged' }, prBranches: ['eng-1-fix-login', 'eng-1-fix-login-2'], result: { pr: { url: PR_42 } } })
  expect(f.server.snapshot().logs.map((l) => l.msg)).toContain('pull request #41 was merged, so this run starts a fresh branch')
  expect(issueTasks(f)[1].prompt.split('\n\n').at(-1)).toBe(MERGED_LINE)
  const after = await issue('ENG-1')
  expect(after.attachments.map((a) => a.url)).toEqual([PR_41, PR_42])
  expect(after.comments.at(-1)?.body.split('\n\n').slice(0, 2)).toEqual(MERGED_NOTE)
  await f.server.close()
})

test('a run whose commits conflict with the squash-merged default branch fails without a push, and the retry runs the round from main', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  let merged = false
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task) && !merged) {
      merged = true
      squashMerge(repo, 'eng-1-fix-login', 'edited on main after the merge')
      gh.setState('eng-1-fix-login', 'MERGED')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)
  const roundOneTip = git(repo.origin, 'rev-parse', 'eng-1-fix-login')

  const failed = await nextRun(f)
  const agentTip = git(workdirOf(f, failed), 'rev-parse', 'HEAD')
  expect(failed).toMatchObject({ status: 'failed', attempt: 1, error: "delivery failed: the run's commits conflict with origin/main in change.txt" })
  expect(untouched(f, failed)).toEqual({ branch: `factory-${failed.id}`, head: agentTip, status: '', stash: '', worktrees: 2 })
  expect(git(workdirOf(f, failed), 'log', '-1', '--format=%s')).toBe('change for ENG-1 Fix login (round 2) (attempt 1)')
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login')).toBe(roundOneTip)
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(refs(repo.root, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(gh.creates()).toHaveLength(1)
  expect(record(f).rework).toMatchObject({ kind: 'fresh', state: 'merged' })

  const retried = await nextRun(f)
  expect(retried).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect(git(workdirOf(f, retried), 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login-2~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
  expect(record(f)).toMatchObject({ result: { pr: { url: PR_42 } } })
  await f.server.close()
})

test('a pull request closed while round 2’s agent works leaves its rejected commits out of the new pull request', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) gh.setState('eng-1-fix-login', 'CLOSED')
    return 'commit'
  }, (task) => (ROUND_2(task) ? 'round2.txt' : 'change.txt')))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run.status).toBe('succeeded')
  expect(git(repo.origin, 'log', '--format=%s', 'main..eng-1-fix-login-2')).toBe('change for ENG-1 Fix login (round 2) (attempt 1)')
  expect(git(repo.origin, 'ls-tree', '--name-only', 'eng-1-fix-login-2')).toBe('base.txt\nround2.txt')
  expect(record(f)).toMatchObject({ rework: { kind: 'fresh', state: 'closed' }, result: { pr: { url: PR_42 } } })
  expect((await issue('ENG-1')).comments.at(-1)?.body.split('\n\n')[1]).toBe('Pull request #41 was closed, so this round opened a new pull request.')
  await f.server.close()
})

test('the retry after a fresh delivery’s gh pr create fails never reuses the deleted merged branch', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  let merged = false
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task) && !merged) {
      merged = true
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      deleteBranch(f, repo, 'eng-1-fix-login')
      gh.failNext('create')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)

  const failed = await nextRun(f)
  expect(failed).toMatchObject({ status: 'failed', error: 'delivery failed: gh pr create: GraphQL: was submitted too quickly (createPullRequest)' })
  const retried = await nextRun(f)
  expect(retried).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect(git(workdirOf(f, retried), 'branch', '--show-current')).toBe('eng-1-fix-login-3')
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login')).toBe('')
  expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2', 'eng-1-fix-login-3'])
  await f.server.close()
})

test('a second delivering agent that continued before the merge replays its commit onto main instead of pushing to the merged branch', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => {
    if (task.title.endsWith('→ Reviewer')) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)
  addReviewer(f)

  const coder = await nextRun(f)
  expect(coder.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #41', url: PR_41 })
  const coderTip = git(repo.origin, 'rev-parse', 'eng-1-fix-login')
  const reviewer = await nextRun(f, REVIEWER)
  expect(reviewer.status).toBe('succeeded')
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login')).toBe(coderTip)
  expect(git(repo.origin, 'log', '--format=%s', 'main..eng-1-fix-login-2')).toBe('change for ENG-1 Fix login (round 2) → Reviewer (attempt 1)')
  expect(reviewer.output?.artifacts.filter((a) => a.kind === 'branch' || a.kind === 'pr')).toEqual([
    { kind: 'branch', label: 'eng-1-fix-login-2', url: null },
    { kind: 'pr', label: 'Pull request #42', url: PR_42 },
  ])
  expect(record(f)).toMatchObject({ rework: { kind: 'fresh', state: 'merged' }, result: { pr: { url: PR_42 } } })
  await f.server.close()
})

test('a round whose only delivery went to its pull request before that merged says so, not that it delivered nothing', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const held = holdGit('merge-tree')
  const f = factory(repo.root, agentRunner((task) => {
    if (task.title.endsWith('→ Reviewer')) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      held.hold()
    }
    return 'commit'
  }))
  await roundTwoTaken(f)
  addReviewer(f)

  const coder = await nextRun(f)
  expect(coder.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #41', url: PR_41 })
  f.api.sim.advance(1)
  await until(held.reached)
  await moveIssue('ENG-1', 'Done')
  await poll(f)
  held.release()
  await until(() => agentRuns(f, REVIEWER).at(-1)?.status !== 'running')
  await f.api.sim.settled()

  expect(agentRuns(f, REVIEWER).at(-1)).toMatchObject({ status: 'cancelled', error: 'its flow was cancelled' })
  expect(record(f).rework).toMatchObject({ kind: 'fresh', state: 'merged' })
  expect(gh.creates()).toHaveLength(1)
  const after = await issue('ENG-1')
  expect(after.attachments.map((a) => a.url)).toEqual([PR_41])
  expect(after.comments.at(-1)?.body.split('\n\n').slice(0, 2)).toEqual([
    '**Factory stopped work on this issue (round 2): moved to Done in Linear.**',
    'Pull request #41 was merged after this round delivered to it; no new pull request opened.',
  ])
  await f.server.close()
})

test('a delivering agent that starts after the round went fresh never reuses the deleted merged branch', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      deleteBranch(f, repo, 'eng-1-fix-login')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)
  addReviewer(f)

  const coder = await nextRun(f)
  expect(coder.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #42', url: PR_42 })
  const reviewer = await nextRun(f, REVIEWER)
  expect(reviewer.status).toBe('succeeded')
  expect(git(workdirOf(f, reviewer), 'branch', '--show-current')).toBe('eng-1-fix-login-3')
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login')).toBe('')
  expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2', 'eng-1-fix-login-3'])
  await f.server.close()
})

test('a flow cancelled while delivery reads its merged pull request delivers nothing, and the run ends cancelled', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      gh.holdView()
    }
    return 'commit'
  }))
  await roundTwoTaken(f)
  const views = prViews()
  const prompt = issueTasks(f)[1].prompt

  f.api.sim.advance(1)
  await until(() => prViews() === views + 2)
  await moveIssue('ENG-1', 'Done')
  await poll(f)
  expect(record(f).cancel).toEqual({ kind: 'linear', reason: 'moved to Done in Linear' })
  gh.releaseView()
  await until(() => coderRuns(f).at(-1)!.status !== 'running')
  await f.api.sim.settled()

  const run = coderRuns(f).at(-1)!
  expect(run).toMatchObject({ status: 'cancelled', error: 'its flow was cancelled', output: null })
  expect(gh.creates()).toHaveLength(1)
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(refs(repo.root, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(issueTasks(f)[1]).toMatchObject({ status: 'cancelled', prompt })
  expect(record(f).rework).toMatchObject({ kind: 'continue' })
  expect(f.server.snapshot().logs.map((l) => l.msg)).not.toContain('pull request #41 was merged, so this run starts a fresh branch')
  const after = await issue('ENG-1')
  expect(after.attachments.map((a) => a.url)).toEqual([PR_41])
  expect(after.comments.at(-1)?.body).not.toContain('fresh branch')
  await f.server.close()
})

test('a fresh delivery replays the run’s commits outside the agent’s worktree, so its uncommitted and untracked files neither block the replay nor reach the stash', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner(() => 'commit', () => 'change.txt', (task, workdir) => {
    if (!ROUND_2(task)) return
    writeFileSync(join(workdir, 'base.txt'), 'uncommitted edit\n')
    writeFileSync(join(workdir, 'gen.lock'), 'untracked\n')
    squashMerge(repo, 'eng-1-fix-login')
    commitFile(repo.seed, 'gen.lock', 'tracked on main')
    commitFile(repo.seed, 'base.txt', 'edited on main')
    git(repo.seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
    gh.setState('eng-1-fix-login', 'MERGED')
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run.status).toBe('succeeded')
  expect(untouched(f, run)).toEqual({ branch: `factory-${run.id}`, head: git(workdirOf(f, run), 'rev-parse', 'HEAD'), status: 'M base.txt\n?? gen.lock', stash: '', worktrees: 2 })
  expect(git(workdirOf(f, run), 'log', '-1', '--format=%s')).toBe('change for ENG-1 Fix login (round 2) (attempt 1)')
  expect(git(repo.origin, 'log', '--format=%s', 'main..eng-1-fix-login-2')).toBe('change for ENG-1 Fix login (round 2) (attempt 1)')
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login-2~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
  expect(git(repo.origin, 'show', 'eng-1-fix-login-2:gen.lock')).toBe('tracked on main')
  expect(run.output?.artifacts).toEqual([
    { kind: 'branch', label: 'eng-1-fix-login-2', url: null },
    { kind: 'commit', label: `${git(repo.origin, 'rev-parse', '--short=7', 'eng-1-fix-login-2')} change for ENG-1 Fix login (round 2) (attempt 1)`, url: null },
    { kind: 'pr', label: 'Pull request #42', url: PR_42 },
  ])
  await f.server.close()
})

test('a run whose history holds a merge commit fails a fresh delivery without a push, since a replay would drop the merge’s own changes', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner(() => 'commit', () => 'change.txt', (task, workdir, attempt) => {
    if (!ROUND_2(task) || attempt > 1) return
    git(workdir, 'switch', '--quiet', '-c', 'side')
    commitFile(workdir, 'side.txt', 'side work')
    git(workdir, 'switch', '--quiet', '-')
    git(workdir, 'merge', '--quiet', '--no-ff', '--no-commit', 'side')
    writeFileSync(join(workdir, 'merge-only.txt'), 'only in the merge\n')
    git(workdir, 'add', 'merge-only.txt')
    git(workdir, 'commit', '--quiet', '-m', 'Merge side')
    squashMerge(repo, 'eng-1-fix-login')
    gh.setState('eng-1-fix-login', 'MERGED')
  }))
  await roundTwoTaken(f)

  const failed = await nextRun(f)
  expect(failed).toMatchObject({ status: 'failed', attempt: 1, error: "delivery failed: the run's merge commits cannot be replayed onto origin/main" })
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(refs(repo.root, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(gh.creates()).toHaveLength(1)

  const retried = await nextRun(f)
  expect(retried).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect(git(repo.origin, 'log', '--format=%s', 'main..eng-1-fix-login-2')).toBe('change for ENG-1 Fix login (round 2) (attempt 2)')
  await f.server.close()
})

const DELIVERED_NOTHING = 'Pull request #41 was merged; this round delivered nothing.'

test('a replay whose commits are all on the default branch already opens nothing, keeps no branch, and its note says the round delivered nothing', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) {
      squashMerge(repo, 'eng-1-fix-login', 'change for ENG-1 Fix login (round 2) (attempt 1)')
      gh.setState('eng-1-fix-login', 'MERGED')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run.status).toBe('succeeded')
  expect(run.output?.artifacts).toEqual([{ kind: 'note', label: 'No changes; no pull request opened', url: null }])
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(refs(repo.root, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(gh.creates()).toHaveLength(1)
  expect((await issue('ENG-1')).comments.at(-1)?.body.split('\n\n')[1]).toBe(DELIVERED_NOTHING)
  await f.server.close()
})

test('a replayed run whose commits cannot be listed after its pull request opened still succeeds, so no retry opens a second pull request', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      gh.removeWorkdirOnCreate()
    }
    return 'commit'
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run).toMatchObject({ status: 'succeeded', attempt: 1 })
  expect(run.output?.artifacts).toEqual([
    { kind: 'branch', label: 'eng-1-fix-login-2', url: null },
    { kind: 'pr', label: 'Pull request #42', url: PR_42 },
  ])
  expect(f.server.snapshot().logs.some((l) => l.runId === run.id && l.level === 'warn' && l.msg.startsWith('git artifacts unavailable: '))).toBe(true)
  expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2'])
  expect(record(f)).toMatchObject({ result: { pr: { url: PR_42 } } })
  await f.server.close()
})

test('round 3 replaying after round 2’s new pull request merged never reuses round 1’s deleted branch', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => {
    if (task.title.endsWith('(round 3)')) {
      squashMerge(repo, 'eng-1-fix-login-2')
      gh.setState('eng-1-fix-login-2', 'MERGED')
    }
    return 'commit'
  }))
  await poll(f)
  await nextRun(f)
  squashMerge(repo, 'eng-1-fix-login')
  gh.setState('eng-1-fix-login', 'MERGED')
  deleteBranch(f, repo, 'eng-1-fix-login')
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  const second = await nextRun(f)
  expect(second.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #42', url: PR_42 })
  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  expect(record(f)).toMatchObject({ round: 3, rework: { kind: 'continue', pr: { url: PR_42 }, branch: 'eng-1-fix-login-2' } })

  const third = await nextRun(f)
  expect(third.status).toBe('succeeded')
  expect(third.output?.artifacts.find((a) => a.kind === 'branch')).toEqual({ kind: 'branch', label: 'eng-1-fix-login-3', url: null })
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login')).toBe('')
  expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2', 'eng-1-fix-login-3'])
  await f.server.close()
})

test('a pull request read that fails after the flow was cancelled ends the run cancelled, and nothing retries it', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      gh.holdView()
    }
    return 'commit'
  }))
  await roundTwoTaken(f)
  const views = prViews()

  f.api.sim.advance(1)
  await until(() => prViews() === views + 2)
  await moveIssue('ENG-1', 'Done')
  await poll(f)
  gh.failNext('view')
  gh.releaseView()
  await until(() => coderRuns(f).at(-1)!.status !== 'running')
  await f.api.sim.settled()
  f.api.sim.advance(1)
  await f.api.sim.settled()

  expect(coderRuns(f).map((r) => [r.attempt, r.status, r.error])).toEqual([[1, 'succeeded', null], [1, 'cancelled', 'its flow was cancelled']])
  expect(issueTasks(f)[1]).toMatchObject({ status: 'cancelled', retryAt: null })
  expect(gh.creates()).toHaveLength(1)
  expect((await issue('ENG-1')).attachments.map((a) => a.url)).toEqual([PR_41])
  await f.server.close()
})

/** Holds `gh pr view <branch>` once `hold` is called. */
const holdView = (branch: string) => ({
  hold: () => gh.holdView(branch),
  reached: () => gh.calls().some((c) => c.argv[1] === 'view' && c.argv[2] === branch),
  release: () => gh.releaseView(),
})

test.each([
  ['replays onto the default branch', () => holdGit('merge-tree'), ''],
  ['picks the fresh branch’s name', () => holdGit('ls-remote', '--heads'), ''],
  ['pushes the fresh branch', () => holdGit('push'), 'eng-1-fix-login-2'],
  ['looks up the fresh branch’s pull request', () => holdView('eng-1-fix-login-2'), 'eng-1-fix-login-2'],
] as const)('a flow cancelled while its run %s opens no pull request, and its note says the round delivered nothing', async (_label, holder, pushed) => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const held = holder()
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      held.hold()
    }
    return 'commit'
  }))
  await roundTwoTaken(f)

  f.api.sim.advance(1)
  await until(held.reached)
  expect(record(f).rework).toMatchObject({ kind: 'fresh', state: 'merged' })
  await moveIssue('ENG-1', 'Done')
  await poll(f)
  expect(record(f).cancel).toEqual({ kind: 'linear', reason: 'moved to Done in Linear' })
  held.release()
  await until(() => coderRuns(f).at(-1)!.status !== 'running')
  await f.api.sim.settled()

  expect(coderRuns(f).at(-1)).toMatchObject({ status: 'cancelled', error: 'its flow was cancelled', output: null })
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login-*')).toBe(pushed)
  expect(gh.creates()).toHaveLength(1)
  const after = await issue('ENG-1')
  expect(after.attachments.map((a) => a.url)).toEqual([PR_41])
  expect(after.comments.at(-1)?.body.split('\n\n').slice(0, 2)).toEqual(['**Factory stopped work on this issue (round 2): moved to Done in Linear.**', DELIVERED_NOTHING])
  await f.server.close()
})

test('a replay needs no worktree, hooks, signing or committer identity, and keeps each commit’s author, committer, dates and message', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const config = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
  const f = factory(repo.root, agentRunner(() => 'commit', () => 'change.txt', (task, workdir) => {
    if (!ROUND_2(task)) return
    squashMerge(repo, 'eng-1-fix-login')
    gh.setState('eng-1-fix-login', 'MERGED')
    mkdirSync(`${workdir}-replay`)
    writeFileSync(join(`${workdir}-replay`, 'in-the-way.txt'), 'x\n')
    for (const hook of ['post-checkout', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
      writeFileSync(join(repo.root, '.git', 'hooks', hook), '#!/bin/sh\nexit 1\n')
      chmodSync(join(repo.root, '.git', 'hooks', hook), 0o755)
    }
    git(repo.root, 'config', 'commit.gpgSign', 'true')
    git(repo.root, 'config', 'gpg.program', 'false')
    git(repo.root, 'config', '--unset', 'user.email')
    git(repo.root, 'config', '--unset', 'user.name')
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
  }))
  try {
    await roundTwoTaken(f)
    const run = await nextRun(f)
    expect(run.status).toBe('succeeded')
    const format = '--format=%an <%ae> %ad%n%cn <%ce> %cd%n%B'
    expect(git(repo.origin, 'log', '-1', format, 'eng-1-fix-login-2')).toBe(git(workdirOf(f, run), 'log', '-1', format, 'HEAD'))
    expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login-2~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
    expect(git(repo.root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length).toBe(3)
    expect(refs(repo.root, 'refs/heads/eng-1-fix-login-*')).toBe('')
    expect(run.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #42', url: PR_42 })
  } finally {
    process.env.GIT_CONFIG_GLOBAL = config.global
    process.env.GIT_CONFIG_NOSYSTEM = config.nosystem
    if (config.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    if (config.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  }
  await f.server.close()
})

test('with Coder handing off to a Reviewer that does not deliver, round 3 never reuses round 1’s merged branch', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  addReviewer(f, 'none')
  await poll(f)
  const first = await nextRun(f)
  await nextRun(f, REVIEWER)
  expect(record(f)).toMatchObject({ round: 1, phase: 'ended', result: { pr: { url: PR_41 } } })
  gh.setState('eng-1-fix-login', 'MERGED')
  deleteBranch(f, repo, 'eng-1-fix-login', first)

  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  const second = await nextRun(f)
  await nextRun(f, REVIEWER)
  expect(second.output?.artifacts.find((a) => a.kind === 'branch')).toEqual({ kind: 'branch', label: 'eng-1-fix-login-2', url: null })
  gh.setState('eng-1-fix-login-2', 'MERGED')
  deleteBranch(f, repo, 'eng-1-fix-login-2', second)

  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  expect(record(f)).toMatchObject({ round: 3, rework: { kind: 'fresh', pr: { url: PR_42 }, state: 'merged' }, prBranches: ['eng-1-fix-login', 'eng-1-fix-login-2'] })
  const third = await nextRun(f)
  expect(third.output?.artifacts.find((a) => a.kind === 'branch')).toEqual({ kind: 'branch', label: 'eng-1-fix-login-3', url: null })
  expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2', 'eng-1-fix-login-3'])
  await f.server.close()
})

test('when two delivering agents each open a pull request in round 1, round 2 reuses neither branch', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner())
  addReviewer(f)
  await poll(f)
  const coder = await nextRun(f)
  const reviewer = await nextRun(f, REVIEWER)
  expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2'])
  expect(record(f)).toMatchObject({ round: 1, result: { pr: { url: PR_42 } }, prBranches: ['eng-1-fix-login', 'eng-1-fix-login-2'] })
  gh.setState('eng-1-fix-login', 'MERGED')
  gh.setState('eng-1-fix-login-2', 'MERGED')
  deleteBranch(f, repo, 'eng-1-fix-login', coder)
  deleteBranch(f, repo, 'eng-1-fix-login-2', reviewer)

  await moveIssue('ENG-1', 'Todo')
  await poll(f)
  expect(record(f)).toMatchObject({ round: 2, rework: { kind: 'fresh', pr: { url: PR_42 }, state: 'merged' } })
  const next = await nextRun(f)
  expect(next.output?.artifacts.find((a) => a.kind === 'branch')).toEqual({ kind: 'branch', label: 'eng-1-fix-login-3', url: null })
  await f.server.close()
})

test('a record saved before delivered branches were kept loads with none, and a fresh rework’s old branch key is dropped', () => {
  const issueRef = { backend: 'linear', id: ENG_1, identifier: 'ENG-1', url: ISSUE_URL, branchName: 'eng-1-fix-login' }
  const fresh = { kind: 'fresh', pr: { kind: 'pr', label: 'Pull request #41', url: PR_41 }, state: 'merged' }
  const loaded = intakeRecord({ issue: issueRef, trigger: 'tr-1', flowId: 'fl-1', takenAt: 0, rework: { ...fresh, branch: 'eng-1-fix-login' } }, 'record')
  expect([loaded.rework, loaded.prBranches]).toEqual([fresh, []])
})

test('a pull request unreadable after round 2’s agent works fails the run before any push, and the retry starts fresh', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  let broken = false
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task) && !broken) {
      broken = true
      gh.setState('eng-1-fix-login', 'MERGED')
      gh.failNext('view')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)
  const roundOneTip = git(repo.origin, 'rev-parse', 'refs/heads/eng-1-fix-login')

  const failed = await nextRun(f)
  expect(failed).toMatchObject({ status: 'failed', attempt: 1, error: `delivery failed: gh pr view: no pull requests found for "${PR_41}"` })
  expect(git(repo.origin, 'rev-parse', 'refs/heads/eng-1-fix-login')).toBe(roundOneTip)
  expect(refs(repo.origin, 'refs/heads/eng-1-fix-login-*')).toBe('')
  expect(gh.creates()).toHaveLength(1)
  expect(record(f).rework).toMatchObject({ kind: 'continue' })

  const retried = await nextRun(f)
  expect(retried).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect(git(workdirOf(f, retried), 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(git(workdirOf(f, retried), 'rev-parse', 'HEAD~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
  expect(record(f)).toMatchObject({ rework: { kind: 'fresh', state: 'merged' }, result: { pr: { url: PR_42 } } })
  await f.server.close()
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

test('a pull request merged between delivery’s read and its push fails the run instead of opening a second pull request from the merged branch, and the retry starts fresh', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const held = holdGit('push')
  let once = false
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task) && !once) {
      once = true
      held.hold()
    }
    return 'commit'
  }))
  await roundTwoTaken(f)

  f.api.sim.advance(1)
  await until(held.reached)
  squashMerge(repo, 'eng-1-fix-login')
  gh.setState('eng-1-fix-login', 'MERGED')
  held.release()
  await until(() => coderRuns(f).at(-1)!.status !== 'running')
  await f.api.sim.settled()
  expect(coderRuns(f).at(-1)).toMatchObject({ status: 'failed', attempt: 1, error: 'delivery failed: pull request #41 closed while this run delivered' })
  expect(gh.creates()).toHaveLength(1)

  const retried = await nextRun(f)
  expect(retried).toMatchObject({ status: 'succeeded', attempt: 2 })
  expect(git(workdirOf(f, retried), 'branch', '--show-current')).toBe('eng-1-fix-login-2')
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login-2~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
  expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2'])
  expect(record(f)).toMatchObject({ rework: { kind: 'fresh', state: 'merged' }, prBranches: ['eng-1-fix-login', 'eng-1-fix-login-2'], result: { pr: { url: PR_42 } } })
  expect((await issue('ENG-1')).comments.at(-1)?.body.split('\n\n')[1]).toBe('Pull request #41 was merged, so this round opened a new pull request.')
  await f.server.close()
})

/** A commit object as latin1 text, which keeps every byte, without the tree, parent and signature headers a replay rewrites. */
function rawCommit(repo: string, rev: string): string {
  const raw = execFileSync(realGit, ['-C', repo, 'cat-file', 'commit', rev]).toString('latin1')
  const end = raw.indexOf('\n\n')
  const headers = raw.slice(0, end).split('\n').filter((line) => !/^(tree|parent|gpgsig) |^ /.test(line))
  return [...headers, raw.slice(end + 1)].join('\n')
}

test('a replay keeps a signed commit’s author, committer, encoding header and message bytes, whatever the log config prints', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const keys = tempDir()
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'agent', '-f', join(keys, 'id')])
  writeFileSync(join(keys, 'allowed'), `test@example.com ${readFileSync(join(keys, 'id.pub'), 'utf8')}`)
  const message = 'Café fix\n\nReviewed-by: René <rene@example.com>\n'
  writeFileSync(join(keys, 'message'), Buffer.from(message, 'latin1'))
  let original = ''
  const f = factory(repo.root, agentRunner(() => 'commit', () => 'change.txt', (task, workdir) => {
    if (!ROUND_2(task)) return
    squashMerge(repo, 'eng-1-fix-login')
    gh.setState('eng-1-fix-login', 'MERGED')
    writeFileSync(join(workdir, 'latin.txt'), 'latin\n')
    git(workdir, 'add', 'latin.txt')
    git(workdir, '-c', 'i18n.commitEncoding=ISO-8859-1', '-c', 'gpg.format=ssh', '-c', `user.signingKey=${join(keys, 'id')}`, 'commit', '--quiet', '-S', '-F', join(keys, 'message'))
    git(repo.root, 'config', 'log.showSignature', 'true')
    git(repo.root, 'config', 'gpg.ssh.allowedSignersFile', join(keys, 'allowed'))
    original = git(workdir, 'rev-parse', 'HEAD')
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run.status).toBe('succeeded')
  const before = rawCommit(repo.root, original)
  expect(before).toContain('\nencoding ISO-8859-1\n')
  expect(before.endsWith(`\n\n${message}`)).toBe(true)
  expect(rawCommit(repo.origin, 'eng-1-fix-login-2')).toBe(before)
  expect(git(repo.origin, 'log', '--format=%s', 'main..eng-1-fix-login-2')).toBe('Café fix\nchange for ENG-1 Fix login (round 2) (attempt 1)')
  await f.server.close()
})

test('a fresh delivery pushes from the agent’s worktree, so the repository’s pre-push hook sees the run’s branch as for any other push', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const pushes = join(tempDir(), 'pushes')
  const hook = join(repo.root, '.git', 'hooks', 'pre-push')
  writeFileSync(hook, `#!/bin/sh\nbranch=$(git rev-parse --abbrev-ref HEAD)\necho "$branch" >> ${pushes}\n[ "$branch" != main ]\n`)
  chmodSync(hook, 0o755)
  let merged = false
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task) && !merged) {
      merged = true
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run).toMatchObject({ status: 'succeeded', attempt: 1 })
  expect(readFileSync(pushes, 'utf8').trim().split('\n')).toEqual(['eng-1-fix-login', `factory-${run.id}`])
  expect(run.output?.artifacts.at(-1)).toEqual({ kind: 'pr', label: 'Pull request #42', url: PR_42 })
  await f.server.close()
})

test('commits the agent took from the default branch are not replayed, so an agent that restarted from origin/main still delivers its own commit', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const f = factory(repo.root, agentRunner(() => 'commit', () => 'change.txt', (task, workdir) => {
    if (!ROUND_2(task)) return
    squashMerge(repo, 'eng-1-fix-login', 'edited on main after the merge')
    gh.setState('eng-1-fix-login', 'MERGED')
    git(workdir, 'fetch', '--quiet', 'origin', 'main')
    git(workdir, 'reset', '--quiet', '--hard', 'FETCH_HEAD')
    commitFile(workdir, 'round2.txt', 'restarted from main')
    commitFile(repo.seed, 'change.txt', 'edited again on main')
    git(repo.seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run).toMatchObject({ status: 'succeeded', attempt: 1 })
  expect(git(repo.origin, 'log', '--format=%s', 'main..eng-1-fix-login-2')).toBe('restarted from main')
  expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login-2~1')).toBe(git(repo.origin, 'rev-parse', 'main'))
  await f.server.close()
})

test('a record saved before delivered branches were kept never reuses the branch its round continued, and keeps it from then on', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const store = memoryStore()
  let roundOne: Run | undefined
  let g: Factory | undefined
  const runner = agentRunner((task) => {
    if (ROUND_2(task)) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      deleteBranch(g!, repo, 'eng-1-fix-login', roundOne)
    }
    return 'commit'
  })
  const f = factory(repo.root, runner, LIFECYCLE, store)
  await roundTwoTaken(f)
  roundOne = coderRuns(f)[0]
  await f.server.close()
  const saved = JSON.parse(store.text!) as { intake: Record<string, Partial<IntakeRecord>> }
  delete saved.intake[ENG_1].prBranches
  store.text = JSON.stringify(saved)

  const server = new MockServer({ manual: true, rng: RNG, localRunner: runner, localRoot: repo.root, linear: linear(), clock, store })
  g = { server, api: createApi(server), trigger: f.trigger, root: repo.root }
  expect(record(g).prBranches).toEqual([])
  const run = await nextRun(g)
  expect(run.status).toBe('succeeded')
  expect(run.output?.artifacts.find((a) => a.kind === 'branch')).toEqual({ kind: 'branch', label: 'eng-1-fix-login-2', url: null })
  expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2'])
  expect(record(g).prBranches).toEqual(['eng-1-fix-login', 'eng-1-fix-login-2'])
  await server.close()
})

test.each([
  ['one name', 1, 'succeeded', 'eng-1-fix-login-3'],
  ['three names', 3, 'failed', null],
] as const)('a fresh name someone else creates on origin before the push is left alone: with %s taken, delivery claims the next or gives up', async (_label, takes, status, claimed) => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const taken = takeBranches(repo.origin)
  let once = false
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task) && !once) {
      once = true
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
      taken.take(takes)
    }
    return 'commit'
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  const main = git(repo.origin, 'rev-parse', 'main')
  const others = ['eng-1-fix-login-2', 'eng-1-fix-login-3', 'eng-1-fix-login-4'].slice(0, takes)
  expect(others.map((branch) => git(repo.origin, 'rev-parse', branch))).toEqual(others.map(() => main))
  expect(run).toMatchObject({ status, attempt: 1 })
  if (claimed) {
    expect(git(repo.origin, 'log', '--format=%s', `main..${claimed}`)).toBe('change for ENG-1 Fix login (round 2) (attempt 1)')
    expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', claimed])
  } else {
    expect(run.error).toBe('delivery failed: git push: someone else created eng-1-fix-login-2, eng-1-fix-login-3, eng-1-fix-login-4 on origin first')
    expect(gh.creates()).toHaveLength(1)
  }
  await f.server.close()
})

test('a fresh name someone else took is still left alone when the server runs under a translated locale, since that push runs under LC_ALL=C', async () => {
  const locale = { LANGUAGE: process.env.LANGUAGE, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
  Object.assign(process.env, { LANGUAGE: 'de', LC_ALL: 'en_US.UTF-8', LANG: 'de_DE.UTF-8' })
  try {
    const repo = repository()
    await control({ op: 'addIssue', title: 'Fix login' })
    const taken = takeBranches(repo.origin, true)
    let once = false
    const f = factory(repo.root, agentRunner((task) => {
      if (ROUND_2(task) && !once) {
        once = true
        squashMerge(repo, 'eng-1-fix-login')
        gh.setState('eng-1-fix-login', 'MERGED')
        taken.take(1)
      }
      return 'commit'
    }))
    await roundTwoTaken(f)

    const run = await nextRun(f)
    expect(run).toMatchObject({ status: 'succeeded', attempt: 1, error: null })
    expect(git(repo.origin, 'rev-parse', 'eng-1-fix-login-2')).toBe(git(repo.origin, 'rev-parse', 'main'))
    expect(git(repo.origin, 'log', '--format=%s', 'main..eng-1-fix-login-3')).toBe('change for ENG-1 Fix login (round 2) (attempt 1)')
    expect(gh.creates().map((c) => c.argv[3])).toEqual(['eng-1-fix-login', 'eng-1-fix-login-3'])
    await f.server.close()
  } finally {
    for (const [key, value] of Object.entries(locale)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test.each([
  ['git 2.39', 'echo "git version 2.39.5"; exit 0', 129, "error: unknown option `write-tree'", " (replaying commits needs git 2.40 or later; this is git 2.39.5)"],
  ['a current git', '', 128, 'fatal: not a valid object name', ''],
] as const)('a merge-tree failure on %s reports git’s own reason, and blames the version only when it is older than 2.40', async (_label, version, code, reason, hint) => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  wrapGit(`if [ -n '${version}' ] && [ "$sub" = version ]; then ${version || ':'}; fi
if [ "$sub" = merge-tree ]; then echo "${reason.replace(/`/g, '\\`')}" >&2; exit ${code}; fi`)
  const f = factory(repo.root, agentRunner((task) => {
    if (ROUND_2(task)) {
      squashMerge(repo, 'eng-1-fix-login')
      gh.setState('eng-1-fix-login', 'MERGED')
    }
    return 'commit'
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run).toMatchObject({ status: 'failed', attempt: 1, error: `delivery failed: git merge-tree: ${reason}${hint}` })
  await f.server.close()
})

test('a commit message larger than the pipe fails the run, without crashing the server, when git stops before reading it', async () => {
  const repo = repository()
  await control({ op: 'addIssue', title: 'Fix login' })
  const message = join(tempDir(), 'message')
  writeFileSync(message, `Big change\n\n${'x'.repeat(512 * 1024)}\n`)
  wrapGit('if [ "$sub" = hash-object ] || [ "$sub" = commit-tree ]; then echo "fatal: refusing the message" >&2; exit 1; fi')
  const f = factory(repo.root, agentRunner(() => 'commit', () => 'change.txt', (task, workdir) => {
    if (!ROUND_2(task)) return
    squashMerge(repo, 'eng-1-fix-login')
    gh.setState('eng-1-fix-login', 'MERGED')
    git(workdir, 'commit', '--quiet', '--amend', '-F', message)
  }))
  await roundTwoTaken(f)

  const run = await nextRun(f)
  expect(run).toMatchObject({ status: 'failed', attempt: 1, error: 'delivery failed: git hash-object: fatal: refusing the message' })
  await f.server.close()
})
