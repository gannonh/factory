import type { Artifact, IntakePhase, IntakeRecord, IssueWrite, Run, Task, World, WriteStatus } from '../src/domain/types'

type Outcome = 'finished' | 'failed' | 'cancelled'

const PENDING = { state: 'pending' } as const

const HEADING: Record<'finished' | 'failed', string> = {
  finished: 'Factory finished this issue.',
  failed: 'Factory could not finish this issue.',
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
export function noteBody(outcome: 'finished' | 'failed', tasks: readonly Task[], world: Pick<World, 'agents' | 'runs'>): string {
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
  return [`**${HEADING[outcome]}**`, ...sections, signature].join('\n\n')
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
  if (phase === 'taken' && tasks.some((t) => t.attempts > 0)) {
    phase = 'started'
    if (settings?.startedState) writes.push({ kind: 'move', step: 'started', stateId: settings.startedState, status: PENDING })
  }
  const outcome = flowOutcome(tasks)
  if (outcome !== null) {
    phase = 'ended'
    if (outcome !== 'cancelled') {
      const stateId = outcome === 'finished' ? settings?.finishedState : settings?.failedState
      if (stateId) writes.push({ kind: 'move', step: outcome, stateId, status: PENDING })
      for (const pr of deliveredPullRequests(tasks, world.runs)) {
        if (!writes.some((w) => w.kind === 'attach' && w.url === pr.url)) writes.push({ kind: 'attach', url: pr.url, title: pr.label, status: PENDING })
      }
      writes.push({ kind: 'note', outcome, commentId: newCommentId(), body: noteBody(outcome, tasks, world), status: PENDING })
    }
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
    if (status.state === 'landed' || (write.kind === 'note' && write.body === null)) continue
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
