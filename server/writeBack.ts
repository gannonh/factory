import type { Artifact, FlowCancel, IntakePhase, IntakeRecord, IssueWrite, LinearSettings, Run, Task, TriggerStates, World, WriteStatus } from '../src/domain/types'
import type { IssueState } from './linear'

type Outcome = 'finished' | 'failed' | 'cancelled'

const PENDING = { state: 'pending' } as const

/** What a note reports: how the flow ended, or why it was cancelled. */
export type NoteCause = 'finished' | 'failed' | FlowCancel

function heading(cause: NoteCause): string {
  if (cause === 'finished') return 'Factory finished this issue.'
  if (cause === 'failed') return 'Factory could not finish this issue.'
  if (cause.kind === 'linear') return `Factory stopped work on this issue: ${cause.reason}.`
  return `Factory stopped work on this issue: “${cause.task}” was cancelled in Factory.`
}

export type FlowAction = { kind: 'none' } | { kind: 'cancel'; reason: string }

/** The state ids a trigger works in. Factory moves an issue only out of these. */
export const workingStates = (states: TriggerStates): string[] => [states.pickupState, ...(states.startedState ? [states.startedState] : [])]

/**
 * What to do with an issue's flow given the issue's current state in Linear, or null when the issue is gone.
 * Only an open flow reacts, and only to the issue leaving the trigger's pickup and started states.
 */
export function flowAction(issue: IssueState | null, open: boolean, states: TriggerStates): FlowAction {
  if (!open) return { kind: 'none' }
  if (issue && workingStates(states).includes(issue.id)) return { kind: 'none' }
  if (!issue || issue.type === 'canceled') return { kind: 'cancel', reason: 'canceled in Linear' }
  return { kind: 'cancel', reason: `moved to ${issue.name} in Linear` }
}

/**
 * Records why the flow was cancelled; the first cause wins. A cancel from Linear drops every move not yet landed,
 * since the person who moved the issue already chose where it sits.
 */
export function cancelRecord(record: IntakeRecord, cancel: FlowCancel): IntakeRecord {
  if (record.cancel !== null || record.phase === 'ended') return record
  const writes = cancel.kind === 'linear'
    ? record.writes.map((w): IssueWrite => (w.kind === 'move' && w.status.state !== 'landed' ? { ...w, status: { state: 'dropped' } } : w))
    : record.writes
  return { ...record, cancel, writes }
}

/** How a flow ended, or null while any task can still run. A task waiting on a retry can still run. */
export function flowOutcome(tasks: readonly Task[]): Outcome | null {
  if (tasks.length === 0 || tasks.some((t) => t.status === 'queued' || t.status === 'waiting' || t.status === 'running')) return null
  if (tasks.some((t) => t.status === 'failed')) return 'failed'
  if (tasks.some((t) => t.status === 'cancelled')) return 'cancelled'
  return 'finished'
}

const inFlowOrder = (tasks: readonly Task[]) =>
  [...tasks].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

function latestRun(task: Task, runs: World['runs']): Run | null {
  return Object.values(runs).filter((r) => r.taskId === task.id).sort((a, b) => b.attempt - a.attempt)[0] ?? null
}

/**
 * The distinct pull requests the flow's succeeded local runs produced, in flow order. Simulated runs only
 * invent demo links, so they never reach Linear as attachments.
 */
function deliveredPullRequests(tasks: readonly Task[], runs: World['runs']): Array<Artifact & { url: string }> {
  const found = new Map<string, Artifact & { url: string }>()
  for (const task of inFlowOrder(tasks)) {
    const run = latestRun(task, runs)
    if (run?.status !== 'succeeded' || run.execution !== 'local' || !run.output) continue
    for (const a of run.output.artifacts) if (a.kind === 'pr' && a.url && !found.has(a.url)) found.set(a.url, { ...a, url: a.url })
  }
  return [...found.values()]
}

const artifactLine = (a: Artifact) => `- ${a.kind}: ${a.url ? `[${a.label}](${a.url})` : a.label}`

function outcomeLines(task: Task, run: Run | null): string[] {
  if (task.status === 'succeeded' && run?.output) return [run.output.summary, ...run.output.artifacts.map(artifactLine)]
  if (task.status === 'failed') return [`Failed: ${run?.error ?? 'no reason recorded'}`]
  return ['Cancelled before it finished.']
}

/** The comment Factory posts when a flow ends: each task in flow order, then a signature naming every run and agent. */
export function noteBody(cause: NoteCause, tasks: readonly Task[], world: Pick<World, 'agents' | 'runs'>): string {
  const runIds: string[] = []
  const agents: string[] = []
  const sections = inFlowOrder(tasks).map((task) => {
    const agent = world.agents[task.agentId]?.name ?? task.agentId
    if (!agents.includes(agent)) agents.push(agent)
    const run = latestRun(task, world.runs)
    if (run) runIds.push(run.id)
    return [run ? `**${agent}** · run ${run.id}` : `**${agent}**`, ...outcomeLines(task, run)].join('\n')
  })
  const signature = `Signed by Factory. Runs: ${runIds.join(', ') || 'none'}. Agents: ${agents.join(', ')}.`
  return [`**${heading(cause)}**`, ...sections, signature].join('\n\n')
}

/** Where an ended flow moves its issue. A cancel from Linear leaves the issue where the person put it. */
function moveFor(cause: NoteCause, settings: LinearSettings | null): { step: 'finished' | 'failed'; stateId: string } | null {
  if (typeof cause !== 'string' && cause.kind === 'linear') return null
  const step = cause === 'finished' ? 'finished' : 'failed'
  const stateId = step === 'finished' ? settings?.finishedState : settings?.failedState
  return stateId ? { step, stateId } : null
}

/**
 * Moves an open record's phase along with its flow's tasks and appends the writes each step makes due,
 * reading the trigger's lifecycle states at that moment. Returns the same record when nothing changed.
 */
export function reconcileRecord(
  record: IntakeRecord,
  tasks: readonly Task[],
  world: Pick<World, 'agents' | 'runs' | 'triggers'>,
  newCommentId: () => string,
): IntakeRecord {
  if (record.phase === 'ended') return record
  const settings = world.triggers[record.trigger]?.linear ?? null
  let phase: IntakePhase = record.phase
  const writes: IssueWrite[] = [...record.writes]
  const fromLinear = record.cancel?.kind === 'linear'
  if (phase === 'taken' && tasks.some((t) => t.attempts > 0)) {
    phase = 'started'
    const startedState = record.states ? record.states.startedState : settings?.startedState
    if (startedState && !fromLinear) writes.push({ kind: 'move', step: 'started', stateId: startedState, status: PENDING })
  }
  const outcome = flowOutcome(tasks)
  if (outcome !== null) {
    phase = 'ended'
    const cause: NoteCause = record.cancel
      ?? (outcome === 'cancelled' ? { kind: 'factory', task: inFlowOrder(tasks).find((t) => t.status === 'cancelled')?.title ?? 'a task' } : outcome)
    const move = moveFor(cause, settings)
    if (move) writes.push({ kind: 'move', ...move, status: PENDING })
    for (const pr of deliveredPullRequests(tasks, world.runs)) {
      if (!writes.some((w) => w.kind === 'attach' && w.url === pr.url)) writes.push({ kind: 'attach', url: pr.url, title: pr.label, status: PENDING })
    }
    writes.push({ kind: 'note', outcome: typeof cause === 'string' ? cause : 'cancelled', commentId: newCommentId(), body: noteBody(cause, tasks, world), status: PENDING })
  }
  return phase === record.phase ? record : { ...record, phase, writes }
}

/**
 * The index of the next write to send, or -1. A write is due when it is pending or failed at least `retryMs` ago.
 * Moves go in order, so a stuck move holds back later moves (a late started move would undo a finished one),
 * but never a note or an attach: those report the result whatever happened to the issue's state.
 */
export function nextWrite(writes: readonly IssueWrite[], now: number, retryMs: number): number {
  let movesOpen = false
  for (let i = 0; i < writes.length; i++) {
    const write = writes[i]
    const { status } = write
    if (status.state === 'landed' || status.state === 'dropped' || (write.kind === 'note' && write.body === null)) continue
    if (write.kind === 'move' && movesOpen) continue
    if (write.kind === 'move') movesOpen = true
    if (status.state === 'pending' || now - status.at >= retryMs) return i
  }
  return -1
}

/** The write with its note text dropped once it has landed: only a pending or failed note is sent again. */
export function landed(write: IssueWrite, status: WriteStatus): IssueWrite {
  return write.kind === 'note' && status.state === 'landed' ? { ...write, body: null, status } : { ...write, status }
}
