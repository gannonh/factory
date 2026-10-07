import { spawn, spawnSync, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Agent, Artifact, LogLevel, PullRequestRef, Run, RunId, Task } from '../src/domain/types'

const execFileAsync = promisify(execFile)

export type RunnerEvent =
  | { kind: 'log'; level: LogLevel; message: string }
  | { kind: 'tokens'; count: number }
  | { kind: 'complete'; status: 'succeeded' | 'failed'; result: string | null; reason?: string }

export type RunInput = { run: Run; agent: Agent; task: Task; workdir: string }
export type Emit = (event: RunnerEvent) => void

export interface Runner {
  readonly execution: Run['execution']
  start(input: RunInput, emit: Emit): void
  tick?(input: RunInput, elapsedMs: number, now: number, emit: Emit): number | void
  kill(runId: RunId): void
}

const SIM_LOGS: Array<[LogLevel, string]> = [
  ['debug', 'tool call read_file src/index.ts'], ['debug', 'tool call bash: npm test -- --filter=unit'],
  ['info', 'planning step complete, 3 sub-steps'], ['info', 'wrote 42 lines to src/components/Form.tsx'],
  ['info', 'tests passed (18/18)'], ['debug', 'context window 38% used'],
  ['warn', 'retrying tool call after transient error (ECONNRESET)'], ['warn', 'lint reported 2 warnings, continuing'],
  ['info', 'opened draft PR #412'], ['debug', 'cache hit for prompt prefix'],
  ['info', 'handoff payload prepared'], ['error', 'tool call failed: permission denied on /etc/hosts'],
]

export class SimulatedRunner implements Runner {
  readonly execution = 'simulated'
  private random: () => number
  constructor(random: () => number) { this.random = random }

  start(_input: RunInput, _emit: Emit) {}

  tick({ run, agent }: RunInput, elapsedMs: number, now: number, emit: Emit) {
    if (run.progress === null || run.durationMs === null) return
    const progress = Math.min(1, run.progress + elapsedMs / run.durationMs)
    emit({ kind: 'tokens', count: run.tokens + Math.round((80 + this.random() * 520) * elapsedMs / 1000) })
    if (this.random() < 0.28) {
      const [level, message] = SIM_LOGS[Math.floor(this.random() * SIM_LOGS.length)]
      if (level !== 'error') emit({ kind: 'log', level, message })
    }
    if (now - run.startedAt > agent.timeoutMs) {
      emit({ kind: 'log', level: 'error', message: `run exceeded timeout of ${Math.round(agent.timeoutMs / 1000)}s` })
      emit({ kind: 'complete', status: 'failed', result: null, reason: 'timeout' })
    } else if (progress >= 1) {
      const succeeded = this.random() < 0.85
      if (!succeeded) emit({ kind: 'log', level: 'error', message: SIM_LOGS.at(-1)![1] })
      emit({ kind: 'complete', status: succeeded ? 'succeeded' : 'failed', result: null, reason: succeeded ? undefined : 'task error' })
    }
    return progress
  }

  kill(_runId: RunId) {}
}

const TOOL_MAP: Record<string, string[]> = {
  read_file: ['Read'], write_file: ['Edit', 'Write'], bash: ['Bash'], search: ['Glob', 'Grep'],
  git_diff: ['Bash(git diff *)'], gh: ['Bash(gh *)'],
}

export function claudeArgs(agent: Agent, prompt: string): string[] {
  const allowed = [...new Set(agent.tools.flatMap((tool) => TOOL_MAP[tool] ?? []))]
  return [
    '--print', '--verbose', '--output-format', 'stream-json',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--allowedTools', allowed.join(','), '--model', agent.model,
    '--system-prompt', agent.systemPrompt, '--', prompt,
  ]
}

/**
 * Where a delivering run's branch goes: `branch` is pushed to origin and opened as a pull request against `base`. A run
 * that continues a pull request pushes to its branch only while it stays open (ADR 0012).
 */
export type DeliveryPlan = { kind: 'new' | 'continue'; branch: string; base: string }

/**
 * `initialHead` is the commit the run started from: origin's default branch for a new delivery branch, or the tip of the
 * pull request it continues. `root` is the sandbox root the worktree belongs to.
 */
export type PreparedWorkdir = { root: string; path: string; initialHead: string | null; delivery: DeliveryPlan | null }

const NETWORK_TIMEOUT_MS = 120_000
const LOCAL_TIMEOUT_MS = 15_000
const MAX_REASON_CHARS = 300
// Network git must fail rather than wait on a credential prompt nobody can answer, over HTTPS or SSH.
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' })

/**
 * The branch a delivering run works on: a new one cut from origin's default branch, or open pull request `pr`'s branch
 * (ADR 0012). `retired` names the branches of the issue's earlier pull requests, which a new branch never reuses.
 */
export type DeliveryRequest =
  | { kind: 'new'; branch: string; retired: readonly string[] }
  | { kind: 'continue'; pr: PullRequestRef; branch: string; base: string }

/**
 * Makes the run's working directory. With no delivery the worktree branches `factory-<runId>` from the
 * root's HEAD. With a new delivery branch it fetches origin and cuts the requested branch from origin's default branch,
 * suffixed `-2`, `-3`, … until the name is free locally and on origin, so a retry never reuses a pushed branch.
 * To continue a pull request it fetches the PR's branch and starts the worktree at its tip on a local branch of the
 * run's own, since an earlier round's worktree may still have the PR branch checked out.
 */
export async function prepareWorkdir(root: string, runId: RunId, delivery: DeliveryRequest | null): Promise<PreparedWorkdir> {
  if (!isAbsolute(root)) throw new Error('local sandbox root must be an absolute path')
  const rootPath = await realpath(root)
  if (!(await stat(rootPath)).isDirectory()) throw new Error('local sandbox root must be a directory')
  const workdir = join(rootPath, '.factory-runs', basename(runId))
  let gitRoot: string | null = null
  try { gitRoot = (await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--show-toplevel'])).stdout.trim() } catch { /* plain directory */ }
  const isGitRoot = gitRoot !== null && resolve(gitRoot) === rootPath
  if (delivery && !isGitRoot) throw new Error('delivery failed: sandbox root is not the top of a git repository')
  await mkdir(join(rootPath, '.factory-runs'), { recursive: true })
  await assertRunsDir(rootPath)
  if (!isGitRoot) {
    await mkdir(workdir)
    return { root: rootPath, path: workdir, initialHead: null, delivery: null }
  }
  const excludePath = (await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--git-path', 'info/exclude'])).stdout.trim()
  const exclude = isAbsolute(excludePath) ? excludePath : resolve(rootPath, excludePath)
  const current = await readFile(exclude, 'utf8').catch(() => '')
  if (!current.split(/\r?\n/).includes('/.factory-runs/')) {
    await mkdir(dirname(exclude), { recursive: true })
    await appendFile(exclude, `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}/.factory-runs/\n`)
  }
  if (delivery) return prepareDelivery(rootPath, workdir, `factory-${basename(runId)}`, delivery)
  const initialHead = await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--verify', 'HEAD']).then(({ stdout }) => stdout.trim()).catch(() => null)
  if (initialHead) {
    await claiming(rootPath, workdir, `factory-${runId}`, initialHead, (add) => execFileAsync('git', ['-C', rootPath, ...add], { timeout: LOCAL_TIMEOUT_MS })
      .catch((error: unknown) => { throw new Error(`git worktree add: ${failureReason(error)}`) }))
    return { root: rootPath, path: workdir, initialHead, delivery: null }
  }
  await mkdir(workdir)
  return { root: rootPath, path: workdir, initialHead: null, delivery: null }
}

// Two runs on one repository must not pick the same free branch name or fetch at once. A fresh branch's push runs in the
// queue with the name it claims. Every other push stays outside it, so a slow push of a pull request's branch never holds
// up another run's start and pushes to different branches overlap.
// The queue is the repository's shared Git directory, not the sandbox root: a clone and its linked worktrees share refs
// and branch names. A root that is not a repository queues by its own path.
const deliveryQueues = new Map<string, Promise<unknown>>()

async function queueKey(rootPath: string): Promise<string> {
  try {
    const common = (await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--git-common-dir'], { timeout: LOCAL_TIMEOUT_MS })).stdout.trim()
    return await realpath(resolve(rootPath, common))
  } catch {
    return rootPath
  }
}

async function inDeliveryQueue<T>(rootPath: string, work: () => Promise<T>): Promise<T> {
  const key = await queueKey(rootPath)
  const turn = (deliveryQueues.get(key) ?? Promise.resolve()).then(work)
  const queued = turn.catch(() => undefined)
  deliveryQueues.set(key, queued)
  void queued.then(() => { if (deliveryQueues.get(key) === queued) deliveryQueues.delete(key) })
  return turn
}

type Exec = { timeout?: number; input?: Buffer; codes?: readonly number[]; env?: Record<string, string> }
type Exited = { code: number; stdout: Buffer; stderr: Buffer }

/**
 * Runs `command` in `cwd` and resolves when it exits 0 or with one of `codes`. Anything else throws
 * `delivery failed: <step>: <reason>`. Its stdin is `input`, or closed, and `env` adds to its environment.
 */
async function exec(command: 'git' | 'gh', cwd: string, step: string, args: string[], { timeout = LOCAL_TIMEOUT_MS, input, codes = [], env }: Exec = {}): Promise<Exited> {
  const where = command === 'git' ? { args: ['-C', cwd, ...args] } : { args, cwd }
  const pending = execFileAsync(command, where.args, { cwd: where.cwd, timeout, env: { ...gitEnv(), ...env }, maxBuffer: 1024 * 1024, encoding: 'buffer' })
  // A child that exits before reading all of its input fails the promise below; the stream's EPIPE must not crash the server.
  pending.child.stdin?.on('error', () => {})
  pending.child.stdin?.end(input)
  try {
    return { code: 0, ...(await pending) }
  } catch (error) {
    const { code, stdout, stderr } = error as { code?: unknown; stdout?: Buffer; stderr?: Buffer }
    if (typeof code === 'number' && codes.includes(code) && stdout && stderr) return { code, stdout, stderr }
    throw new Error(`delivery failed: ${step}: ${failureReason(error)}`)
  }
}

type Git = (step: string, args: string[], timeout?: number, input?: Buffer) => Promise<string>

const gitIn = (cwd: string): Git => async (step, args, timeout, input) => (await exec('git', cwd, step, args, { timeout, input })).stdout.toString()

async function defaultBranch(git: Git): Promise<string> {
  const symref = await git('git ls-remote', ['ls-remote', '--symref', 'origin', 'HEAD'], NETWORK_TIMEOUT_MS)
  const base = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref)?.[1]
  if (!base) throw new Error('delivery failed: origin has no default branch')
  return base
}

/**
 * Deletes the `refs/factory/*` refs, each with its own `update-ref -d`, so a ref another git holds a lock on, or a stale
 * `.lock` left by a killed git, keeps only that ref and not the rest. It may leave refs behind without harm, since the
 * next call deletes what is left. A ref goes whether or not another server's fetch just wrote it: that fetch took its
 * tips from its own output, and each run's refs are private to it.
 */
async function dropPrivateRefs(git: Git): Promise<void> {
  const names = (await git('git for-each-ref', ['for-each-ref', '--format=%(refname)', 'refs/factory/'])).split('\n').filter(Boolean)
  for (const name of names) await git('git update-ref', ['update-ref', '-d', name]).catch(() => undefined)
}

/**
 * The commits at the tips of origin's `branches`, fetched into refs private to run `runId`, which are deleted again when
 * the fetch ends. A fetch never writes `refs/remotes/origin/*`, the refs a sibling's push to the same branch also writes, and
 * `--refmap=` stops git from updating them on the side. Nor does it write `FETCH_HEAD`, which the siblings share.
 * The tips come from the fetch's own `--porcelain --verbose` output (git 2.41 or later; without `--verbose` a ref that is
 * already up to date has no row) and not from reading the refs back, so
 * another server deleting them cannot fail the run. A crashed or failed earlier call can leave refs behind. The delete
 * when a call ends, and the one before the next fetch, remove every `refs/factory/*` ref they can.
 */
async function fetchTips(git: Git, runId: string, branches: readonly string[]): Promise<string[]> {
  const refs = branches.map((_, i) => `refs/factory/${runId}/${i}`)
  await dropPrivateRefs(git).catch(() => undefined)
  try {
    const porcelain = await git('git fetch', ['fetch', '--porcelain', '--verbose', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', ...branches.map((branch, i) => `+refs/heads/${branch}:${refs[i]}`)], NETWORK_TIMEOUT_MS)
      .catch(async (error: unknown) => { throw await needsGit(git, error, 'reading fetched commits', 2, 41) })
    const tips = new Map<string, string>()
    for (const line of porcelain.split('\n')) {
      const [flag, , tip, ref] = line.split(' ')
      if (flag !== '!' && tip && ref) tips.set(ref, tip)
    }
    return refs.map((ref) => {
      const tip = tips.get(ref)
      if (!tip) throw new Error(`delivery failed: git fetch: no commit reported for ${ref}`)
      return tip
    })
  } finally {
    await dropPrivateRefs(git).catch(() => undefined)
  }
}

/** The first of `requested`, `<requested>-2`, `<requested>-3`, … that is free locally and on origin and not in `taken`. */
async function freeBranch(git: Git, requested: string, taken: readonly string[]): Promise<string> {
  const used = new Set(taken)
  const remoteHeads = await git('git ls-remote', ['ls-remote', '--heads', 'origin'], NETWORK_TIMEOUT_MS)
  for (const line of remoteHeads.split('\n')) {
    const name = line.split('\t')[1]?.replace(/^refs\/heads\//, '')
    if (name) used.add(name)
  }
  const local = await git('git for-each-ref', ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'])
  for (const name of local.split('\n')) if (name) used.add(name)
  let branch = requested
  for (let n = 2; used.has(branch); n++) branch = `${requested}-${n}`
  return branch
}

function prepareDelivery(rootPath: string, workdir: string, runBranch: string, request: DeliveryRequest): Promise<PreparedWorkdir> {
  return inDeliveryQueue(rootPath, () => prepareDeliveryNow(rootPath, workdir, runBranch, request))
}

async function prepareDeliveryNow(rootPath: string, workdir: string, runBranch: string, request: DeliveryRequest): Promise<PreparedWorkdir> {
  const git = gitIn(rootPath)
  const requested = request.branch
  await git('check branch name', ['check-ref-format', '--branch', requested])
  const hasOrigin = await execFileAsync('git', ['-C', rootPath, 'remote', 'get-url', 'origin'], { timeout: LOCAL_TIMEOUT_MS }).then(() => true, () => false)
  if (!hasOrigin) throw new Error('delivery failed: sandbox root has no origin remote')
  if (request.kind === 'continue') {
    const { base } = request
    await git('check branch name', ['check-ref-format', '--branch', base])
    const [, initialHead] = await fetchTips(git, basename(workdir), [base, requested])
    await claiming(rootPath, workdir, runBranch, initialHead, (add) => git('git worktree add', add))
    return { root: rootPath, path: workdir, initialHead, delivery: { kind: 'continue', branch: requested, base } }
  }
  const base = await defaultBranch(git)
  const [initialHead] = await fetchTips(git, basename(workdir), [base])
  const branch = await freeBranch(git, requested, request.retired)
  await claiming(rootPath, workdir, branch, initialHead, (add) => git('git worktree add', add))
  return { root: rootPath, path: workdir, initialHead, delivery: { kind: 'new', branch, base } }
}

/** Where a run's commits go: `branch` against `base`, holding the commits in `initialHead..head`. */
type Target = { branch: string; base: string; initialHead: string; head: string }

/** Why a git step failed, naming the git `major.minor` floor that `what` needs only when this git is older. */
async function needsGit(git: Git, error: unknown, what: string, major: number, minor: number): Promise<Error> {
  const reason = error instanceof Error ? error.message : String(error)
  const version = /(\d+)\.(\d+)[\w.]*/.exec(await git('git version', ['version']).catch(() => ''))
  const old = version !== null && (Number(version[1]) < major || (Number(version[1]) === major && Number(version[2]) < minor))
  return new Error(old ? `${reason} (${what} needs git ${major}.${minor} or later; this is git ${version[0]})` : reason)
}

const mergeTreeFailure = (root: string, error: unknown) => needsGit(gitIn(root), error, 'replaying commits', 2, 40)

/**
 * The commit object `raw` with tree `tree` and parent `parent`. Its author, committer and `encoding` lines and its message
 * keep their bytes; any signature is dropped, since it signed another commit.
 */
function rebuiltCommit(raw: Buffer, tree: string, parent: string): Buffer {
  const end = raw.indexOf('\n\n')
  const kept = raw.subarray(0, end).toString('latin1').split('\n').filter((line) => /^(author|committer|encoding) /.test(line))
  return Buffer.concat([Buffer.from([`tree ${tree}`, `parent ${parent}`, ...kept].join('\n'), 'latin1'), raw.subarray(end)])
}

/**
 * Replays the run's commits, those reachable from `head` but not from `runStart` or `onto`, onto `onto` with plumbing
 * alone, keeping each commit's author, committer, dates, encoding and message byte for byte. No worktree, branch, hook,
 * signing or identity config is involved. A commit whose changes `onto` already has is dropped. A merge commit or a
 * conflict fails, since a replay would drop a merge's own changes. Returns the tip, which is `onto` itself when nothing
 * is left. Needs git 2.40 or later for `merge-tree --write-tree --merge-base`.
 */
async function replay(root: string, runStart: string, head: string, onto: string, base: string): Promise<string> {
  const git = gitIn(root)
  const commits = [head, '--not', runStart, onto]
  if ((await git('git rev-list', ['rev-list', '--merges', ...commits])).trim()) {
    throw new Error(`delivery failed: the run's merge commits cannot be replayed onto origin/${base}`)
  }
  let tip = onto
  for (const commit of (await git('git rev-list', ['rev-list', '--reverse', ...commits])).split('\n').filter(Boolean)) {
    // merge-tree exits 1 for a conflict and prints the tree, then each conflicted path.
    const merged = await exec('git', root, 'git merge-tree', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${commit}^`, tip, commit], { codes: [1] })
      .catch(async (error: unknown) => { throw await mergeTreeFailure(root, error) })
    const [tree, ...paths] = merged.stdout.toString().split('\0').filter(Boolean)
    if (merged.code === 1) throw new Error(`delivery failed: the run's commits conflict with origin/${base} in ${[...new Set(paths)].join(', ')}`)
    if (tree === (await git('git rev-parse', ['rev-parse', '--verify', `${tip}^{tree}`])).trim()) continue
    const raw = (await exec('git', root, 'git cat-file', ['cat-file', 'commit', commit])).stdout
    const replayed = await exec('git', root, 'git hash-object', ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: rebuiltCommit(raw, tree, tip) })
    tip = replayed.stdout.toString().trim()
  }
  return tip
}

type Fresh = { kind: 'pushed'; target: Target } | { kind: 'empty' } | { kind: 'withheld' }

/** How many fresh names delivery tries when someone else creates each one on origin before its push. */
const FRESH_CLAIMS = 3

/**
 * Delivers the commits of a run whose pull request is no longer open on a fresh branch (ADR 0012): they are replayed
 * onto origin's default branch as just fetched, and the tip is pushed from the run's worktree to the first free name for
 * `requested`, never a retired one. The push only creates the branch, so a name someone else took meanwhile is left
 * alone and the next one is tried. Nothing is pushed when no commit is left, or when `proceed` says no right before the
 * push.
 */
function freshDelivery(prepared: PreparedWorkdir, runStart: string, head: string, requested: string, retired: readonly string[], proceed: () => boolean): Promise<Fresh> {
  return inDeliveryQueue(prepared.root, async () => {
    const git = gitIn(prepared.root)
    await git('check branch name', ['check-ref-format', '--branch', requested])
    const base = await defaultBranch(git)
    const [onto] = await fetchTips(git, basename(prepared.path), [base])
    const tip = await replay(prepared.root, runStart, head, onto, base)
    if (tip === onto) return { kind: 'empty' }
    const lost: string[] = []
    while (lost.length < FRESH_CLAIMS) {
      const branch = await freeBranch(git, requested, [...retired, ...lost])
      if (!proceed()) return { kind: 'withheld' }
      // The C locale keeps git's "(stale info)" untranslated whatever locale the server runs under.
      const push = await exec('git', prepared.path, 'git push', ['push', `--force-with-lease=refs/heads/${branch}:`, 'origin', `${tip}:refs/heads/${branch}`], { timeout: NETWORK_TIMEOUT_MS, codes: [1], env: { LC_ALL: 'C', LANG: 'C' } })
      if (push.code === 0) return { kind: 'pushed', target: { branch, base, initialHead: onto, head: tip } }
      if (!push.stderr.toString().includes('(stale info)')) throw new Error(`delivery failed: git push: ${failureReason(push)}`)
      lost.push(branch)
    }
    throw new Error(`delivery failed: git push: someone else created ${lost.join(', ')} on origin first`)
  })
}

/** The most telling line a failed child process printed, bounded for the run's failure reason. */
export function failureReason(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const telling = lines.find((line) => /^(fatal|error):|^! |rejected/i.test(line)) ?? lines.at(-1)
  const killed = typeof error === 'object' && error !== null && 'killed' in error && error.killed === true
  const reason = killed ? 'timed out' : telling ?? (error instanceof Error ? error.message.split('\n')[0] : String(error))
  return Array.from(reason).length > MAX_REASON_CHARS ? `${Array.from(reason).slice(0, MAX_REASON_CHARS - 1).join('')}…` : reason
}

const PR_URL = /^https:\/\/[^\s/]+\/\S+\/pull\/([1-9]\d*)$/

/**
 * How a delivery ended: a pull request opened, found or continued for `branch`, holding the commits in
 * `initialHead..head`; no commits to deliver, on the run's branch or, after an empty replay, on none; or withheld at the
 * server's word.
 */
export type Delivery =
  | Target & { kind: 'pull-request'; pr: Artifact }
  | { kind: 'no-changes'; branch: string | null }
  | { kind: 'withheld' }

/** The server's say over a delivery that continues a pull request (ADR 0012). */
export type Recheck = {
  /** Where the round delivers now: asked before any push, and again after a push to the pull request's branch. */
  request(): Promise<DeliveryRequest>
  /**
   * Asked right before a fresh branch is pushed, again before its pull request is looked up, and again right before
   * `gh pr create`. False withholds the delivery.
   */
  proceed(): boolean
}

/**
 * Opens a pull request for `target` against its base, unless the agent opened one itself. Withheld when `proceed` says
 * no right before the create.
 */
async function openPullRequest(cwd: string, target: Target, pr: { title: string; body: string }, proceed: () => boolean = () => true): Promise<Delivery> {
  const { branch, base } = target
  const remote = await gitIn(cwd)('git remote get-url', ['remote', 'get-url', 'origin'])
  const repository = githubUrl(remote.trim())?.slice('https://'.length)
  const repoArgs = repository ? ['--repo', repository] : []
  const asPullRequest = (url: string | undefined): Artifact | null =>
    url && url.length <= 512 && PR_URL.test(url) ? { kind: 'pr', label: `Pull request #${PR_URL.exec(url)![1]}`, url } : null
  // A failing view means there is none. Only an open PR into `base` counts.
  const existing = await exec('gh', cwd, 'gh pr view', ['pr', 'view', branch, ...repoArgs, '--json', 'url,state,baseRefName'], { timeout: 10_000 })
    .then(({ stdout }) => {
      const view: unknown = JSON.parse(stdout.toString())
      if (typeof view !== 'object' || view === null) return undefined
      const { url, state, baseRefName } = view as Record<string, unknown>
      return state === 'OPEN' && baseRefName === base && typeof url === 'string' ? url : undefined
    })
    .catch(() => undefined)
  const found = asPullRequest(existing)
  if (found) return { kind: 'pull-request', ...target, pr: found }
  if (!proceed()) return { kind: 'withheld' }
  const created = (await exec('gh', cwd, 'gh pr create', ['pr', 'create', '--head', branch, '--base', base, '--title', pr.title, '--body', pr.body, ...repoArgs], { timeout: NETWORK_TIMEOUT_MS })).stdout.toString()
  const opened = asPullRequest(created.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length <= 512 && PR_URL.test(line)).at(-1))
  if (!opened) throw new Error('delivery failed: gh pr create printed no pull request URL')
  return { kind: 'pull-request', ...target, pr: opened }
}

/**
 * Pushes a delivering run's commits and opens their pull request. A branch with no commits since the run started opens
 * nothing. A run that continues a pull request asks `recheck` where the round delivers right before it pushes, as it
 * asked at run start: to the pull request's branch while it is open, otherwise to a fresh branch and a new pull request
 * against origin's default branch. A continued pull request never gets a second one. Any failure throws
 * `delivery failed: <reason>` for the run to fail with.
 */
export async function deliver(prepared: PreparedWorkdir, pr: { title: string; body: string }, recheck: Recheck): Promise<Delivery> {
  const plan = prepared.delivery
  const runStart = prepared.initialHead
  if (!plan || !runStart) throw new Error('delivery failed: the run has no delivery branch')
  const git = gitIn(prepared.path)
  // Deliver HEAD, as gitArtifacts lists it: an agent that switched branches or detached HEAD still has its commits shipped.
  const head = (await git('git rev-parse', ['rev-parse', '--verify', 'HEAD'])).trim()
  if ((await git('git rev-list', ['rev-list', '--count', `${runStart}..${head}`])).trim() === '0') return { kind: 'no-changes', branch: plan.branch }
  const push = (branch: string) => git('git push', ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], NETWORK_TIMEOUT_MS)
  if (plan.kind === 'new') {
    // The name was picked at prepare time; the empty lease lets the run create the branch only while it is still free,
    // so a branch someone else made first fails the run and its retry takes the next name.
    await git('git push', ['push', `--force-with-lease=refs/heads/${plan.branch}:`, '-u', 'origin', `HEAD:refs/heads/${plan.branch}`], NETWORK_TIMEOUT_MS)
    return openPullRequest(prepared.path, { branch: plan.branch, base: plan.base, initialHead: runStart, head }, pr)
  }
  const now = await recheck.request()
  if (now.kind === 'continue') {
    await push(now.branch)
    // A merge or a head move that lands between the read and the push still takes the push, so only the pull request
    // that is still open on the branch just pushed counts.
    const after = await recheck.request()
    const number = PR_URL.exec(now.pr.url)?.[1] ?? '?'
    if (after.kind !== 'continue') throw new Error(`delivery failed: pull request #${number} closed while this run delivered`)
    if (after.branch !== now.branch) throw new Error(`delivery failed: pull request #${number} moved to branch ${after.branch} while this run delivered`)
    return { kind: 'pull-request', branch: now.branch, base: after.base, initialHead: runStart, head, pr: now.pr }
  }
  const fresh = await freshDelivery(prepared, runStart, head, now.branch, [...now.retired, plan.branch], recheck.proceed)
  if (fresh.kind === 'empty') return { kind: 'no-changes', branch: null }
  if (fresh.kind === 'withheld' || !recheck.proceed()) return { kind: 'withheld' }
  return openPullRequest(prepared.path, fresh.target, pr, recheck.proceed)
}

function githubUrl(remote: string): string | null {
  let path = /^git@github\.com:([^\s]+)$/i.exec(remote)?.[1]
  if (!path) {
    let url: URL
    try { url = new URL(remote) } catch { return null }
    if (url.hostname.toLowerCase() !== 'github.com' || (url.protocol !== 'https:' && url.protocol !== 'ssh:')
      || (url.protocol === 'ssh:' && url.username !== 'git') || (url.protocol === 'https:' && url.username)
      || url.password || url.search || url.hash) return null
    path = url.pathname.slice(1)
  }
  const parts = path.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  const repository = name.endsWith('.git') ? name.slice(0, -4) : name
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository)
    || owner === '.' || owner === '..' || repository === '.' || repository === '..') return null
  return `https://github.com/${owner}/${repository}`
}

/**
 * Git inspection happens after the agent exits, before the server completes the run. The commits listed are
 * `initialHead..head`, where `head` is a replayed delivery's tip or HEAD. `lookupPr` finds a PR the agent opened itself;
 * a delivering run skips it, since Factory opens that run's PR.
 */
export async function gitArtifacts(
  { path, initialHead, head = 'HEAD' }: Pick<PreparedWorkdir, 'path' | 'initialHead'> & { head?: string }, { lookupPr = true } = {},
): Promise<Artifact[]> {
  if (!initialHead) return []
  const git = async (...args: string[]) => (await execFileAsync('git', ['-C', path, ...args])).stdout.trim()
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => null)
  const remote = await git('remote', 'get-url', 'origin').catch(() => null)
  const repository = remote ? githubUrl(remote) : null
  const artifacts: Artifact[] = []
  const boundedLabel = (value: string, limit: number) => Array.from(value).length > limit ? `${Array.from(value).slice(0, limit - 1).join('')}…` : value
  if (branch) artifacts.push({ kind: 'branch', label: boundedLabel(branch, 256), url: null })
  // Git limits both the number and width of returned subjects before Node receives them.
  const history = await git('log', '--max-count=21', '--format=%H%x09%<(160,trunc)%s', `${initialHead}..${head}`)
  const lines = history.split('\n').filter(Boolean)
  if (lines.length > 20) artifacts.push({ kind: 'note', label: 'Earlier commits omitted; showing 20 newest', url: null })
  for (const line of lines.slice(0, 20).reverse()) {
    const separator = line.indexOf('\t')
    if (separator < 0) continue
    const hash = line.slice(0, separator)
    artifacts.push({ kind: 'commit', label: `${hash.slice(0, 7)} ${boundedLabel(line.slice(separator + 1).trimEnd(), 160)}`, url: null })
  }
  if (lookupPr && branch && repository) {
    const pr = await execFileAsync('gh', ['pr', 'view', branch, '--repo', repository.slice('https://'.length), '--json', 'url', '--jq', '.url'], { cwd: path, timeout: 5000 }).then(({ stdout }) => stdout.trim()).catch(() => null)
    // GitHub may return a canonical URL after a repository rename or transfer.
    const match = pr?.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)$/i)
    if (match && pr && pr.length <= 512) artifacts.push({ kind: 'pr', label: `Pull request #${match[1]}`, url: pr })
  }
  return artifacts
}

type JsonRecord = Record<string, unknown>
const record = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * What `<workdir>.owner` records: the local branch Factory created with the worktree, the commit it was cut from, the
 * lock reason git wrote into the worktree's registration as its mark, and the server process that made it.
 */
type Owner = { branch: string; initialHead: string; token: string; server: ServerProcess }
/** `started` is `''` when `ps` could not say when the server started, which leaves its liveness provable by pid alone. */
type ServerProcess = { pid: number; started: string }
const ownerFile = (workdir: string) => `${workdir}.owner`

/** When `pid` started, as `ps` prints it; `''` when the process is gone and `null` when `ps` cannot say. */
async function processStart(pid: number): Promise<string | null> {
  try {
    return (await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: LOCAL_TIMEOUT_MS, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } })).stdout.trim()
  } catch (error) {
    return (error as { code?: unknown }).code === 1 ? '' : null
  }
}

let thisServer: Promise<ServerProcess> | undefined
const serverProcess = () => (thisServer ??= processStart(process.pid).then((started) => ({ pid: process.pid, started: started ?? '' })))

/**
 * Writes the owner file, then runs `git worktree add` with `add`, locking the worktree with the owner file's token as the
 * reason. Git writes that lock into the worktree's registration as part of the add, before the post-checkout hook runs,
 * so whatever the add leaves behind, even when it fails, carries the mark that lets `removeWorkdir` claim it.
 */
async function claiming(rootPath: string, workdir: string, branch: string, initialHead: string, add: (args: string[]) => Promise<unknown>) {
  const token = `factory ${basename(workdir)} ${randomBytes(8).toString('hex')}`
  const owner: Owner = { branch, initialHead, token, server: await serverProcess() }
  // Renamed into place, so a crash never leaves a half-written file that names no branch.
  await writeFile(`${ownerFile(workdir)}.tmp`, JSON.stringify(owner))
  await rename(`${ownerFile(workdir)}.tmp`, ownerFile(workdir))
  // The branch's reflog is what later proves the branch is this run's, so it is kept even where the repository turns reflogs off.
  await add(['-c', 'core.logAllRefUpdates=true', 'worktree', 'add', '--lock', '--reason', token, '--no-track', '-b', branch, workdir, initialHead])
    .catch(async (error: unknown) => { throw await needsGit(gitIn(rootPath), error, 'locking the worktree', 2, 36) })
}

async function readOwner(workdir: string): Promise<Owner | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ownerFile(workdir), 'utf8'))
    if (record(parsed) && typeof parsed.branch === 'string' && typeof parsed.initialHead === 'string' && typeof parsed.token === 'string'
      && record(parsed.server) && typeof parsed.server.pid === 'number' && typeof parsed.server.started === 'string') {
      return { branch: parsed.branch, initialHead: parsed.initialHead, token: parsed.token, server: { pid: parsed.server.pid, started: parsed.server.started } }
    }
  } catch { /* absent or torn by a crash */ }
  return null
}

type Registered = { branch: string | null; lock: string | null }

/** Each worktree git registers for `rootPath` by path, with the branch checked out in it and its lock reason, if any. */
async function registeredWorktrees(rootPath: string): Promise<Map<string, Registered>> {
  const listing = (await execFileAsync('git', ['-C', rootPath, 'worktree', 'list', '--porcelain'], { timeout: LOCAL_TIMEOUT_MS })).stdout
  const worktrees = new Map<string, Registered>()
  for (const block of listing.split('\n\n')) {
    const lines = block.split('\n')
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) continue
    const locked = lines.find((line) => line === 'locked' || line.startsWith('locked '))
    worktrees.set(path, {
      branch: lines.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
      lock: locked === undefined ? null : locked.slice('locked '.length),
    })
  }
  return worktrees
}

/** `<rootPath>/.factory-runs` must be a directory there and not a link to somewhere else, since removal deletes beneath it. */
async function assertRunsDir(rootPath: string): Promise<void> {
  const runs = join(rootPath, '.factory-runs')
  const real = await realpath(runs).catch(() => runs)
  if (real !== runs) throw new Error(`${runs} is a symlink to ${real}; Factory needs a directory there`)
}

/** What `removeWorkdir` left alone and why, and the worktrees from before owner files it removed, described for the log. */
export type Removal = { left: string[]; legacy: string[] }
const NOTHING: Removal = { left: [], legacy: [] }

/**
 * Removes what run `runId` left under `<root>/.factory-runs`: its git worktree, the worktree's registration, the local
 * branch Factory created with it and any `refs/factory/<run id>/` refs. A branch already pushed stays on origin. Only
 * what is provably the run's goes: the worktree when its lock reason is the owner file's token, the branch when its
 * reflog begins at the commit the owner file names. Whatever is not provable stays and is returned, described, and the
 * owner file goes either way, so it is reported once. A run whose owner file names a server process that is still
 * running is that server's to remove: nothing is touched, and the owner file stays. A failure throws, keeps the owner
 * file and is retried at the next start. Every step is safe to repeat. A worktree with no owner file, from before owner
 * files existed, goes only when `ended` says this server knows its run to have ended, it is on `factory-<run id>` and
 * it is not locked, since Factory never locked those; its removal is returned, described with the branch's commit. A
 * run with no worktree, such as one in a plain directory, is left alone.
 *
 * Branches the agent made in the worktree go by the proof `judgeBranches` describes, judged before the worktree goes,
 * with `endedAt` as the end of the run's window; without it nothing the agent made is taken. A branch the agent touched
 * and Factory could not prove its own is returned in `left`. `git branch -D` takes the branch's `branch.<name>.*` config
 * with it, which is what `git push -u` wrote.
 */
export async function removeWorkdir(root: string, runId: RunId, ended: boolean, endedAt: number | null = null): Promise<Removal> {
  const rootPath = await realpath(root).catch(() => null)
  if (!rootPath) return NOTHING
  const id = basename(runId)
  const workdir = join(rootPath, '.factory-runs', id)
  return inDeliveryQueue(rootPath, async () => {
    const git = async (...args: string[]) => {
      try { return (await execFileAsync('git', ['-C', rootPath, ...args], { timeout: LOCAL_TIMEOUT_MS })).stdout } catch (error) { throw new Error(`git ${args[0]} ${args[1]}: ${failureReason(error)}`) }
    }
    const owner = await readOwner(workdir)
    if (owner && await heldByAnotherServer(owner.server)) {
      return { left: [`the worktree and branch of run ${id} (server process ${owner.server.pid}, which made them, is still running)`], legacy: [] }
    }
    // A root that is not a git repository has plain run directories, which this leaves alone.
    const listed = await registeredWorktrees(rootPath).catch((error: unknown) => { if (owner) throw error; return null })
    if (!listed) return NOTHING
    const found = listed.get(workdir)
    if (!owner && !found) return NOTHING
    await assertRunsDir(rootPath)
    if (await lstat(workdir).then((info) => info.isSymbolicLink(), () => false)) throw new Error(`${workdir} is a symlink`)
    const left: string[] = []
    const legacy: string[] = []
    const removeWorktree = async () => {
      // Two forces: the worktree is locked with Factory's mark, and may be dirty. Git validates the path before deleting.
      await git('worktree', 'remove', '--force', '--force', workdir).catch(async (error: unknown) => {
        // A worktree whose `.git` file is gone fails git's validation, while its registration still carries the mark.
        const gitFileGone = await stat(join(workdir, '.git')).then(() => false, () => true)
        if (!gitFileGone) throw error
        await rm(workdir, { recursive: true, force: true, maxRetries: 3 })
        await git('worktree', 'remove', '--force', '--force', workdir)
      })
    }
    const branchExists = (branch: string) => git('show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false)
    if (owner) {
      let kept: Registered | null = null
      // Judged while the worktree still has the HEAD reflog that shows which branches the agent switched to.
      const agentMade = found?.lock === owner.token ? await judgeBranches(rootPath, id, owner, endedAt, workdir) : { owned: [], left: [] }
      if (found) {
        if (found.lock === owner.token) await removeWorktree()
        else { kept = found; left.push(`worktree ${workdir} (its lock reason is not this run's mark)`) }
      }
      if (await branchExists(owner.branch)) {
        if (kept?.branch === owner.branch) left.push(`branch ${owner.branch} (checked out there)`)
        else if (await createdFrom(git, owner.branch) === owner.initialHead) await git('branch', '-D', owner.branch)
        else left.push(`branch ${owner.branch} (its reflog does not start at ${owner.initialHead})`)
      }
      for (const branch of agentMade.owned) await git('branch', '-D', branch)
      left.push(...agentMade.left)
      for (const ref of (await git('for-each-ref', '--format=%(refname)', `refs/factory/${id}/`)).split('\n').filter(Boolean)) await git('update-ref', '-d', ref)
      await rm(ownerFile(workdir), { force: true })
    } else if (found) {
      if (found.lock !== null) left.push(`worktree ${workdir} (no owner file, and locked${found.lock ? `: ${found.lock}` : ''})`)
      else if (!ended) left.push(`worktree ${workdir} (no owner file, and this server does not know run ${id} to have ended)`)
      else if (found.branch !== `factory-${id}`) left.push(`worktree ${workdir} (no owner file, and not on branch factory-${id})`)
      else {
        // The branch may hold commits nothing pushed; its tip is reported so an operator can still reach them by SHA.
        const head = (await git('rev-parse', '--verify', '--quiet', `refs/heads/${found.branch}`).catch(() => '')).trim()
        await removeWorktree()
        if (head) await git('branch', '-D', found.branch)
        legacy.push(`worktree ${workdir}${head ? ` and branch ${found.branch}` : ''}, made before owner files${head ? `; its commits can be recovered from ${head} until git prunes them` : ''}`)
      }
    }
    return { left, legacy }
  })
}

/**
 * The branches other than the run's own that the agent made in its worktree, judged against the proof ADR 0009 sets out.
 * A branch is `owned` when the first entry of its reflog says `branch: Created from <commit>`, was written after the
 * owner file was created and no later than `endedAt`, names a commit reachable from the run's branch, the HEAD reflog
 * of `ownWorktree` records a switch to it, and no other worktree has it checked out. A branch with a reflog entry
 * written after the owner file that fails the proof is `left`, described: it may have existed before the run, or been
 * made by someone else in the root. A branch the run never touched is not listed, and neither is a branch with no
 * reflog, which cannot be tied to any run. With no `endedAt` no branch is owned.
 * `ownWorktree` is the run's worktree, still registered, which does not count as another checkout.
 */
async function judgeBranches(rootPath: string, id: string, owner: Owner, endedAt: number | null, ownWorktree: string): Promise<{ owned: string[]; left: string[] }> {
  const git = async (...args: string[]) => (await execFileAsync('git', ['-C', rootPath, ...args], { timeout: LOCAL_TIMEOUT_MS })).stdout
  const runs = join(rootPath, '.factory-runs')
  const started = await stat(ownerFile(join(runs, id))).then((info) => Math.floor(info.mtimeMs / 1000), () => null)
  if (started === null) return { owned: [], left: [] }
  // Only the run's own worktree has this HEAD reflog, so a branch made by anyone else in the root is never in it.
  const entered = new Set((await execFileAsync('git', ['-C', ownWorktree, 'reflog', 'show', 'HEAD', '--format=%gs'], { timeout: LOCAL_TIMEOUT_MS }).then(({ stdout }) => stdout, () => '')).split('\n')
    .map((message) => /^checkout: moving from \S+ to (\S+)$/.exec(message)?.[1]).filter((name) => name !== undefined))
  const checkedOut = new Set([...await registeredWorktrees(rootPath)].filter(([path]) => path !== ownWorktree).map(([, found]) => found.branch))
  const end = endedAt === null ? null : Math.floor(endedAt / 1000)
  const owned: string[] = []
  const left: string[] = []
  for (const branch of (await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/')).split('\n').filter(Boolean)) {
    if (branch === owner.branch) continue
    // Oldest entry last. `%gd` with a unix date reads `<ref>@{<seconds>}`, the time the entry was written.
    const entries = (await git('reflog', 'show', '--date=unix', '--format=%gd%x09%H%x09%gs', `refs/heads/${branch}`, '--').catch(() => '')).trimEnd().split('\n').filter(Boolean)
      .map((line) => { const [when = '', commit = '', message = ''] = line.split('\t'); return { at: Number(/@\{(\d+)\}$/.exec(when)?.[1]), commit, message } })
    const first = entries.at(-1)
    if (!first || !entries.some((entry) => entry.at > started)) continue
    const why = async (): Promise<string | null> => {
      // Reflog times are whole seconds, so a branch made in the owner file's own second cannot be told from one that was already there.
      if (!(first.at > started)) return 'it existed before the run'
      if (!first.message.startsWith('branch: Created from ')) return 'its reflog does not begin with its creation'
      if (end === null || first.at > end) return 'its creation is not shown to be inside the run'
      if (!entered.has(branch)) return 'the run never switched to it'
      if (checkedOut.has(branch)) return 'checked out in another worktree'
      const reachable = await git('merge-base', '--is-ancestor', first.commit, `refs/heads/${owner.branch}`).then(() => true, () => false)
      return reachable ? null : `it was not made from the run's branch ${owner.branch}`
    }
    const refusal = await why()
    if (refusal === null) owned.push(branch)
    else left.push(`branch ${branch} (${refusal})`)
  }
  return { owned, left }
}

/** The branches the agent made that `removeWorkdir` will take when the run ends now, for a caller that must not name them. */
export async function agentBranchesToRemove(root: string, runId: RunId, workdir: string): Promise<string[]> {
  const rootPath = await realpath(root).catch(() => null)
  if (!rootPath) return []
  const owner = await readOwner(workdir)
  return owner ? (await judgeBranches(rootPath, basename(runId), owner, Date.now(), workdir).catch(() => ({ owned: [] }))).owned : []
}

/** The commit `branch`'s reflog says it was created from, as `git worktree add -b` wrote it; `null` without such an entry. */
async function createdFrom(git: (...args: string[]) => Promise<string>, branch: string): Promise<string | null> {
  const entries = (await git('reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--')).trimEnd().split('\n')
  // SHA-1 and SHA-256 object ids.
  const created = /^branch: Created from ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/.exec(entries.at(-1) ?? '')
  return created?.[1] ?? null
}

/**
 * Whether the server process the owner file names is still running: the pid is alive and started when the file says.
 * Its runs are not this server's to remove. A pid alive with another start time was reused after that server died; when
 * the file does not know the start time, a live pid cannot be shown to be reused, so it counts as that server.
 */
async function heldByAnotherServer({ pid, started }: ServerProcess): Promise<boolean> {
  if (pid === process.pid) return false
  try { process.kill(pid, 0) } catch (error) {
    // Only ESRCH proves the server is gone. A pid the file should never hold, such as a fractional one, is not proof.
    const code = (error as { code?: string }).code
    if (code === 'ESRCH') return false
    if (code !== 'EPERM') return true
  }
  if (started === '') return true
  const now = await processStart(pid)
  return now === null || now === started
}

/**
 * Calls `remove` for each run under `root` that has an owner file, or a registered worktree under `.factory-runs`, that
 * `live` does not claim and whose owner server is gone.
 */
export async function reconcileWorkdirs(root: string, live: (runId: RunId) => boolean, remove: (runId: RunId) => Promise<void>): Promise<void> {
  const rootPath = await realpath(root).catch(() => null)
  if (!rootPath) return
  const runs = join(rootPath, '.factory-runs')
  const ids = new Set<string>()
  for (const name of await readdir(runs).catch(() => [])) if (name.endsWith('.owner')) ids.add(name.slice(0, -'.owner'.length))
  for (const path of await registeredWorktrees(rootPath).then((found) => found.keys(), () => [])) if (dirname(path) === runs) ids.add(basename(path))
  for (const id of ids) {
    const runId = id as RunId
    const owner = await readOwner(join(runs, id))
    if (live(runId) || (owner && await heldByAnotherServer(owner.server))) continue
    await remove(runId)
  }
}

const usageTokens = (value: unknown) => {
  if (!record(value)) return null
  const input = value.input_tokens
  const output = value.output_tokens
  return typeof input === 'number' && typeof output === 'number' ? input + output : null
}

export class ClaudeRunner implements Runner {
  readonly execution = 'local'
  private processes = new Map<RunId, ReturnType<typeof spawn>>()
  private executable: string
  constructor(executable = 'claude') { this.executable = executable }

  start({ run, agent, task, workdir }: RunInput, emit: Emit) {
    const unmapped = agent.tools.filter((tool) => !(tool in TOOL_MAP))
    if (unmapped.length) emit({ kind: 'log', level: 'warn', message: `Claude tools unavailable: ${unmapped.join(', ')}` })
    const args = claudeArgs(agent, task.prompt)
    const child = spawn(this.executable, args, { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    this.processes.set(run.id, child)
    let stdout = ''
    let stderr = ''
    let tokens = 0
    let resultError: string | null = null
    let finalResult: string | null = null
    const line = (text: string) => {
      let event: unknown
      try { event = JSON.parse(text) } catch { emit({ kind: 'log', level: 'info', message: text }); return }
      if (!record(event)) return
      if (event.type === 'assistant' && record(event.message)) {
        const content = event.message.content
        if (Array.isArray(content)) for (const block of content) {
          if (record(block) && block.type === 'text' && typeof block.text === 'string') emit({ kind: 'log', level: 'info', message: block.text })
          if (record(block) && block.type === 'tool_use' && typeof block.name === 'string') emit({ kind: 'log', level: 'debug', message: `tool ${block.name}` })
        }
        const count = usageTokens(event.message.usage)
        if (count !== null) { tokens += count; emit({ kind: 'tokens', count: tokens }) }
      }
      if (event.type === 'result') {
        if (typeof event.result === 'string') {
          finalResult = event.result
          emit({ kind: 'log', level: 'info', message: event.result })
        }
        const count = usageTokens(event.usage)
        if (count !== null) emit({ kind: 'tokens', count })
        if (event.is_error === true) resultError = typeof event.result === 'string' ? event.result : 'Claude returned an error'
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const item of lines) if (item.trim()) line(item)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      const lines = stderr.split('\n')
      stderr = lines.pop() ?? ''
      for (const item of lines) if (item.trim()) emit({ kind: 'log', level: 'error', message: item })
    })
    child.on('error', (error) => { resultError = error.message })
    child.on('close', (code) => {
      this.processes.delete(run.id)
      if (stdout.trim()) line(stdout)
      if (stderr.trim()) emit({ kind: 'log', level: 'error', message: stderr })
      emit({ kind: 'complete', status: code === 0 && !resultError ? 'succeeded' : 'failed', result: finalResult, reason: resultError ?? `Claude exited ${code}` })
    })
  }

  kill(runId: RunId) {
    const child = this.processes.get(runId)
    if (!child) return
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    }
    if (!child.pid) {
      child.kill('SIGKILL')
      return
    }
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
      throw error
    }
  }
  killAll() { for (const runId of this.processes.keys()) this.kill(runId) }
}
