/**
 * Real `server/main.ts` processes (ADR 0009), against real git with a bare `origin`: one killed with SIGKILL during a run,
 * and two sharing a data directory. The agent is a fake `claude` that records its pid and never finishes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { fakeGh } from './fake-gh'
import { git, repository, tempDir, until } from './rework-delivery-fixture'

const ORIGIN = 'http://localhost:5173'
const children: ChildProcess[] = []
const agents: number[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const pid of agents.splice(0)) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
})

function fakeClaude() {
  const bin = join(tempDir(), 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
require('node:fs').writeFileSync('agent.pid', String(process.pid))
require('node:fs').writeFileSync('work-in-progress.txt', 'hours of agent work')
setTimeout(() => {}, 120000)
`)
  chmodSync(join(bin, 'claude'), 0o755)
  return bin
}

/** Boots `server/main.ts` and resolves with its port once it listens. */
function boot(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(out)?.[1]
      if (port) resolve({ child, port: Number(port) })
    })
    child.on('exit', (code) => reject(new Error(`server exited ${code} before it listened`)))
  })
}

async function post(port: number, method: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/command`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) })
  return await response.json() as { ok: boolean; error?: string; world?: { runs: Record<string, { status: string; error: string | null }>; logs: Array<{ level: string; runId?: string; msg: string }> } }
}

const runWorktrees = (root: string) => git(root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ') && line.includes('/.factory-runs/'))
const localBranches = (root: string) => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)

test.each([
  ['without waiting for the world file to record the run', false],
  ['after the world file recorded the run', true],
] as const)('SIGKILL during a run, %s: the next start removes the run’s worktree and branch', async (_when, saved) => {
  const repo = repository()
  const data = tempDir()
  const env = {
    FACTORY_PORT: '0', FACTORY_ORIGIN: ORIGIN, FACTORY_DATA_DIR: data, FACTORY_LOCAL_ROOT: repo.root, LINEAR_API_KEY: '',
    PATH: `${fakeClaude()}:${fakeGh(tempDir()).bin}:${process.env.PATH}`,
  }
  const first = await boot(env)
  // One attempt only, so the restarted server does not retry the interrupted run and make a second worktree under the assertions.
  expect(await post(first.port, 'agents.update', ['ag-coder', { delivery: 'pull-request', retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } }])).toMatchObject({ ok: true })
  expect(await post(first.port, 'agents.enqueue', ['ag-coder', { title: 'Add change', prompt: 'p', priority: 'normal' }])).toMatchObject({ ok: true })
  const runs = join(repo.root, '.factory-runs')
  await until(() => existsSync(runs) && readdirSync(runs).some((name) => existsSync(join(runs, name, 'agent.pid'))), 30_000)
  const id = readdirSync(runs).find((name) => existsSync(join(runs, name, 'agent.pid')))!
  agents.push(Number(readFileSync(join(runs, id, 'agent.pid'), 'utf8')))
  if (saved) await until(() => existsSync(join(data, 'world.json')) && readFileSync(join(data, 'world.json'), 'utf8').includes(`"${id}"`), 30_000)
  expect(runWorktrees(repo.root)).toEqual([`worktree ${join(repo.root, '.factory-runs', id)}`])
  expect(localBranches(repo.root)).toEqual([`factory-${id}`, 'main'])

  first.child.kill('SIGKILL')
  await new Promise((resolve) => first.child.once('exit', resolve))
  expect(runWorktrees(repo.root)).toHaveLength(1)

  const second = await boot(env)
  await until(() => runWorktrees(repo.root).length === 0, 30_000)
  await until(() => !existsSync(join(runs, `${id}.owner`)) && !localBranches(repo.root).includes(`factory-${id}`), 30_000)
  expect(localBranches(repo.root)).toEqual(['main'])
  expect(existsSync(join(runs, id))).toBe(false)
  if (saved) {
    const world = JSON.parse(readFileSync(join(data, 'world.json'), 'utf8')) as { runs: Record<string, { status: string; error: string | null }> }
    await until(() => (JSON.parse(readFileSync(join(data, 'world.json'), 'utf8')) as typeof world).runs[id]?.status === 'failed', 30_000)
    expect(JSON.parse(readFileSync(join(data, 'world.json'), 'utf8')).runs[id]).toMatchObject({ status: 'failed', error: 'interrupted by restart' })
  }
  second.child.kill('SIGKILL')
}, 120_000)

test('a second server on the same data directory and root leaves the first server’s live run alone', async () => {
  const repo = repository()
  const data = tempDir()
  const env = {
    FACTORY_PORT: '0', FACTORY_ORIGIN: ORIGIN, FACTORY_DATA_DIR: data, FACTORY_LOCAL_ROOT: repo.root, LINEAR_API_KEY: '',
    PATH: `${fakeClaude()}:${fakeGh(tempDir()).bin}:${process.env.PATH}`,
  }
  const first = await boot(env)
  expect(await post(first.port, 'agents.update', ['ag-coder', { delivery: 'none', retry: { maxAttempts: 1, backoffMs: 0, backoff: 'fixed' } }])).toMatchObject({ ok: true })
  expect(await post(first.port, 'agents.enqueue', ['ag-coder', { title: 'Add change', prompt: 'p', priority: 'normal' }])).toMatchObject({ ok: true })
  const runs = join(repo.root, '.factory-runs')
  await until(() => existsSync(runs) && readdirSync(runs).some((name) => existsSync(join(runs, name, 'agent.pid'))), 30_000)
  const id = readdirSync(runs).find((name) => existsSync(join(runs, name, 'agent.pid')))!
  const agentPid = Number(readFileSync(join(runs, id, 'agent.pid'), 'utf8'))
  agents.push(agentPid)
  await until(() => existsSync(join(data, 'world.json')) && readFileSync(join(data, 'world.json'), 'utf8').includes(`"${id}"`), 30_000)
  expect(runWorktrees(repo.root)).toEqual([`worktree ${join(runs, id)}`])

  // The second server restores a world that says the run is running, and finds its owner server alive.
  const second = await boot(env)
  let logs: Array<{ level: string; runId?: string; msg: string }> = []
  const deadline = Date.now() + 30_000
  while (!logs.some((line) => line.msg.startsWith('left alone'))) {
    if (Date.now() > deadline) throw new Error(`no warning from the second server; its log: ${JSON.stringify(logs)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    logs = (await post(second.port, 'agents.update', ['ag-coder', {}])).world!.logs
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(first.child.exitCode).toBeNull()
  expect(() => process.kill(agentPid, 0)).not.toThrow()
  expect(runWorktrees(repo.root)).toEqual([`worktree ${join(runs, id)}`])
  expect(readFileSync(join(runs, id, 'work-in-progress.txt'), 'utf8')).toBe('hours of agent work')
  expect(localBranches(repo.root)).toEqual([`factory-${id}`, 'main'])
  expect(existsSync(join(runs, `${id}.owner`))).toBe(true)
  expect(logs.filter((line) => line.level === 'warn' && line.runId === id).map((line) => line.msg)).toEqual([`left alone: the worktree and branch of run ${id} (server process ${first.child.pid}, which made them, is still running)`])
  second.child.kill('SIGKILL')
  first.child.kill('SIGKILL')
}, 120_000)
