import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { MAX_FEEDBACK_CHARS, type Feedback, type PullRequestView } from './rounds'
import { failureReason } from './runners'

const execFileAsync = promisify(execFile)
const GH_TIMEOUT_MS = 30_000
const PR_URL = /^https:\/\/([^/\s]+)\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const login = (item: Json) => (isJson(item.user) && typeof item.user.login === 'string' ? item.user.login : 'unknown')

/** The author associations that GitHub gives only to people with access to the repository (ADR 0012). */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// GitHub sets `performed_via_github_app` on conversation comments only; reviews and inline comments lack the field.
function untrusted(item: Json): string | null {
  const app = item.performed_via_github_app
  if (isJson(app)) return `posted by app ${text(app.name) || text(app.slug) || 'unknown'}`
  if (isJson(item.user) && item.user.type === 'Bot') return 'bot'
  const association = typeof item.author_association === 'string' ? item.author_association : 'missing'
  return TRUSTED.has(association) ? null : `author association ${association}`
}

async function gh(args: string[]): Promise<string> {
  try {
    return (await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (error) {
    throw new Error(`gh ${args[0]} ${args[1]}: ${failureReason(error)}`)
  }
}

/**
 * A body is cut to this many UTF-16 code units as it is read, after its leading whitespace so that a blank-looking start cannot hide later text, well above the prompt's `MAX_FEEDBACK_CHARS` cut, so the
 * prompt still trims each body itself and a history whose bodies fit stays identical (ADR 0012).
 */
const MAX_READ_BODY_CHARS = MAX_FEEDBACK_CHARS * 4

/**
 * Runs `gh` and hands each line of its stdout to `onLine` as it arrives. Unlike `execFile` there is no output buffer to
 * overflow, so the size of a comment history cannot fail the read; a non-zero exit or the timeout still does.
 */
function ghLines(args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let pending = ''
    let timedOut = false
    let broken: unknown = null
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, GH_TIMEOUT_MS)
    const fail = (error: unknown) => {
      clearTimeout(timer)
      reject(new Error(`gh ${args[0]} ${args[1]}: ${failureReason(error)}`))
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const parts = (pending + chunk).split('\n')
      pending = parts.pop() ?? ''
      try {
        parts.forEach(onLine)
      } catch (error) {
        broken = error
        child.kill()
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
    child.on('error', fail)
    child.on('close', (code) => {
      if (broken === null && code !== 0) return fail({ stderr, killed: timedOut })
      clearTimeout(timer)
      try {
        if (broken !== null) throw broken
        if (pending !== '') onLine(pending)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * Every item of a paginated GitHub list, one compact JSON document per line through `--jq`. Each line is parsed as it
 * arrives and its body cut, so memory holds trimmed items however large the history is.
 */
async function list(host: string, path: string): Promise<Json[]> {
  const items: Json[] = []
  await ghLines(['api', '--hostname', host, '--paginate', '--jq', '.[] | @json', `${path}?per_page=100`], (line) => {
    if (line.trim() === '') return
    const item = JSON.parse(line) as unknown
    if (!isJson(item)) return
    items.push(typeof item.body === 'string' && item.body.length > MAX_READ_BODY_CHARS ? { ...item, body: item.body.trimStart().slice(0, MAX_READ_BODY_CHARS) } : item)
  })
  return items
}

/**
 * Control, format, line separator, paragraph separator and default-ignorable characters, except the zero-width joiner and
 * variation selector 16 that emoji use. Git accepts all of them except the ASCII controls, so a pull request can carry them in its branch name. Refusing them stops bidi overrides,
 * which make a name read in a different order from the branch Factory pushes to, tag characters, which spell text a model
 * reads, and the invisible characters that carry bytes or take up no room: variation selectors other than 16, Hangul
 * fillers such as U+3164 and the combining grapheme joiner (U+034F). Flag emoji built from tag characters are refused
 * too. A lone zero-width joiner and the Braille blank (U+2800) still pass (ADR 0012).
 */
const UNSAFE_CHARS = /(?![\u200D\uFE0F])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu

export async function viewPullRequest(url: string): Promise<PullRequestView> {
  if (!PR_URL.test(url)) throw new Error(`not a pull request URL: ${url}`)
  const view: unknown = JSON.parse(await gh(['pr', 'view', url, '--json', 'state,headRefName,baseRefName']))
  if (!isJson(view) || (view.state !== 'OPEN' && view.state !== 'MERGED' && view.state !== 'CLOSED') || typeof view.headRefName !== 'string' || typeof view.baseRefName !== 'string') {
    throw new Error(`gh pr view: unexpected answer for ${url}`)
  }
  if (view.state !== 'OPEN') return { state: view.state }
  for (const [which, name] of [['head', view.headRefName], ['base', view.baseRefName]]) {
    const escaped = name.replace(UNSAFE_CHARS, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)
    if (escaped !== name) throw new Error(`gh pr view: the pull request's ${which} branch has a control, format or line break character: ${escaped}`)
  }
  return { state: 'OPEN', head: view.headRefName, base: view.baseRefName }
}

/**
 * The only code that reads GitHub for rework rounds (ADR 0012): a delivered pull request's state and head branch, and its
 * review feedback. Review summaries, inline comments and conversation comments all count; empty review bodies do not.
 */
export async function readPullRequest(url: string): Promise<{ view: PullRequestView; feedback: Feedback[] }> {
  const match = PR_URL.exec(url)
  if (!match) throw new Error(`not a pull request URL: ${url}`)
  const [, host, owner, repo, number] = match
  const view = await viewPullRequest(url)
  const base = `repos/${owner}/${repo}`
  const [reviews, inline, conversation] = await Promise.all([
    list(host, `${base}/pulls/${number}/reviews`),
    list(host, `${base}/pulls/${number}/comments`),
    list(host, `${base}/issues/${number}/comments`),
  ])
  const at = (value: unknown) => Date.parse(text(value))
  const feedback: Feedback[] = [
    ...reviews.map((r): Feedback => ({ author: login(r), body: text(r.body), at: at(r.submitted_at), kind: 'review', place: null, untrusted: untrusted(r) })),
    ...inline.map((c): Feedback => {
      const line = typeof c.line === 'number' ? c.line : typeof c.original_line === 'number' ? c.original_line : null
      const place = typeof c.path === 'string' ? `${c.path}${line === null ? '' : `:${line}`}` : null
      return { author: login(c), body: text(c.body), at: at(c.created_at), kind: 'inline', place, untrusted: untrusted(c) }
    }),
    ...conversation.map((c): Feedback => ({ author: login(c), body: text(c.body), at: at(c.created_at), kind: 'comment', place: null, untrusted: untrusted(c) })),
  ]
  return { view, feedback }
}
