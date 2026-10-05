/**
 * A fake `gh` for the delivery and rework suites, put first on PATH. It keeps one pull request per head branch, as
 * GitHub does, and records each call after it reads the pull requests and feedback, so a call in `calls()` has read
 * them. `pr view <branch|url>` prints that PR as JSON or fails; `pr create` opens pull
 * request 41, 42, … in order. `api` answers a PR's reviews, inline comments and conversation comments one JSON
 * document per line, as `--jq '.[] | @json'` prints them. Each carries the author's `author_association` unless it is
 * null, and a login ending in `[bot]` is a bot account. A conversation comment carries `performed_via_github_app`, as
 * GitHub's does, and reviews and inline comments do not. `failNext` makes the next `pr create` or `pr view` fail, and
 * `holdView` makes every `pr view`, or every one of a branch, wait until `releaseView`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type GhCall = { cwd: string; argv: string[] }
export type FakePr = { url: string; number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; baseRefName: string; headRefName: string }
type Feedback = { reviews: unknown[]; pulls: unknown[]; issues: unknown[] }
export type Association = 'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'FIRST_TIME_CONTRIBUTOR' | 'FIRST_TIMER' | 'NONE'
const user = (login: string) => ({ login, type: login.endsWith('[bot]') ? 'Bot' : 'User' })
const by = (login: string, association: Association | null) => ({ user: user(login), ...(association === null ? {} : { author_association: association }) })

export function fakeGh(dir = mkdtempSync(join(tmpdir(), 'factory-gh-'))) {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'gh.log')
  const prsFile = join(dir, 'prs.json')
  const feedbackFile = join(dir, 'feedback.json')
  const fail = (op: string) => join(dir, `fail-${op}`)
  const holdFile = (state: FakePr['state'], head: string, base: string) => join(dir, `hold-${state}-${encodeURIComponent(head)}-${encodeURIComponent(base)}`)
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
const prs = read(${JSON.stringify(prsFile)})
const allFeedback = read(${JSON.stringify(feedbackFile)})
// Logged only once the state is read, so a test that sees the call can change the state without racing the read.
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), argv }) + '\\n')
const failing = (op) => {
  const marker = ${JSON.stringify(dir)} + '/fail-' + op
  if (!fs.existsSync(marker)) return false
  fs.rmSync(marker)
  return true
}
if (argv[0] === 'api') {
  const path = argv.find((a) => a.startsWith('repos/')).split('?')[0]
  const [, , , kind, number, list] = path.split('/')
  const feedback = allFeedback[number] || { reviews: [], pulls: [], issues: [] }
  const items = list === 'reviews' ? feedback.reviews : kind === 'pulls' ? feedback.pulls : feedback.issues
  if (failing('api')) { console.error('gh: HTTP 502: Server Error (GET ' + path + ')'); process.exit(1) }
  // Exits only once stdout drains: process.exit cuts a pipe's pending output, which a history over 16 MB would lose.
  process.stdout.write(items.map((item) => JSON.stringify(item) + '\\n').join(''), () => process.exit(0))
  return
}
if (argv[1] === 'view') {
  const held = () => {
    try {
      const only = fs.readFileSync(${JSON.stringify(dir)} + '/hold-view', 'utf8')
      return only === '' || only === argv[2]
    } catch {
      return false
    }
  }
  while (held()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  const pr = prs[argv[2]] || Object.values(prs).find((p) => p.url === argv[2])
  while (pr && fs.existsSync(${JSON.stringify(dir)} + '/hold-' + pr.state + '-' + encodeURIComponent(pr.headRefName) + '-' + encodeURIComponent(pr.baseRefName))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
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
if (failing('workdir')) fs.rmSync(process.cwd(), { recursive: true, force: true })
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
  /** Appends many items at once, for a flood too large to add one write at a time. */
  const addFeedbackMany = (number: number, list: keyof Feedback, items: unknown[]) => {
    const all = feedback()
    const entry = all[number] ?? { reviews: [], pulls: [], issues: [] }
    entry[list].push(...items)
    writeFileSync(feedbackFile, JSON.stringify({ ...all, [number]: entry }))
  }
  return {
    bin,
    calls,
    prs,
    creates: () => calls().filter((c) => c.argv[1] === 'create'),
    failNext: (op: 'create' | 'view' | 'api' = 'create') => writeFileSync(fail(op), ''),
    /** The next `pr create` opens its pull request, then deletes the working directory it ran in. */
    removeWorkdirOnCreate: () => writeFileSync(fail('workdir'), ''),
    /** Every later `pr view`, or only those of `branch`, waits until `releaseView`. */
    holdView: (branch = '') => writeFileSync(join(dir, 'hold-view'), branch),
    releaseView: () => rmSync(join(dir, 'hold-view'), { force: true }),
    /** Holds each `pr view` that reads the PR on `head` into `base` in `state`, as that `gh` read it before it logged the call, until `releaseState`. */
    holdState: (state: FakePr['state'], head: string, base = 'main') => writeFileSync(holdFile(state, head, base), ''),
    releaseState: (state: FakePr['state'], head: string, base = 'main') => rmSync(holdFile(state, head, base), { force: true }),
    openPullRequest: (branch: string, url: string, baseRefName = 'main') =>
      writeFileSync(prsFile, JSON.stringify({ [branch]: { url, number: Number(url.split('/').at(-1)), state: 'OPEN', baseRefName, headRefName: branch } })),
    setState: (branch: string, state: FakePr['state']) => {
      const all = prs()
      writeFileSync(prsFile, JSON.stringify({ ...all, [branch]: { ...all[branch], state } }))
    },
    /** A review summary; `at` is its ISO submission time. */
    review: (number: number, login: string, body: string, at: string, association: Association | null = 'COLLABORATOR') =>
      addFeedback(number, 'reviews', { ...by(login, association), body, submitted_at: at, state: 'COMMENTED' }),
    inline: (number: number, login: string, body: string, path: string, line: number, at: string, association: Association | null = 'COLLABORATOR') =>
      addFeedback(number, 'pulls', { ...by(login, association), body, path, line, created_at: at }),
    /** `app` is the GitHub App that posted the comment for `login`, or null when the person posted it. */
    conversation: (number: number, login: string, body: string, at: string, association: Association | null = 'COLLABORATOR', app: string | null = null) =>
      addFeedback(number, 'issues', { ...by(login, association), body, created_at: at, performed_via_github_app: app === null ? null : { name: app, slug: app } }),
    /** Appends many items at once; the item is a raw API document as `conversation`, `review` and `inline` write. */
    addFeedbackMany,
  }
}
