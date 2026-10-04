import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Feedback, PullRequestView } from './rounds'
import { failureReason } from './runners'

const execFileAsync = promisify(execFile)
const GH_TIMEOUT_MS = 30_000
const PR_URL = /^https:\/\/([^/\s]+)\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const login = (item: Json) => (isJson(item.user) && typeof item.user.login === 'string' ? item.user.login : 'unknown')

async function gh(args: string[]): Promise<string> {
  try {
    return (await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (error) {
    throw new Error(`gh ${args[0]} ${args[1]}: ${failureReason(error)}`)
  }
}

/** Every item of a paginated GitHub list, one compact JSON document per line through `--jq`. */
async function list(host: string, path: string): Promise<Json[]> {
  const out = await gh(['api', '--hostname', host, '--paginate', '--jq', '.[] | @json', `${path}?per_page=100`])
  return out.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as unknown).filter(isJson)
}

export async function viewPullRequest(url: string): Promise<PullRequestView> {
  if (!PR_URL.test(url)) throw new Error(`not a pull request URL: ${url}`)
  const view: unknown = JSON.parse(await gh(['pr', 'view', url, '--json', 'state,headRefName,baseRefName']))
  if (!isJson(view) || (view.state !== 'OPEN' && view.state !== 'MERGED' && view.state !== 'CLOSED') || typeof view.headRefName !== 'string' || typeof view.baseRefName !== 'string') {
    throw new Error(`gh pr view: unexpected answer for ${url}`)
  }
  return { state: view.state, head: view.headRefName, base: view.baseRefName }
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
    ...reviews.map((r): Feedback => ({ author: login(r), body: text(r.body), at: at(r.submitted_at), kind: 'review', place: null })),
    ...inline.map((c): Feedback => {
      const line = typeof c.line === 'number' ? c.line : typeof c.original_line === 'number' ? c.original_line : null
      return { author: login(c), body: text(c.body), at: at(c.created_at), kind: 'inline', place: typeof c.path === 'string' ? `${c.path}${line === null ? '' : `:${line}`}` : null }
    }),
    ...conversation.map((c): Feedback => ({ author: login(c), body: text(c.body), at: at(c.created_at), kind: 'comment', place: null })),
  ]
  return { view, feedback }
}
