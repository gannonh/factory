import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ClaudeRunner, claudeArgs, prepareWorkdir } from '../server/runners'
import type { Runner } from '../server/runners'
import { MockServer } from '../server/simulation'
import type { AgentId, RunId, SandboxId } from '../src/domain/types'

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

test('a repository root gives each run a detached git worktree', async () => {
  const root = temporaryRoot()
  execFileSync('git', ['init', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'README.md'), 'root\n')
  execFileSync('git', ['-C', root, 'add', 'README.md'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'initial'])
  const first = await prepareWorkdir(root, 'run-one' as RunId)
  const second = await prepareWorkdir(root, 'run-two' as RunId)
  expect(readFileSync(join(first, 'README.md'), 'utf8')).toBe('root\n')
  expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe('root\n')
  expect(first).not.toBe(second)
  expect(execFileSync('git', ['-C', first, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()).toBe(first)
  expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
})

test('an empty Git repository uses a plain run directory until it has a HEAD', async () => {
  const root = temporaryRoot()
  execFileSync('git', ['init', root])
  const workdir = await prepareWorkdir(root, 'run-unborn' as RunId)
  expect(existsSync(workdir)).toBe(true)
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
