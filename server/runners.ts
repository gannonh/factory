import { spawn, spawnSync, execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
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
    await execFileAsync('git', ['-C', rootPath, 'worktree', 'add', '-b', `factory-${runId}`, workdir, initialHead])
    return { root: rootPath, path: workdir, initialHead, delivery: null }
  }
  await mkdir(workdir)
  return { root: rootPath, path: workdir, initialHead: null, delivery: null }
}

// Two runs on one repository must not pick the same free branch name or fetch at once.
const deliveryQueues = new Map<string, Promise<unknown>>()

function inDeliveryQueue<T>(rootPath: string, work: () => Promise<T>): Promise<T> {
  const turn = (deliveryQueues.get(rootPath) ?? Promise.resolve()).then(work)
  const queued = turn.catch(() => undefined)
  deliveryQueues.set(rootPath, queued)
  void queued.then(() => { if (deliveryQueues.get(rootPath) === queued) deliveryQueues.delete(rootPath) })
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

type Git = (step: string, args: string[], timeout?: number) => Promise<string>

const gitIn = (cwd: string): Git => async (step, args, timeout) => (await exec('git', cwd, step, args, { timeout })).stdout.toString()

async function defaultBranch(git: Git): Promise<string> {
  const symref = await git('git ls-remote', ['ls-remote', '--symref', 'origin', 'HEAD'], NETWORK_TIMEOUT_MS)
  const base = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref)?.[1]
  if (!base) throw new Error('delivery failed: origin has no default branch')
  return base
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
    await git('git fetch', ['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${requested}:refs/remotes/origin/${requested}`], NETWORK_TIMEOUT_MS)
    const initialHead = (await git('git rev-parse', ['rev-parse', '--verify', `refs/remotes/origin/${requested}^{commit}`])).trim()
    await git('git worktree add', ['worktree', 'add', '--no-track', '-b', runBranch, workdir, initialHead])
    return { root: rootPath, path: workdir, initialHead, delivery: { kind: 'continue', branch: requested, base } }
  }
  const base = await defaultBranch(git)
  await git('git fetch', ['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], NETWORK_TIMEOUT_MS)
  const branch = await freeBranch(git, requested, request.retired)
  const initialHead = (await git('git rev-parse', ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`])).trim()
  await git('git worktree add', ['worktree', 'add', '--no-track', '-b', branch, workdir, initialHead])
  return { root: rootPath, path: workdir, initialHead, delivery: { kind: 'new', branch, base } }
}

/** Where a run's commits go: `branch` against `base`, holding the commits in `initialHead..head`. */
type Target = { branch: string; base: string; initialHead: string; head: string }

/** Why `merge-tree` failed, naming the git 2.40 floor only when this git is older. */
async function mergeTreeFailure(root: string, error: unknown): Promise<Error> {
  const reason = error instanceof Error ? error.message : String(error)
  const version = /(\d+)\.(\d+)[\w.]*/.exec(await gitIn(root)('git version', ['version']).catch(() => ''))
  const old = version !== null && (Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 40))
  return new Error(old ? `${reason} (replaying commits needs git 2.40 or later; this is git ${version[0]})` : reason)
}

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
    await git('git fetch', ['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], NETWORK_TIMEOUT_MS)
    const onto = (await git('git rev-parse', ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`])).trim()
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
    await push(plan.branch)
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
    return { kind: 'pull-request', branch: now.branch, base: now.base, initialHead: runStart, head, pr: now.pr }
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
