import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { gitArtifacts, type Emit, type Runner, type RunInput } from '../server/runners'
import { startFactoryServer } from '../server/http'
import { fileRunLogs } from '../server/runLogs'
import { MockServer } from '../server/simulation'
import { fileStore } from '../server/worldFile'
import type { RunId, SandboxId } from '../src/domain/types'

const roots: string[] = []
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'factory-output-'))
  roots.push(path)
  return path
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()
}

function repository(path: string) {
  git(path, 'init')
  git(path, 'config', 'user.email', 'test@example.com')
  git(path, 'config', 'user.name', 'Test')
  writeFileSync(join(path, 'base.txt'), 'before the run\n')
  git(path, 'add', 'base.txt')
  git(path, 'commit', '-m', 'preexisting')
}

async function until(check: () => boolean, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the run')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('git artifacts show the run branch and only commits after its initial HEAD', async () => {
  const path = root()
  repository(path)
  const workdir = join(path, '.factory-runs', 'run-test')
  git(path, 'worktree', 'add', '-b', 'factory-run-test', workdir, 'HEAD')
  const initialHead = git(workdir, 'rev-parse', 'HEAD')
  for (const [name, title] of [['one', 'first change'], ['two', 'second change']]) {
    writeFileSync(join(workdir, `${name}.txt`), title)
    git(workdir, 'add', `${name}.txt`)
    git(workdir, 'commit', '-m', title)
  }
  const artifacts = await gitArtifacts({ path: workdir, initialHead })
  expect(artifacts).toEqual([
    { kind: 'branch', label: 'factory-run-test', url: null },
    { kind: 'commit', label: `${git(workdir, 'rev-list', '--reverse', `${initialHead}..HEAD`).split('\n')[0].slice(0, 7)} first change`, url: null },
    { kind: 'commit', label: `${git(workdir, 'rev-parse', 'HEAD').slice(0, 7)} second change`, url: null },
  ])
  expect(artifacts.some((artifact) => artifact.label.includes('preexisting'))).toBe(false)
})

test('a PR link appears only when gh finds a PR for the run branch', async () => {
  const path = root()
  repository(path)
  git(path, 'remote', 'add', 'origin', 'git@github.com:example/factory.git')
  const workdir = join(path, '.factory-runs', 'run-pr')
  git(path, 'worktree', 'add', '-b', 'factory-run-pr', workdir, 'HEAD')
  const initialHead = git(workdir, 'rev-parse', 'HEAD')
  const bin = join(path, 'bin')
  mkdirSync(bin)
  const fakeGh = join(bin, 'gh')
  writeFileSync(fakeGh, '#!/bin/sh\nprintf "https://github.com/example/factory/pull/42\\n"\n')
  chmodSync(fakeGh, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  try {
    for (const remote of ['git@github.com:example/factory.git', 'ssh://git@github.com:22/example/factory.git', 'https://github.com/example/factory.git']) {
      git(path, 'remote', 'set-url', 'origin', remote)
      expect(await gitArtifacts({ path: workdir, initialHead })).toEqual([
        { kind: 'branch', label: 'factory-run-pr', url: null },
        { kind: 'pr', label: 'Pull request #42', url: 'https://github.com/example/factory/pull/42' },
      ])
    }
    git(path, 'remote', 'set-url', 'origin', 'ssh://git@other.example/example/factory.git')
    expect(await gitArtifacts({ path: workdir, initialHead })).toEqual([{ kind: 'branch', label: 'factory-run-pr', url: null }])
  } finally { process.env.PATH = previousPath }
})

test('a real result and git artifacts reach handoff; real logs survive restart', async () => {
  const path = root()
  repository(path)
  const dataDir = root()
  const logErrors: string[] = []
  const inputs: string[] = []
  const runner: Runner = {
    execution: 'local',
    start({ task, workdir }: RunInput, emit: Emit) {
      inputs.push(task.prompt)
      emit({ kind: 'log', level: 'info', message: `working on ${task.title}` })
      if (!task.input) {
        writeFileSync(join(workdir, 'result.txt'), 'result from agent\n')
        git(workdir, 'add', 'result.txt')
        git(workdir, 'commit', '-m', 'agent result')
      }
      emit({ kind: 'complete', status: 'succeeded', result: task.input ? 'reviewed result' : 'agent final result\nsecond line' })
    },
    kill() {},
  }
  const options = { manual: true, localRunner: runner, localRoot: path, runLogs: fileRunLogs(dataDir, (message) => logErrors.push(message)), store: fileStore(join(dataDir, 'world.json')) }
  const first = new MockServer(options)
  for (const trigger of Object.values(first.snapshot().triggers)) first.updateTrigger(trigger.id, { enabled: false })
  const planner = Object.values(first.snapshot().agents).find((agent) => agent.name === 'Planner')!
  const coder = Object.values(first.snapshot().agents).find((agent) => agent.name === 'Coder')!
  const local = 'sb-local-1' as SandboxId
  first.removeEdges(Object.values(first.snapshot().edges).filter((edge) => edge.kind === 'runs-in' && edge.source === coder.id).map((edge) => edge.id))
  first.connect(coder.id, local, 'runs-in')
  first.removeEdges(Object.values(first.snapshot().edges).filter((edge) => edge.kind === 'handoff' && edge.source === coder.id).map((edge) => edge.id))
  const taskId = first.enqueueTask(planner.id, { title: 'plan', prompt: 'make a result', priority: 'normal' })
  first.advance(1)
  await until(() => Object.values(first.snapshot().tasks).some((task) => task.origin.kind === 'handoff'))
  const upstream = Object.values(first.snapshot().runs).find((run) => run.taskId === taskId)!
  const inputTask = Object.values(first.snapshot().tasks).find((task) => task.origin.kind === 'handoff')!
  expect(upstream.output?.summary).toBe('agent final result\nsecond line')
  expect(upstream.output?.artifacts.map((artifact) => artifact.kind)).toEqual(['branch', 'commit'])
  expect(inputTask.input).toEqual({ ...upstream.output, runId: upstream.id })
  first.advance(1)
  await until(() => Object.values(first.snapshot().runs).some((run) => run.taskId === inputTask.id && run.status === 'succeeded'))
  expect(inputs[1]).toContain('agent final result\nsecond line')
  expect(inputs[1]).toContain('commit:')
  const logFile = join(dataDir, 'run-logs', `${upstream.id}.jsonl`)
  expect(readFileSync(logFile, 'utf8')).toContain('working on plan')
  const before = first.snapshot().logs.filter((line) => line.runId === upstream.id)
  first.close()
  appendFileSync(logFile, `{"id":1e400,"ts":1e400,"level":"info","runId":"${upstream.id}","agentId":null,"msg":"invalid number"}\n`)
  appendFileSync(logFile, `{"id":1e300,"ts":1,"level":"info","runId":"${upstream.id}","agentId":null,"msg":"unsafe id"}\n`)
  appendFileSync(logFile, `{"id":1,"ts":1e300,"level":"info","runId":"${upstream.id}","agentId":null,"msg":"unsafe timestamp"}\n`)
  appendFileSync(logFile, `{"id":9007199254740991,"ts":1,"level":"info","runId":"${upstream.id}","agentId":null,"msg":"maximum safe id"}\n`)
  appendFileSync(logFile, '{truncated\n')

  const second = new MockServer(options)
  const restored = second.snapshot().logs.filter((line) => line.runId === upstream.id)
  expect(restored).toEqual(before)
  expect(logErrors).toHaveLength(1)
  expect(second.snapshot().runs[upstream.id].output).toEqual(upstream.output)
  const maxId = Math.max(...second.snapshot().logs.map((line) => line.id), ...second.snapshot().events.map((event) => event.id))
  second.enqueueTask(planner.id, { title: 'next', prompt: 'another', priority: 'normal' })
  expect(second.snapshot().events.at(-1)!.id).toBeGreaterThan(maxId)
  expect(Number.isFinite(second.snapshot().events.at(-1)!.id)).toBe(true)
  second.close()
  const third = new MockServer(options)
  expect(third.snapshot().runs[upstream.id].output).toEqual(upstream.output)
  third.close()
})

test('shutdown waits for a successful result and its pending PR lookup', async () => {
  const path = root()
  repository(path)
  git(path, 'remote', 'add', 'origin', 'git@github.com:example/factory.git')
  const dataDir = root()
  const bin = root()
  const fakeGh = join(bin, 'gh')
  writeFileSync(fakeGh, '#!/bin/sh\nsleep 1\nprintf "https://github.com/example/factory/pull/42\\n"\n')
  chmodSync(fakeGh, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  let exited = false
  const runner: Runner = {
    execution: 'local',
    start(_input, emit) {
      exited = true
      emit({ kind: 'complete', status: 'succeeded', result: 'finished before shutdown' })
    },
    kill() {},
  }
  const options = { manual: true, localRunner: runner, localRoot: path, runLogs: fileRunLogs(dataDir), store: fileStore(join(dataDir, 'world.json')) }
  try {
    const first = new MockServer(options)
    const running = await startFactoryServer(first, { port: 0, origins: ['http://localhost:5173'] })
    for (const trigger of Object.values(first.snapshot().triggers)) first.updateTrigger(trigger.id, { enabled: false })
    const planner = Object.values(first.snapshot().agents).find((agent) => agent.name === 'Planner')!
    const taskId = first.enqueueTask(planner.id, { title: 'plan', prompt: 'make a result', priority: 'normal' })
    first.advance(1)
    await until(() => exited)
    const run = Object.values(first.snapshot().runs).find((item) => item.taskId === taskId)!
    expect(first.snapshot().runs[run.id].status).toBe('running')
    const inFlight = request({ hostname: '127.0.0.1', port: running.port, path: '/command', method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' } })
    inFlight.on('error', () => {})
    const disconnected = new Promise<void>((resolve) => inFlight.once('close', resolve))
    const connected = new Promise<void>((resolve) => inFlight.once('socket', (socket) => {
      if (socket.connecting) socket.once('connect', () => resolve())
      else resolve()
    }))
    inFlight.write('{"method":"sim.reset","args":[')
    await connected
    await running.close()
    await disconnected
    expect(first.snapshot().runs[run.id].status).toBe('running')
    await expect(fetch(`http://127.0.0.1:${running.port}/command`, {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'sim.reset', args: [] }),
    })).rejects.toThrow()
    await first.close()
    expect(first.snapshot().runs[run.id].output).toEqual({ summary: 'finished before shutdown', artifacts: [
      { kind: 'branch', label: `factory-${run.id}`, url: null },
      { kind: 'pr', label: 'Pull request #42', url: 'https://github.com/example/factory/pull/42' },
    ] })
    const second = new MockServer(options)
    expect(second.snapshot().runs[run.id].status).toBe('succeeded')
    expect(second.snapshot().runs[run.id].output).toEqual(first.snapshot().runs[run.id].output)
    expect(Object.values(second.snapshot().tasks).some((task) => task.origin.kind === 'handoff' && task.input?.summary === 'finished before shutdown')).toBe(true)
    await second.close()
  } finally { process.env.PATH = previousPath }
})

test('log files are pruned only after a durable save and are cleared by reset', async () => {
  const path = root()
  repository(path)
  const dataDir = root()
  const worldFile = join(dataDir, 'world.json')
  const runLogs = fileRunLogs(dataDir)
  const runner: Runner = {
    execution: 'local',
    start(_input, emit) { emit({ kind: 'complete', status: 'succeeded', result: 'done' }) },
    kill() {},
  }
  const server = new MockServer({ manual: true, localRunner: runner, localRoot: path, runLogs, store: fileStore(worldFile) })
  for (const trigger of Object.values(server.snapshot().triggers)) server.updateTrigger(trigger.id, { enabled: false })
  const planner = Object.values(server.snapshot().agents).find((agent) => agent.name === 'Planner')!
  const taskId = server.enqueueTask(planner.id, { title: 'plan', prompt: 'make a result', priority: 'normal' })
  server.advance(1)
  await until(() => Object.values(server.snapshot().runs).some((run) => run.taskId === taskId && run.status === 'succeeded'))
  const original = Object.values(server.snapshot().runs).find((run) => run.taskId === taskId)!
  const oldLog = join(dataDir, 'run-logs', `${original.id}.jsonl`)
  expect(existsSync(oldLog)).toBe(true)
  server.flush()

  for (let number = 1; number <= 201; number++) {
    const id = `run-retained-${number}` as RunId
    server.snapshot().runs[id] = { ...original, id, startedAt: original.startedAt + number }
  }
  const retainedLog = join(dataDir, 'run-logs', 'run-retained-201.jsonl')
  runLogs.append({ id: 9999, ts: Date.now(), level: 'info', runId: 'run-retained-201' as RunId, agentId: null, msg: 'retained' })
  mkdirSync(`${worldFile}.tmp`)
  server.flush()
  expect(existsSync(oldLog)).toBe(true)
  rmSync(`${worldFile}.tmp`, { recursive: true })
  server.flush()
  expect(existsSync(oldLog)).toBe(false)
  expect(existsSync(retainedLog)).toBe(true)
  server.reset()
  expect(existsSync(retainedLog)).toBe(false)
  await server.close()
})

test('retained log files and legacy reads keep a bounded tail of complete lines', () => {
  const dataDir = root()
  const logs = fileRunLogs(dataDir)
  const runId = 'run-rotation' as RunId
  const file = join(dataDir, 'run-logs', `${runId}.jsonl`)
  for (let number = 1; number <= 300; number++) {
    logs.append({ id: number, ts: number, level: 'info', runId, agentId: null, msg: 'x'.repeat(8192) })
  }
  expect(statSync(file).size).toBeLessThanOrEqual(1024 * 1024)
  const retained = logs.load([runId], 2000)
  expect(retained[0].id).toBeGreaterThan(1)
  expect(retained.at(-1)?.id).toBe(300)
  logs.append({ id: 301, ts: 301, level: 'info', runId, agentId: null, msg: 'y'.repeat(2_000_000) })
  expect(statSync(file).size).toBeLessThanOrEqual(1024 * 1024)
  expect(logs.load([runId], 2000).at(-1)?.msg).toBe(`${'y'.repeat(8191)}…`)

  const legacyId = 'run-legacy' as RunId
  const legacyFile = join(dataDir, 'run-logs', `${legacyId}.jsonl`)
  const last = { id: 302, ts: 302, level: 'info', runId: legacyId, agentId: null, msg: 'legacy final line' }
  writeFileSync(legacyFile, `${'z'.repeat(2 * 1024 * 1024)}\n${JSON.stringify(last)}\n`)
  expect(logs.load([legacyId], 2000)).toEqual([last])
  expect(statSync(legacyFile).size).toBeLessThanOrEqual(1024 * 1024)
})

test('restored logs keep the latest global lines across retained runs', () => {
  const logs = fileRunLogs(root())
  const older = 'run-older' as RunId
  const newer = 'run-newer' as RunId
  for (let number = 1; number <= 3000; number++) {
    const runId = number <= 1500 ? older : newer
    logs.append({ id: number, ts: number, level: 'info', runId, agentId: null, msg: `line ${number}` })
  }
  const loaded = logs.load([newer, older], 2000)
  expect(loaded).toHaveLength(2000)
  expect(loaded[0].id).toBe(1001)
  expect(loaded.at(-1)?.id).toBe(3000)
})

test('reset during failed Git inspection does not add an orphaned warning', async () => {
  const path = root()
  repository(path)
  const bin = root()
  const fakeGit = join(bin, 'git')
  const inspectionStarted = join(bin, 'inspection-started')
  writeFileSync(fakeGit, `#!/bin/sh\n: > '${inspectionStarted}'\nsleep 0.2\nexit 1\n`)
  chmodSync(fakeGit, 0o755)
  const previousPath = process.env.PATH
  const runner: Runner = {
    execution: 'local',
    start(_input, emit) {
      process.env.PATH = `${bin}:${previousPath}`
      emit({ kind: 'complete', status: 'succeeded', result: 'result before reset' })
    },
    kill() {},
  }
  try {
    const server = new MockServer({ manual: true, localRunner: runner, localRoot: path })
    for (const trigger of Object.values(server.snapshot().triggers)) server.updateTrigger(trigger.id, { enabled: false })
    const planner = Object.values(server.snapshot().agents).find((agent) => agent.name === 'Planner')!
    server.enqueueTask(planner.id, { title: 'reset race', prompt: 'p', priority: 'normal' })
    server.advance(1)
    await until(() => existsSync(inspectionStarted))
    server.reset()
    await server.close()
    expect(server.snapshot().runs).toEqual({})
    expect(server.snapshot().logs).toEqual([])
  } finally { process.env.PATH = previousPath }
})
