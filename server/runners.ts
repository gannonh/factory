import { spawn, spawnSync, execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Agent, Artifact, LogLevel, Run, RunId, Task } from '../src/domain/types'

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

/** Where a delivering run's branch goes: `branch` is pushed to origin and opened as a pull request against `base`. */
export type DeliveryPlan = { branch: string; base: string }

/** `initialHead` is the commit the run started from; a delivering run starts from origin's default branch. */
export type PreparedWorkdir = { path: string; initialHead: string | null; delivery: DeliveryPlan | null }

const NETWORK_TIMEOUT_MS = 120_000
const LOCAL_TIMEOUT_MS = 15_000
const MAX_REASON_CHARS = 300
// Network git must fail rather than wait on a credential prompt nobody can answer, over HTTPS or SSH.
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' })

/**
 * Makes the run's working directory. With no delivery the worktree branches `factory-<runId>` from the
 * root's HEAD. With delivery it fetches origin and cuts the requested branch from origin's default branch,
 * suffixed `-2`, `-3`, … until the name is free locally and on origin, so a retry never reuses a pushed branch.
 */
export async function prepareWorkdir(root: string, runId: RunId, delivery: { branch: string } | null): Promise<PreparedWorkdir> {
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
    return { path: workdir, initialHead: null, delivery: null }
  }
  const excludePath = (await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--git-path', 'info/exclude'])).stdout.trim()
  const exclude = isAbsolute(excludePath) ? excludePath : resolve(rootPath, excludePath)
  const current = await readFile(exclude, 'utf8').catch(() => '')
  if (!current.split(/\r?\n/).includes('/.factory-runs/')) {
    await mkdir(dirname(exclude), { recursive: true })
    await appendFile(exclude, `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}/.factory-runs/\n`)
  }
  if (delivery) return prepareDelivery(rootPath, workdir, delivery.branch)
  const initialHead = await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--verify', 'HEAD']).then(({ stdout }) => stdout.trim()).catch(() => null)
  if (initialHead) {
    await execFileAsync('git', ['-C', rootPath, 'worktree', 'add', '-b', `factory-${runId}`, workdir, initialHead])
    return { path: workdir, initialHead, delivery: null }
  }
  await mkdir(workdir)
  return { path: workdir, initialHead: null, delivery: null }
}

// Two runs on one repository must not pick the same free branch name or fetch at once.
const deliveryQueues = new Map<string, Promise<unknown>>()

function prepareDelivery(rootPath: string, workdir: string, requested: string): Promise<PreparedWorkdir> {
  const turn = (deliveryQueues.get(rootPath) ?? Promise.resolve()).then(() => prepareDeliveryNow(rootPath, workdir, requested))
  const queued = turn.catch(() => undefined)
  deliveryQueues.set(rootPath, queued)
  void queued.then(() => { if (deliveryQueues.get(rootPath) === queued) deliveryQueues.delete(rootPath) })
  return turn
}

async function prepareDeliveryNow(rootPath: string, workdir: string, requested: string): Promise<PreparedWorkdir> {
  const git = (step: string, args: string[], timeout = LOCAL_TIMEOUT_MS) =>
    execFileAsync('git', ['-C', rootPath, ...args], { timeout, env: gitEnv() }).then(({ stdout }) => stdout, (error: unknown) => {
      throw new Error(`delivery failed: ${step}: ${failureReason(error)}`)
    })
  await git('check branch name', ['check-ref-format', '--branch', requested])
  const hasOrigin = await execFileAsync('git', ['-C', rootPath, 'remote', 'get-url', 'origin'], { timeout: LOCAL_TIMEOUT_MS }).then(() => true, () => false)
  if (!hasOrigin) throw new Error('delivery failed: sandbox root has no origin remote')
  const symref = await git('git ls-remote', ['ls-remote', '--symref', 'origin', 'HEAD'], NETWORK_TIMEOUT_MS)
  const base = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref)?.[1]
  if (!base) throw new Error('delivery failed: origin has no default branch')
  await git('git fetch', ['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], NETWORK_TIMEOUT_MS)
  const remoteHeads = await git('git ls-remote', ['ls-remote', '--heads', 'origin'], NETWORK_TIMEOUT_MS)
  const taken = new Set(remoteHeads.split('\n').map((line) => line.split('\t')[1]?.replace(/^refs\/heads\//, '')).filter(Boolean))
  const local = await git('git for-each-ref', ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'])
  for (const name of local.split('\n')) if (name) taken.add(name)
  let branch = requested
  for (let n = 2; taken.has(branch); n++) branch = `${requested}-${n}`
  const initialHead = (await git('git rev-parse', ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`])).trim()
  await git('git worktree add', ['worktree', 'add', '--no-track', '-b', branch, workdir, initialHead])
  return { path: workdir, initialHead, delivery: { branch, base } }
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
 * Pushes a delivering run's branch and opens its pull request. A branch with no commits since the run
 * started opens nothing and says so. Any failure throws `delivery failed: <reason>` for the run to fail with.
 */
export async function deliver(prepared: PreparedWorkdir, pr: { title: string; body: string }): Promise<Artifact[]> {
  if (!prepared.delivery || !prepared.initialHead) throw new Error('delivery failed: the run has no delivery branch')
  const { branch, base } = prepared.delivery
  const run = (command: 'git' | 'gh', step: string, args: string[], timeout: number) =>
    execFileAsync(command, args, { cwd: prepared.path, timeout, env: gitEnv(), maxBuffer: 1024 * 1024 }).then(({ stdout }) => stdout, (error: unknown) => {
      throw new Error(`delivery failed: ${step}: ${failureReason(error)}`)
    })
  // Deliver HEAD, as gitArtifacts lists it: an agent that switched branches or detached HEAD still has its commits shipped.
  const count = Number((await run('git', 'git rev-list', ['rev-list', '--count', `${prepared.initialHead}..HEAD`], LOCAL_TIMEOUT_MS)).trim())
  if (count === 0) return [{ kind: 'note', label: 'No changes; no pull request opened', url: null }]
  await run('git', 'git push', ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], NETWORK_TIMEOUT_MS)
  const remote = await run('git', 'git remote get-url', ['remote', 'get-url', 'origin'], LOCAL_TIMEOUT_MS)
  const repository = githubUrl(remote.trim())?.slice('https://'.length)
  const repoArgs = repository ? ['--repo', repository] : []
  const asPullRequest = (url: string | undefined): Artifact[] | null =>
    url && url.length <= 512 && PR_URL.test(url) ? [{ kind: 'pr', label: `Pull request #${PR_URL.exec(url)![1]}`, url }] : null
  // The agent may have opened the pull request itself; a failing view means there is none.
  const existing = await execFileAsync('gh', ['pr', 'view', branch, ...repoArgs, '--json', 'url', '--jq', '.url'], { cwd: prepared.path, timeout: 10_000, env: gitEnv() })
    .then(({ stdout }) => stdout.trim(), () => undefined)
  const found = asPullRequest(existing)
  if (found) return found
  const created = await run('gh', 'gh pr create', ['pr', 'create', '--head', branch, '--base', base, '--title', pr.title, '--body', pr.body, ...repoArgs], NETWORK_TIMEOUT_MS)
  const opened = asPullRequest(created.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length <= 512 && PR_URL.test(line)).at(-1))
  if (!opened) throw new Error('delivery failed: gh pr create printed no pull request URL')
  return opened
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
 * Git inspection happens after the agent exits, before the server completes the run. `lookupPr` finds a PR
 * the agent opened itself; a delivering run skips it, since Factory opens that run's PR.
 */
export async function gitArtifacts({ path, initialHead }: Pick<PreparedWorkdir, 'path' | 'initialHead'>, { lookupPr = true } = {}): Promise<Artifact[]> {
  if (!initialHead) return []
  const git = async (...args: string[]) => (await execFileAsync('git', ['-C', path, ...args])).stdout.trim()
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => null)
  const remote = await git('remote', 'get-url', 'origin').catch(() => null)
  const repository = remote ? githubUrl(remote) : null
  const artifacts: Artifact[] = []
  const boundedLabel = (value: string, limit: number) => Array.from(value).length > limit ? `${Array.from(value).slice(0, limit - 1).join('')}…` : value
  if (branch) artifacts.push({ kind: 'branch', label: boundedLabel(branch, 256), url: null })
  // Git limits both the number and width of returned subjects before Node receives them.
  const history = await git('log', '--max-count=21', '--format=%H%x09%<(160,trunc)%s', `${initialHead}..HEAD`)
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
