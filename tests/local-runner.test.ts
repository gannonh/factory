import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { startFakeLinear } from '../scripts/fake-linear'
import { createLinearClient } from '../server/linear'
import { ClaudeRunner, claudeArgs, prepareWorkdir } from '../server/runners'
import type { Emit, Runner } from '../server/runners'
import { createApi } from '../server/api'
import { MockServer } from '../server/simulation'
import { LINEAR_POLL_MS, type AgentId, type RunId, type SandboxId, type TriggerId } from '../src/domain/types'

const roots: string[] = []
const temporaryRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-local-runner-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for runner event')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

test('Claude arguments use explicit non-interactive permission mode and mapped tools', () => {
  const server = new MockServer({ manual: true })
  const agent = server.snapshot().agents['ag-coder' as AgentId]
  const args = claudeArgs(agent, 'Make the change')
  expect(args).toContain('--print')
  expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual(['--output-format', 'stream-json'])
  expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk'])
  expect(args.slice(args.indexOf('--permission-prompts'), args.indexOf('--permission-prompts') + 2)).toEqual(['--permission-prompts', 'none'])
  expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2)).toEqual(['--allowedTools', 'Read,Edit,Write,Bash'])
  expect(args).not.toContain('bypassPermissions')
  expect(args.at(-1)).toBe('Make the change')
  server.close()
})

test('local process streams logs and tokens while paused, then exit finishes the run', async () => {
  const root = temporaryRoot()
  const executable = join(root, 'fake-claude')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync('invocation.json', JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }))
const fail = process.argv.at(-1) === 'fail'
setTimeout(() => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first streamed line' }], usage: { input_tokens: 7, output_tokens: 3 } } })), 100)
setTimeout(() => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second streamed line' }], usage: { input_tokens: 2, output_tokens: 4 } } })), 250)
setTimeout(() => { console.log(JSON.stringify({ type: 'result', result: fail ? 'failed result' : 'done', is_error: fail, usage: { input_tokens: 9, output_tokens: 7 } })); process.exit(fail ? 3 : 0) }, 500)
`)
  chmodSync(executable, 0o755)
  const server = new MockServer({ manual: true, localRunner: new ClaudeRunner(executable), localRoot: root })
  for (const trigger of Object.values(server.snapshot().triggers)) server.updateTrigger(trigger.id, { enabled: false })
  const coder = server.snapshot().agents['ag-coder' as AgentId]
  server.removeEdges(Object.values(server.snapshot().edges).filter((edge) => edge.kind === 'runs-in' && edge.source === coder.id).map((edge) => edge.id))
  server.connect(coder.id, server.snapshot().sandboxes['sb-local-1' as SandboxId].id, 'runs-in')

  server.enqueueTask(coder.id, { title: 'real success', prompt: 'good', priority: 'normal' })
  server.advance(1)
  const first = Object.values(server.snapshot().runs)[0]
  expect(first.execution).toBe('local')
  expect(first.progress).toBeNull()
  expect(first.durationMs).toBeNull()
  server.setSim({ paused: true })
  await until(() => server.snapshot().logs.some((line) => line.runId === first.id && line.msg === 'first streamed line'))
  expect(server.snapshot().runs[first.id].status).toBe('running')
  expect(server.snapshot().runs[first.id].tokens).toBe(10)
  await until(() => server.snapshot().runs[first.id].status === 'succeeded')
  expect(server.snapshot().logs.filter((line) => line.runId === first.id).map((line) => line.msg)).toContain('second streamed line')
  expect(server.snapshot().runs[first.id].tokens).toBe(16)
  expect((server.snapshot().runs[first.id].endedAt ?? 0) - first.startedAt).toBeGreaterThanOrEqual(400)
  const firstDir = join(root, '.factory-runs', first.id)
  expect(existsSync(join(firstDir, 'invocation.json'))).toBe(true)
  const invocation = JSON.parse(readFileSync(join(firstDir, 'invocation.json'), 'utf8')) as { cwd: string; argv: string[] }
  expect(invocation.cwd).toBe(firstDir)
  expect(invocation.argv).toContain('Read,Edit,Write,Bash')

  server.setSim({ paused: false })
  server.enqueueTask(coder.id, { title: 'real failure', prompt: 'fail', priority: 'normal' })
  server.advance(1)
  const second = Object.values(server.snapshot().runs).find((run) => run.id !== first.id)
  expect(second).toBeDefined()
  if (!second) throw new Error('second run missing')
  await until(() => server.snapshot().runs[second.id].status === 'failed')
  expect(server.snapshot().runs[second.id].error).toContain('failed result')
  expect(existsSync(join(root, '.factory-runs', second.id, 'invocation.json'))).toBe(true)
  server.close()
})

test('a repository root gives each run a named git branch at the starting commit', async () => {
  const root = temporaryRoot()
  execFileSync('git', ['init', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'README.md'), 'root\n')
  execFileSync('git', ['-C', root, 'add', 'README.md'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'initial'])
  execFileSync('git', ['-C', root, 'branch', 'factory'])
  const first = await prepareWorkdir(root, 'run-one' as RunId, null)
  const second = await prepareWorkdir(root, 'run-two' as RunId, null)
  expect(readFileSync(join(first.path, 'README.md'), 'utf8')).toBe('root\n')
  expect(readFileSync(join(second.path, 'README.md'), 'utf8')).toBe('root\n')
  expect(first.path).not.toBe(second.path)
  expect(first.initialHead).toBe(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
  expect(first.delivery).toBeNull()
  expect(execFileSync('git', ['-C', first.path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()).toBe(first.path)
  expect(execFileSync('git', ['-C', first.path, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('factory-run-one')
  expect(execFileSync('git', ['-C', second.path, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('factory-run-two')
  expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
})

test('an empty Git repository uses a plain run directory until it has a HEAD', async () => {
  const root = temporaryRoot()
  execFileSync('git', ['init', root])
  const workdir = await prepareWorkdir(root, 'run-unborn' as RunId, null)
  expect(existsSync(workdir.path)).toBe(true)
  expect(workdir.initialHead).toBeNull()
  expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
})

test('closing while a working directory is prepared never starts the process', async () => {
  const root = temporaryRoot()
  let starts = 0
  const runner: Runner = { execution: 'local', start: () => { starts += 1 }, kill: () => {} }
  const server = new MockServer({ manual: true, localRoot: root, localRunner: runner })
  for (const trigger of Object.values(server.snapshot().triggers)) server.updateTrigger(trigger.id, { enabled: false })
  const coder = server.snapshot().agents['ag-coder' as AgentId]
  server.removeEdges(Object.values(server.snapshot().edges).filter((edge) => edge.kind === 'runs-in' && edge.source === coder.id).map((edge) => edge.id))
  server.connect(coder.id, server.snapshot().sandboxes['sb-local-1' as SandboxId].id, 'runs-in')
  server.enqueueTask(coder.id, { title: 'race', prompt: 'good', priority: 'normal' })
  server.advance(1)
  server.close()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(starts).toBe(0)
})

test('a local run whose prompt does not change publishes once during setup, when its working directory is ready', async () => {
  const root = temporaryRoot()
  let starts = 0
  const runner: Runner = { execution: 'local', start: () => { starts += 1 }, kill: () => {} }
  const server = new MockServer({ manual: true, localRoot: root, localRunner: runner })
  try {
    for (const trigger of Object.values(server.snapshot().triggers)) server.updateTrigger(trigger.id, { enabled: false })
    const coder = server.snapshot().agents['ag-coder' as AgentId]
    server.removeEdges(Object.values(server.snapshot().edges).filter((edge) => edge.kind === 'runs-in' && edge.source === coder.id).map((edge) => edge.id))
    server.connect(coder.id, server.snapshot().sandboxes['sb-local-1' as SandboxId].id, 'runs-in')
    const taskId = server.enqueueTask(coder.id, { title: 'same prompt', prompt: 'Make the change', priority: 'normal' })
    server.advance(1)
    const published: { revision: number; workdirLogged: boolean; prompt: string }[] = []
    let initial = true
    server.subscribe((world) => {
      if (initial) initial = false
      else published.push({ revision: server.revision(), workdirLogged: world.logs.some((line) => line.msg.startsWith('working directory: ')), prompt: world.tasks[taskId].prompt })
    })
    const before = server.revision()
    await until(() => starts === 1)
    expect(published).toEqual([{ revision: before + 1, workdirLogged: true, prompt: 'Make the change' }])
  } finally { server.close() }
})

function waitingProcess(timeoutMs = 120_000, options: { linear?: ReturnType<typeof createLinearClient>; clock?: () => number } = {}) {
  const root = temporaryRoot()
  const executable = join(root, 'fake-claude')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
fs.writeFileSync('pids.json', JSON.stringify({ parent: process.pid, child: child.pid }))
setInterval(() => {}, 1000)
`)
  chmodSync(executable, 0o755)
  const server = new MockServer({ manual: true, localRunner: new ClaudeRunner(executable), localRoot: root, ...options })
  for (const trigger of Object.values(server.snapshot().triggers)) server.updateTrigger(trigger.id, { enabled: false })
  const coder = server.snapshot().agents['ag-coder' as AgentId]
  server.removeEdges(Object.values(server.snapshot().edges).filter((edge) => edge.kind === 'runs-in' && edge.source === coder.id).map((edge) => edge.id))
  server.connect(coder.id, server.snapshot().sandboxes['sb-local-1' as SandboxId].id, 'runs-in')
  server.updateAgent(coder.id, { timeoutMs, retry: { maxAttempts: 1 } })
  const taskId = server.enqueueTask(coder.id, { title: 'waiting process', prompt: 'wait', priority: 'normal' })
  server.advance(1)
  const run = Object.values(server.snapshot().runs).find((item) => item.taskId === taskId)
  if (!run) throw new Error('local run was not admitted')
  const pidsFile = join(root, '.factory-runs', run.id, 'pids.json')
  return { server, taskId, run, pidsFile }
}

function running(pid: number) {
  try {
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z'
    process.kill(pid, 0)
    return true
  } catch { return false }
}

async function processIds(file: string): Promise<{ parent: number; child: number }> {
  await until(() => existsSync(file))
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || !('parent' in parsed) || !('child' in parsed)
    || typeof parsed.parent !== 'number' || typeof parsed.child !== 'number') throw new Error('fake process did not write PIDs')
  return { parent: parsed.parent, child: parsed.child }
}

test('cancelling a running local task kills its process tree and does not retry', async () => {
  const { server, taskId, run, pidsFile } = waitingProcess()
  try {
    const pids = await processIds(pidsFile)
    expect(running(pids.parent)).toBe(true)
    expect(running(pids.child)).toBe(true)
    createApi(server).tasks.cancel(taskId)
    await until(() => !running(pids.parent) && !running(pids.child))
    expect(server.snapshot().runs[run.id].status).toBe('cancelled')
    expect(server.snapshot().runs[run.id].error).toBe('cancelled by operator')
    expect(server.snapshot().tasks[taskId].status).toBe('cancelled')
    expect(server.snapshot().sandboxes[run.sandboxId].leases).toEqual([])
  } finally { server.close() }
})

test('an issue canceled in Linear kills its local process tree within one poll and gets one note', async () => {
  const fake = await startFakeLinear({ apiKey: 'lin_api_local' })
  const control = (body: Record<string, unknown>) => fetch(fake.controlUrl, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json())
  const wall = { now: 1_000_000 }
  await control({ op: 'addIssue', title: 'Fix login' })
  const { server, taskId, pidsFile } = waitingProcess(120_000, { linear: createLinearClient({ url: fake.url, apiKey: 'lin_api_local' }), clock: () => wall.now })
  try {
    server.cancelTask(taskId)
    const trigger = server.createNode('trigger', { x: 0, y: 0 }) as TriggerId
    server.updateTrigger(trigger, { kind: 'linear' })
    server.connect(trigger, 'ag-coder' as AgentId, 'triggers')
    server.updateTrigger(trigger, {
      enabled: true,
      linear: { team: 'team-eng', project: null, pickupState: 'state-eng-todo', startedState: 'state-eng-in-progress', finishedState: null, failedState: 'state-eng-backlog' },
    })
    server.advance(0)
    await server.settled()
    server.advance(1)
    const run = Object.values(server.snapshot().runs).find((r) => r.title === 'ENG-1 Fix login')!
    const pids = await processIds(join(pidsFile, '..', '..', run.id, 'pids.json'))
    expect(running(pids.parent)).toBe(true)

    await control({ op: 'moveIssue', identifier: 'ENG-1', state: 'Canceled' })
    wall.now += LINEAR_POLL_MS
    server.advance(1)
    await server.settled()
    await until(() => !running(pids.parent) && !running(pids.child))
    expect(server.snapshot().runs[run.id]).toMatchObject({ status: 'cancelled', error: 'canceled in Linear' })
    expect(server.snapshot().tasks[run.taskId]).toMatchObject({ status: 'cancelled', retryAt: null })
    const issue = await control({ op: 'issue', identifier: 'ENG-1' }) as { state: string; comments: unknown[] }
    expect(issue.state).toBe('Canceled')
    expect(issue.comments).toHaveLength(1)
  } finally {
    await server.close()
    await fake.close()
  }
})

for (const mode of ['paused', 'fast'] as const) {
  test(`a local timeout uses wall time while simulation is ${mode} and kills the process tree`, async () => {
    const { server, taskId, run, pidsFile } = waitingProcess(1200)
    try {
      const pids = await processIds(pidsFile)
      if (mode === 'paused') server.setSim({ paused: true })
      else server.setSim({ speed: 4 })
      server.advance(100_000)
      expect(server.snapshot().runs[run.id].status).toBe('running')
      await until(() => server.snapshot().runs[run.id].status === 'failed')
      await until(() => !running(pids.parent) && !running(pids.child))
      expect(server.snapshot().runs[run.id].error).toBe('timeout')
      expect((server.snapshot().runs[run.id].endedAt ?? 0) - run.startedAt).toBeGreaterThanOrEqual(1100)
      expect(server.snapshot().tasks[taskId].status).toBe('failed')
      expect(server.snapshot().sandboxes[run.sandboxId].leases).toEqual([])
    } finally { server.close() }
  })
}

test('cancelling during workdir preparation prevents spawn', async () => {
  const root = temporaryRoot()
  let starts = 0
  const runner: Runner = { execution: 'local', start: () => { starts += 1 }, kill: () => {} }
  const server = new MockServer({ manual: true, localRoot: root, localRunner: runner })
  try {
    for (const trigger of Object.values(server.snapshot().triggers)) server.updateTrigger(trigger.id, { enabled: false })
    const coder = server.snapshot().agents['ag-coder' as AgentId]
    server.removeEdges(Object.values(server.snapshot().edges).filter((edge) => edge.kind === 'runs-in' && edge.source === coder.id).map((edge) => edge.id))
    server.connect(coder.id, server.snapshot().sandboxes['sb-local-1' as SandboxId].id, 'runs-in')
    const taskId = server.enqueueTask(coder.id, { title: 'cancel during setup', prompt: 'wait', priority: 'normal' })
    server.advance(1)
    const run = Object.values(server.snapshot().runs).find((item) => item.taskId === taskId)
    if (!run) throw new Error('local run was not admitted')
    server.cancelTask(taskId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(starts).toBe(0)
    expect(server.snapshot().runs[run.id].status).toBe('cancelled')
  } finally { server.close() }
})

test('a late runner completion cannot overwrite cancellation', async () => {
  const root = temporaryRoot()
  const state: { emit?: Emit } = {}
  const runner: Runner = { execution: 'local', start: (_input, emit) => { state.emit = emit }, kill: () => {} }
  const server = new MockServer({ manual: true, localRoot: root, localRunner: runner })
  try {
    for (const trigger of Object.values(server.snapshot().triggers)) server.updateTrigger(trigger.id, { enabled: false })
    const coder = server.snapshot().agents['ag-coder' as AgentId]
    server.removeEdges(Object.values(server.snapshot().edges).filter((edge) => edge.kind === 'runs-in' && edge.source === coder.id).map((edge) => edge.id))
    server.connect(coder.id, server.snapshot().sandboxes['sb-local-1' as SandboxId].id, 'runs-in')
    const taskId = server.enqueueTask(coder.id, { title: 'late event', prompt: 'wait', priority: 'normal' })
    server.advance(1)
    const run = Object.values(server.snapshot().runs).find((item) => item.taskId === taskId)
    if (!run) throw new Error('local run was not admitted')
    await until(() => state.emit !== undefined)
    server.cancelTask(taskId)
    state.emit?.({ kind: 'complete', status: 'succeeded', result: 'too late' })
    expect(server.snapshot().runs[run.id].status).toBe('cancelled')
    expect(server.snapshot().tasks[taskId].status).toBe('cancelled')
  } finally { server.close() }
})
