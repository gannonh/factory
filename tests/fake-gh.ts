/**
 * A fake `gh` for the delivery and rework suites, put first on PATH. It keeps one pull request per head branch, as
 * GitHub does, and records each call. `pr view <branch|url>` prints that PR as JSON or fails; `pr create` opens pull
 * request 41, 42, … in order. `api` answers a PR's reviews, inline comments and conversation comments one JSON
 * document per line, as `--jq '.[] | @json'` prints them. `failNext` makes the next `pr create` or `pr view` fail.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type GhCall = { cwd: string; argv: string[] }
export type FakePr = { url: string; number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; baseRefName: string; headRefName: string }
type Feedback = { reviews: unknown[]; pulls: unknown[]; issues: unknown[] }

export function fakeGh(dir = mkdtempSync(join(tmpdir(), 'factory-gh-'))) {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'gh.log')
  const prsFile = join(dir, 'prs.json')
  const feedbackFile = join(dir, 'feedback.json')
  const fail = (op: string) => join(dir, `fail-${op}`)
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), argv }) + '\\n')
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
const prs = read(${JSON.stringify(prsFile)})
const failing = (op) => {
  const marker = ${JSON.stringify(dir)} + '/fail-' + op
  if (!fs.existsSync(marker)) return false
  fs.rmSync(marker)
  return true
}
if (argv[0] === 'api') {
  const path = argv.find((a) => a.startsWith('repos/')).split('?')[0]
  const [, , , kind, number, list] = path.split('/')
  const feedback = read(${JSON.stringify(feedbackFile)})[number] || { reviews: [], pulls: [], issues: [] }
  const items = list === 'reviews' ? feedback.reviews : kind === 'pulls' ? feedback.pulls : feedback.issues
  for (const item of items) console.log(JSON.stringify(item))
  process.exit(0)
}
if (argv[1] === 'view') {
  const pr = prs[argv[2]] || Object.values(prs).find((p) => p.url === argv[2])
  if (failing('view') || !pr) { console.error('no pull requests found for "' + argv[2] + '"'); process.exit(1) }
  console.log(JSON.stringify(pr))
  process.exit(0)
}
if (failing('create')) {
  console.error('GraphQL: was submitted too quickly (createPullRequest)')
  process.exit(1)
}
const number = 41 + Object.keys(prs).length
const head = argv[argv.indexOf('--head') + 1]
const url = 'https://github.com/example/factory/pull/' + number
prs[head] = { url, number, state: 'OPEN', baseRefName: argv[argv.indexOf('--base') + 1], headRefName: head }
fs.writeFileSync(${JSON.stringify(prsFile)}, JSON.stringify(prs))
console.log(url)
`)
  chmodSync(join(bin, 'gh'), 0o755)
  const calls = (): GhCall[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as GhCall) : []
  const prs = (): Record<string, FakePr> => existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) as Record<string, FakePr> : {}
  const feedback = (): Record<string, Feedback> => existsSync(feedbackFile) ? JSON.parse(readFileSync(feedbackFile, 'utf8')) as Record<string, Feedback> : {}
  const addFeedback = (number: number, list: keyof Feedback, item: unknown) => {
    const all = feedback()
    const entry = all[number] ?? { reviews: [], pulls: [], issues: [] }
    entry[list].push(item)
    writeFileSync(feedbackFile, JSON.stringify({ ...all, [number]: entry }))
  }
  return {
    bin,
    calls,
    prs,
    creates: () => calls().filter((c) => c.argv[1] === 'create'),
    failNext: (op: 'create' | 'view' = 'create') => writeFileSync(fail(op), ''),
    openPullRequest: (branch: string, url: string, baseRefName = 'main') =>
      writeFileSync(prsFile, JSON.stringify({ [branch]: { url, number: Number(url.split('/').at(-1)), state: 'OPEN', baseRefName, headRefName: branch } })),
    setState: (branch: string, state: FakePr['state']) => {
      const all = prs()
      writeFileSync(prsFile, JSON.stringify({ ...all, [branch]: { ...all[branch], state } }))
    },
    /** A review summary; `at` is its ISO submission time. */
    review: (number: number, login: string, body: string, at: string) => addFeedback(number, 'reviews', { user: { login }, body, submitted_at: at, state: 'COMMENTED' }),
    inline: (number: number, login: string, body: string, path: string, line: number, at: string) =>
      addFeedback(number, 'pulls', { user: { login }, body, path, line, created_at: at }),
    conversation: (number: number, login: string, body: string, at: string) => addFeedback(number, 'issues', { user: { login }, body, created_at: at }),
  }
}
