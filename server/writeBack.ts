import type { Artifact, FlowCancel, IntakePhase, IntakeRecord, IssueWrite, LinearSettings, Run, Task, World, WriteStatus } from '../src/domain/types'
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

/**
 * What to do with an issue's flow given the issue's current state in Linear, or null when the issue is gone.
 * Only an open flow reacts, and only to the issue leaving the trigger's pickup and started states.
 */
export function flowAction(issue: IssueState | null, open: boolean, settings: Pick<LinearSettings, 'pickupState' | 'startedState'>): FlowAction {
  if (!open) return { kind: 'none' }
  if (issue && (issue.id === settings.pickupState || issue.id === settings.startedState)) return { kind: 'none' }
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
    if (settings?.startedState && !fromLinear) writes.push({ kind: 'move', step: 'started', stateId: settings.startedState, status: PENDING })
  }
  const outcome = flowOutcome(tasks)
  if (outcome !== null) {
    phase = 'ended'
    const note = (cause: NoteCause): IssueWrite =>
      ({ kind: 'note', outcome: typeof cause === 'string' ? cause : 'cancelled', commentId: newCommentId(), body: noteBody(cause, tasks, world), status: PENDING })
    if (fromLinear) writes.push(note(record.cancel!))
    else if (outcome === 'cancelled') {
      if (settings?.failedState) writes.push({ kind: 'move', step: 'failed', stateId: settings.failedState, status: PENDING })
      writes.push(note(record.cancel ?? { kind: 'factory', task: inFlowOrder(tasks).find((t) => t.status === 'cancelled')?.title ?? 'a task' }))
    } else {
      const stateId = outcome === 'finished' ? settings?.finishedState : settings?.failedState
      if (stateId) writes.push({ kind: 'move', step: outcome, stateId, status: PENDING })
      writes.push(note(outcome))
    }
  }
  return phase === record.phase ? record : { ...record, phase, writes }
}

/**
 * The index of the next write to send, or -1. A write is due when it is pending or failed at least `retryMs` ago.
 * Moves go in order, so a stuck move holds back later moves (a late started move would undo a finished one),
 * but never a note: the note reports the result whatever happened to the issue's state.
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
