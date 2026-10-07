/**
 * Two Factory servers on one repository (ADR 0009). Each server is its own copy of `server/runners`, so each has its own
 * in-process state, as two node processes do. Both prepare runs against one sandbox root and one real bare `origin`.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { RunId } from '../src/domain/types'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const BRANCHES = 20

function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-two-servers-'))
  dirs.push(dir)
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  const seed = join(dir, 'seed')
  git(dir, 'clone', '--quiet', origin, seed)
  git(seed, 'config', 'user.email', 't@example.com')
  git(seed, 'config', 'user.name', 'T')
  writeFileSync(join(seed, 'base.txt'), 'base\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', 'base')
  git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
  for (let n = 0; n < BRANCHES; n++) git(seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/feature-${n}`)
  const root = join(dir, 'root')
  git(dir, 'clone', '--quiet', origin, root)
  return { root }
}

async function server() {
  vi.resetModules()
  return import('../server/runners')
}

const pr = { kind: 'pr' as const, label: 'Pull request #41', url: 'https://github.com/example/factory/pull/41' }
const privateRefs = (root: string) => git(root, 'for-each-ref', '--format=%(refname)', 'refs/factory/').split('\n').filter(Boolean)

// 200 real fetches and worktree adds in one repository take several seconds on a loaded machine. The full parallel suite
// runs this file beside others, so the limit leaves room for that load rather than for the work itself.
test('two servers preparing 100 continue runs each on 20 branches fail none and leave no private refs', { timeout: 120_000 }, async () => {
  const a = await server()
  const b = await server()
  expect(a.prepareWorkdir).not.toBe(b.prepareWorkdir)
  const { root } = repository()
  const prepare = (s: typeof a, name: string, n: number) =>
    s.prepareWorkdir(root, `${name}-${n}` as RunId, { kind: 'continue', pr, branch: `feature-${n % BRANCHES}`, base: 'main' })
      .then(() => null, (error: unknown) => String(error))
  const results = await Promise.all([
    ...Array.from({ length: 100 }, (_, n) => prepare(a, 'a', n)),
    ...Array.from({ length: 100 }, (_, n) => prepare(b, 'b', n)),
  ])
  expect(results.filter((result) => result !== null)).toEqual([])
  expect(privateRefs(root)).toEqual([])
})

test('a stale lock on one private ref does not keep the other stale refs from being deleted', async () => {
  const s = await server()
  const { root } = repository()
  const tip = git(root, 'rev-parse', 'HEAD')
  for (const n of [0, 1, 2]) git(root, 'update-ref', `refs/factory/crashed/${n}`, tip)
  git(root, 'update-ref', 'refs/factory/other/0', tip)
  writeFileSync(join(root, '.git', 'refs', 'factory', 'crashed', '0.lock'), '')
  await s.prepareWorkdir(root, 'fresh' as RunId, { kind: 'continue', pr, branch: 'feature-0', base: 'main' })
  expect(privateRefs(root)).toEqual(['refs/factory/crashed/0'])
  expect(existsSync(join(root, '.git', 'refs', 'factory', 'crashed', '0.lock'))).toBe(true)
})

test('a second server\'s cleanup between the first one\'s fetch and its read does not fail the first', async () => {
  const a = await server()
  const b = await server()
  const { root } = repository()
  const hook = join(root, '.git', 'hooks', 'reference-transaction')
  writeFileSync(hook, '#!/bin/sh\n[ "$1" = committed ] && grep -q " refs/factory/slow-run/" && sleep 1\nexit 0\n')
  chmodSync(hook, 0o755)
  const slow = a.prepareWorkdir(root, 'slow-run' as RunId, { kind: 'continue', pr, branch: 'feature-0', base: 'main' }).then(() => 'prepared', (error: unknown) => String(error))
  await new Promise((resolve) => setTimeout(resolve, 400))
  await b.prepareWorkdir(root, 'other-run' as RunId, { kind: 'continue', pr, branch: 'feature-1', base: 'main' })
  expect(await slow).toBe('prepared')
  expect(privateRefs(root)).toEqual([])
})

test('packed stale refs are all deleted', async () => {
  const s = await server()
  const { root } = repository()
  const tip = git(root, 'rev-parse', 'HEAD')
  for (let n = 0; n < 12; n++) git(root, 'update-ref', `refs/factory/crashed/${n}`, tip)
  git(root, 'pack-refs', '--all')
  await s.prepareWorkdir(root, 'fresh' as RunId, { kind: 'continue', pr, branch: 'feature-0', base: 'main' })
  expect(privateRefs(root)).toEqual([])
})

test('a run whose private ref already holds origin\'s tip and could not be deleted still gets its tip', async () => {
  const s = await server()
  const { root } = repository()
  const tip = git(root, 'rev-parse', 'HEAD')
  git(root, 'update-ref', 'refs/factory/fresh/0', tip)
  writeFileSync(join(root, '.git', 'refs', 'factory', 'fresh', '0.lock'), '')
  const prepared = await s.prepareWorkdir(root, 'fresh' as RunId, { kind: 'continue', pr, branch: 'feature-0', base: 'main' })
  expect(prepared.initialHead).toBe(tip)
})
