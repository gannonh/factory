import { spawn, spawnSync, execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Agent, LogLevel, Run, RunId, Task } from '../src/domain/types'

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

export async function prepareWorkdir(root: string, runId: RunId): Promise<string> {
  if (!isAbsolute(root)) throw new Error('local sandbox root must be an absolute path')
  const rootPath = await realpath(root)
  if (!(await stat(rootPath)).isDirectory()) throw new Error('local sandbox root must be a directory')
  const workdir = join(rootPath, '.factory-runs', basename(runId))
  let gitRoot: string | null = null
  try { gitRoot = (await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--show-toplevel'])).stdout.trim() } catch { /* plain directory */ }
  await mkdir(join(rootPath, '.factory-runs'), { recursive: true })
  if (gitRoot && resolve(gitRoot) === rootPath) {
    const excludePath = (await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--git-path', 'info/exclude'])).stdout.trim()
    const exclude = isAbsolute(excludePath) ? excludePath : resolve(rootPath, excludePath)
    const current = await readFile(exclude, 'utf8').catch(() => '')
    if (!current.split(/\r?\n/).includes('/.factory-runs/')) {
      await mkdir(dirname(exclude), { recursive: true })
      await appendFile(exclude, `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}/.factory-runs/\n`)
    }
    let hasHead = true
    try { await execFileAsync('git', ['-C', rootPath, 'rev-parse', '--verify', 'HEAD']) } catch { hasHead = false }
    if (hasHead) await execFileAsync('git', ['-C', rootPath, 'worktree', 'add', '--detach', workdir, 'HEAD'])
    else await mkdir(workdir)
  } else {
    await mkdir(workdir)
  }
  return workdir
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
