import type {
  FlowId, IntakeRecord, IssueBlocker, IssueRef, PullRequestRef, Rework, RoundResult, TaskInput, TriggerId, TriggerStates,
} from '../src/domain/types'
import { dropPendingMoves } from './writeBack'

/** A comment a round's prompt quotes. `at` is wall-clock ms. `place` is a file and line for an inline review comment. */
export type Feedback = { author: string; body: string; at: number; kind: 'review' | 'inline' | 'comment'; place: string | null }

/** What a poll gathers before it starts a round after the first: how the work continues and the feedback since the last round. */
export type RoundContext = { rework: Rework | null; review: Feedback[]; linear: Feedback[] }

/** A pull request's state as `gh pr view` reports it. */
export type PullRequestView = { state: 'OPEN' | 'MERGED' | 'CLOSED'; head: string; base: string }

export const MAX_FEEDBACK = 50
export const MAX_FEEDBACK_CHARS = 2000

/**
 * Whether an issue listed in a trigger's pickup state starts a new round. Its last round must have ended, and the issue
 * must have left that round's pickup state since, or be entering a different trigger's pickup state. An issue that never
 * left, such as one that failed with no failed state set, does not loop.
 */
export function reworkable(record: IntakeRecord, pickupState: string): boolean {
  return record.phase === 'ended' && (record.left || (record.states?.pickupState ?? pickupState) !== pickupState)
}

/** The ended rounds' results, newest first. */
const results = (record: IntakeRecord): RoundResult[] =>
  [record.result, ...record.past.map((p) => p.result).reverse()].filter((r) => r !== null)

/**
 * The newest pull request any round delivered. A record saved before rounds has no results, so its pull request is the
 * newest one its attach writes name.
 */
export function latestPullRequest(record: IntakeRecord): PullRequestRef | null {
  const delivered = results(record).find((r) => r.pr)?.pr
  if (delivered) return delivered
  const attach = record.writes.findLast((w) => w.kind === 'attach')
  return attach ? { kind: 'pr', label: attach.title, url: attach.url } : null
}

/** The newest succeeded output of any round: the next round's task input. */
export const latestOutput = (record: IntakeRecord): TaskInput | null => results(record).find((r) => r.output)?.output ?? null

export const prNumber = (pr: PullRequestRef): string => /\/pull\/(\d+)$/.exec(pr.url)?.[1] ?? pr.label

export function reworkOf(pr: PullRequestRef, view: PullRequestView): Rework {
  if (view.state === 'OPEN') return { kind: 'continue', pr, branch: view.head, base: view.base }
  return { kind: 'fresh', pr, state: view.state === 'MERGED' ? 'merged' : 'closed' }
}

export type RoundStart = {
  trigger: TriggerId; flowId: FlowId; takenAt: number; states: TriggerStates; blockers: IssueBlocker[]; rework: Rework | null
}

/**
 * The record for the issue's next round: round 1 for a new issue, otherwise the ended round moves to `past`.
 * Moves that have not landed are dropped, since the person who moved the issue back already chose where it sits.
 */
export function startRound(record: IntakeRecord | undefined, issue: IssueRef, start: RoundStart): IntakeRecord {
  const fresh = { ...start, phase: 'taken', cancel: null, result: null, left: false } as const
  if (!record) return { issue, ...fresh, writes: [], round: 1, rework: null, past: [] }
  const { round, trigger, flowId, takenAt, result } = record
  return { ...record, ...fresh, issue, writes: dropPendingMoves(record.writes), round: round + 1, past: [...record.past, { round, trigger, flowId, takenAt, result }] }
}

/**
 * The issue's comments since Factory's latest note on it, or since the ended round's start when no note is on the issue.
 * Factory's own notes never count.
 */
export function linearFeedback(record: IntakeRecord, comments: ReadonlyArray<{ id: string; body: string; createdAt: string; author: string | null }>): Feedback[] {
  const notes = new Set(record.writes.flatMap((w) => (w.kind === 'note' ? [w.commentId] : [])))
  const noteTimes = comments.filter((c) => notes.has(c.id)).map((c) => Date.parse(c.createdAt)).filter(Number.isFinite)
  const since = noteTimes.length > 0 ? Math.max(...noteTimes) : record.takenAt
  const feedback = comments
    .filter((c) => !notes.has(c.id))
    .map((c): Feedback => ({ author: c.author ?? 'unknown', body: c.body, at: Date.parse(c.createdAt), kind: 'comment', place: null }))
  return recent(feedback, since)
}

/** The newest MAX_FEEDBACK entries after `since`, oldest first, each body cut to MAX_FEEDBACK_CHARS. */
export function recent(feedback: readonly Feedback[], since: number): Feedback[] {
  return feedback
    .filter((f) => f.at > since && f.body.trim() !== '')
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_FEEDBACK)
    .map((f) => (Array.from(f.body).length > MAX_FEEDBACK_CHARS ? { ...f, body: `${Array.from(f.body).slice(0, MAX_FEEDBACK_CHARS - 1).join('')}…` } : f))
}

export const roundTitle = (identifier: string, title: string, round: number) => `${identifier} ${title}${round > 1 ? ` (round ${round})` : ''}`

const ENDED: Record<RoundResult['outcome'], string> = { finished: 'finished', failed: 'failed', cancelled: 'was cancelled' }

export function reworkLine(rework: Rework | null, previous: RoundResult | null): string {
  if (!rework) return `The previous round ${previous ? ENDED[previous.outcome] : 'ended'} without a pull request, so this round starts fresh.`
  const pr = `#${prNumber(rework.pr)} (${rework.pr.url})`
  if (rework.kind === 'continue') {
    return `Continue on pull request ${pr}. Commit your changes on top of the current HEAD and do not rebase, amend or push; Factory pushes them to the pull request's branch \`${rework.branch}\`.`
  }
  return `Pull request ${pr} was ${rework.state}, so this round starts a fresh branch and opens a new pull request.`
}

function feedbackLine(f: Feedback): string {
  const where = f.kind === 'inline' && f.place ? ` on \`${f.place}\`` : f.kind === 'review' ? ' (review)' : ''
  return `- **${f.author}**${where}: ${f.body.trim().replace(/\r?\n/g, '\n  ')}`
}

/** The task prompt: the issue, then for a round after the first how it continues and the feedback since the last round. */
export function roundPrompt(issue: { title: string; description: string; url: string }, round: number, context: RoundContext | null, previous: RoundResult | null): string {
  const parts = [issue.title, issue.description, issue.url]
  if (round > 1 && context) {
    parts.push(`## Rework round ${round}`, reworkLine(context.rework, previous))
    if (context.review.length > 0) parts.push(['### Review comments on the pull request', ...context.review.map(feedbackLine)].join('\n'))
    if (context.linear.length > 0) parts.push(['### Linear comments since the last round', ...context.linear.map(feedbackLine)].join('\n'))
  }
  return parts.filter((part) => part !== '').join('\n\n')
}
