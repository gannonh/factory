import { seedWorld } from '../src/domain/seed'
import {
  EDGE_RULES,
  LINEAR_POLL_MS,
  SANDBOX_TIMED,
  SANDBOX_TRANSITIONS,
  attachedEdges,
  blockedReason,
  edgeKindFor,
  isCapacity,
  issueOfFlow,
  nodeKindOf,
  nodeRef,
  nodeSubject,
  type Agent,
  type Artifact,
  type AgentId,
  type AgentPatch,
  type Edge,
  type EdgeId,
  type EdgeKind,
  type FactoryEvent,
  type FlowId,
  type GraphFragment,
  type Group,
  type GroupId,
  type IntakeError,
  type IntakePreview,
  type IntakeRecord,
  type IssueFilter,
  type IssueId,
  type LinearCatalog,
  type LinearSettings,
  type LogLevel,
  type NodeId,
  type NodeKind,
  type NodeRef,
  type Position,
  type Priority,
  type Run,
  type RunId,
  type RunOutput,
  type Sandbox,
  type SandboxAction,
  type SandboxId,
  type SandboxKind,
  type Subject,
  type Task,
  type TaskId,
  type Trigger,
  type TriggerId,
  type TriggerKind,
  type World,
  type WriteStatus,
} from '../src/domain/types'
import type { WorldStore } from './worldFile'
import { ClaudeRunner, SimulatedRunner, deliver, gitArtifacts, prepareWorkdir, reconcileWorkdirs, removeWorkdir, type Delivery, type DeliveryRequest, type PreparedWorkdir, type Runner, type RunnerEvent } from './runners'
import type { RunLogStore } from './runLogs'
import { array, boolean, defaulted, id, number, object, oneOf, record } from './parse'
import { agent, edge, event, group, intakeRecord, run, sandbox, task, trigger } from './records'
import { LINEAR_URL, createLinearClient, intakeErrorOf, type IssueState, type IssueStatus, type LinearClient, type LinearIssue } from './linear'
import { cancelRecord, flowAction, flowOutcome, landed, nextWrite, reconcileRecord, workingStates } from './writeBack'
import { feedbackBlock, latestOutput, latestPullRequest, linearFeedback, outputText, prNumber, rereadRework, reworkOf, reworkable, roundPrompt, roundTitle, runPrompt, screen, startRound, type RoundContext, type Screened } from './rounds'
import { readPullRequest, viewPullRequest } from './github'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

const TICK_MS = 400
const MAX_LOGS = 2000
const MAX_EVENTS = 400
const MAX_COMPLETED_RUNS = 200
const MAX_REAL_MESSAGE_CHARS = 8192
const RESULT_TRUNCATED = '\n… [result truncated]'
const LOG_TRUNCATED = '\n… [log truncated]'
const ERROR_TRUNCATED = '\n… [error truncated]'
const SAVE_MS = 1000
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 }
const ID_PREFIX: Record<NodeKind, string> = { agent: 'ag', sandbox: 'sb', trigger: 'tr' }
const FIRES_ON_INTERVAL: Record<TriggerKind, boolean> = { cron: true, webhook: true, event: true, manual: false, linear: false }
const PREVIEW_ISSUES = 5
const ONE_AGENT = 'A Linear trigger feeds one agent. Join more agents with a handoff edge.'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** What may join two nodes, or null when either endpoint is gone. */
function connectable(world: World, source: NodeId, target: NodeId): { from: NodeKind; to: NodeKind; kinds: EdgeKind[] } | null {
  const from = nodeKindOf(world, source)
  const to = nodeKindOf(world, target)
  return from && to ? { from, to, kinds: edgeKindFor(from, to) } : null
}

/** Whether an edge with these endpoints and kind already exists, ignoring `exceptId`. */
function edgeExists(world: World, source: NodeId, target: NodeId, kind: EdgeKind, exceptId?: EdgeId): boolean {
  return Object.values(world.edges).some((e) => e.id !== exceptId && e.source === source && e.target === target && e.kind === kind)
}

function fanOutRefusal(world: World, source: NodeId, kind: EdgeKind): string | null {
  if (kind !== 'triggers' || world.triggers[source as TriggerId]?.kind !== 'linear') return null
  return Object.values(world.edges).some((e) => e.kind === 'triggers' && e.source === source) ? ONE_AGENT : null
}

const sameSettings = (a: LinearSettings | null, b: LinearSettings | null) =>
  a?.team === b?.team && a?.project === b?.project && a?.pickupState === b?.pickupState

/** Whether the record is still on the ended round a poll saw when it began. */
const sameRound = (record: IntakeRecord | undefined, before: IntakeRecord | undefined): record is IntakeRecord =>
  !!record && !!before && record.round === before.round && record.phase === 'ended'

type Pollable = Trigger & { kind: 'linear'; linear: LinearSettings }

type RunCompletion =
  | { status: 'succeeded'; agent: Pick<Agent, 'role' | 'tools'>; output?: RunOutput }
  | { status: 'failed'; reason: string; retryable?: boolean }
  | { status: 'cancelled'; reason: string }

function createRunOutput(run: Pick<Run, 'id' | 'title'>, agent: Pick<Agent, 'role' | 'tools'>): RunOutput {
  const summary = `The ${agent.role} completed "${run.title}".`
  if (!agent.tools.includes('gh') && !agent.tools.includes('git_diff')) {
    return { summary, artifacts: [{ kind: 'note', label: `Completion note for ${run.title}`, url: null }] }
  }

  const branch = `run/${run.id.slice(-6)}`
  const pullRequest = Number.parseInt(run.id.slice(-6), 36) % 10_000 + 1
  const repository = 'https://github.com/factory-demo/factory'
  return {
    summary,
    artifacts: [
      { kind: 'branch', label: branch, url: `${repository}/tree/${encodeURIComponent(branch)}` },
      { kind: 'pr', label: `Pull request #${pullRequest}`, url: `${repository}/pull/${pullRequest}` },
    ],
  }
}

function boundedRunText(value: string, marker: string): string {
  if (value.length <= MAX_REAL_MESSAGE_CHARS) return value
  let end = MAX_REAL_MESSAGE_CHARS - marker.length
  const last = value.charCodeAt(end - 1)
  const next = value.charCodeAt(end)
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
  return value.slice(0, end) + marker
}

type Listener = (world: World) => void

/** The run stopped, or the server closed, while the run read its pull request. Restart settles a run left running. */
class RunEnded extends Error {
  constructor() { super('run ended while its pull request was read') }
}

export class MockServer {
  private world: World
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private localTimeouts = new Map<RunId, ReturnType<typeof setTimeout>>()
  private store: WorldStore | null
  private runLogs: RunLogStore | null
  private rng: () => number
  private runners: Record<Run['execution'], Runner>
  private localRunner: Runner
  private workdirs = new Map<RunId, PreparedWorkdir>()
  private pendingCompletions = new Map<RunId, Promise<void>>()
  /** Local runs still reading their pull request or preparing their working directory. */
  private setups = new Map<RunId, Promise<void>>()
  /** Worktree removals in flight (ADR 0009). */
  private cleanups = new Set<Promise<void>>()
  private seedOptions: { localRoot?: string; localCronEnabled?: boolean }
  private linear: LinearClient
  private clock: () => number
  private polls = new Map<TriggerId, Promise<void>>()
  private pollStarted = new Map<TriggerId, number>()
  private drains = new Map<IssueId, Promise<void>>()
  private seq = 0
  private rev = 0
  private closed = false

  /**
   * `manual` stops the automatic interval; tests then advance simulated time with
   * `advance(ms)`. `rng` makes run outcomes, durations, and metric noise repeatable.
   * `store` holds the saved world; without one the world lives in memory only.
   */
  constructor(options: {
    manual?: boolean; rng?: () => number; store?: WorldStore; runLogs?: RunLogStore; localRunner?: Runner; localRoot?: string; localCronEnabled?: boolean
    linear?: LinearClient; clock?: () => number
  } = {}) {
    this.rng = options.rng ?? Math.random
    this.linear = options.linear ?? createLinearClient({ url: LINEAR_URL, apiKey: undefined })
    this.clock = options.clock ?? Date.now
    this.localRunner = options.localRunner ?? new ClaudeRunner()
    this.runners = { simulated: new SimulatedRunner(this.rng), local: this.localRunner }
    this.seedOptions = { localRoot: options.localRoot, localCronEnabled: options.localCronEnabled }
    this.store = options.store ?? null
    this.runLogs = options.runLogs ?? null
    this.rev = 1
    this.world = seedWorld(Date.now(), this.seedOptions)
    if (!this.store?.load((text) => this.restore(text))) {
      this.world = seedWorld(Date.now(), this.seedOptions)
      this.seq = 0
    }
    this.reconcileRoots()
    if (!options.manual) this.start()
  }

  /** Run inside the store's load so a document that throws while replaying is set aside like one that fails to parse. */
  private restore(text: string): true | null {
    const restored = parseWorld(text)
    if (!restored) return null
    const seededLocal = restored.sandboxes['sb-local-1' as SandboxId]
    if (seededLocal?.host === 'localhost' && this.seedOptions.localRoot) {
      seededLocal.host = this.seedOptions.localRoot
      const seededCron = restored.triggers['tr-cron' as TriggerId]
      if (seededCron) seededCron.enabled = false
    }
    this.world = restored
    const localRunIds = Object.values(restored.runs).filter((run) => run.execution === 'local').map((run) => run.id)
    restored.logs = this.runLogs?.load(localRunIds, MAX_LOGS) ?? []
    this.seq = Math.max(0, ...restored.events.map((event) => event.id), ...restored.logs.map((line) => line.id))
    const interrupted = Object.values(restored.runs).filter((run) => run.status === 'running')
    for (const run of interrupted) {
      const task = restored.tasks[run.taskId]
      this.finishRun(run, task && this.openRecord(task.flowId)?.cancel
        ? { status: 'cancelled', reason: 'its flow was cancelled' }
        : { status: 'failed', reason: 'interrupted by restart' })
    }
    if (interrupted.length > 0) this.publish()
    return true
  }

  /** Write the world now instead of when the save throttle fires. */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const retained = retainWorld(this.world)
    if (this.store?.save(JSON.stringify(retained))) {
      this.runLogs?.prune(Object.values(retained.runs).filter((run) => run.execution === 'local').map((run) => run.id))
    }
  }

  /** Stop the tick loop and write the world. */
  async close() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const timeout of this.localTimeouts.values()) clearTimeout(timeout)
    this.localTimeouts.clear()
    for (const run of Object.values(this.world.runs)) {
      if (run.status === 'running' && !this.pendingCompletions.has(run.id)) this.runners[run.execution ?? 'simulated'].kill(run.id)
    }
    if (this.pendingCompletions.size) await Promise.all(this.pendingCompletions.values())
    if (this.polls.size || this.drains.size || this.setups.size) await this.settled()
    this.flush()
    await Promise.all(this.cleanups)
  }

  /** Resolves once no Linear poll, write-back, local run setup or worktree removal is in flight. */
  async settled() {
    while (this.polls.size > 0 || this.drains.size > 0 || this.setups.size > 0 || this.cleanups.size > 0) {
      await Promise.all([...this.polls.values(), ...this.drains.values(), ...this.setups.values(), ...this.cleanups])
    }
  }

  /**
   * Removes a local run's worktree and branch once nothing reads them (ADR 0009). The removal waits for the run's setup,
   * which may still be creating the worktree when the run ends. A failure is logged and the next start retries it.
   */
  private discardWorkdir(run: Run, root: string | undefined, report = true) {
    if (run.execution !== 'local' || !root) return
    this.track((this.setups.get(run.id) ?? Promise.resolve()).then(() => this.dropWorkdir(run.id, root, report)))
  }

  /** `report` is off for a run that reset removed from the world, which has no log to warn in. */
  private async dropWorkdir(runId: RunId, root: string, report = true) {
    const run = this.world.runs[runId]
    const where = run ? { runId, agentId: run.agentId } : {}
    try {
      const left = await removeWorkdir(root, runId, run !== undefined && run.status !== 'running')
      if (left.length && report) {
        this.log('warn', `left alone, not provably this run's: ${left.join('; ')}`, where)
        this.publish()
      }
    } catch (error) {
      if (!report) return
      this.log('warn', `worktree of run ${runId} not removed, the next start retries: ${error instanceof Error ? error.message : String(error)}`, where)
      this.publish()
    }
  }

  private track(cleanup: Promise<void>) {
    this.cleanups.add(cleanup)
    void cleanup.finally(() => this.cleanups.delete(cleanup))
  }

  /** At start, removes the worktrees of runs that ended or were killed with their server, whether or not the saved world knows them. */
  private reconcileRoots() {
    const roots = new Set(Object.values(this.world.sandboxes).filter((sandbox) => sandbox.kind === 'local' && isAbsolute(sandbox.host)).map((sandbox) => sandbox.host))
    for (const root of roots) {
      this.track(reconcileWorkdirs(root, (runId) => this.world.runs[runId]?.status === 'running', (runId) => this.dropWorkdir(runId, root)).catch(() => undefined))
    }
  }

  /** Monotonic count of publishes. The initial seed is revision 1. */
  revision() {
    return this.rev
  }

  /** Advance simulated time by `ms` and run one full tick. For manual mode. */
  advance(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('ms must be a finite, non-negative number')
    if (this.world.sim.paused) return
    this.tick(ms)
  }

  private rand(lo: number, hi: number) {
    return lo + this.rng() * (hi - lo)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.world)
    return () => this.listeners.delete(fn)
  }

  snapshot(): World {
    return this.world
  }

  private start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick(TICK_MS * this.world.sim.speed)
      if (this.world.sim.paused && Object.values(this.world.runs).some((run) => run.status === 'running' && run.execution === 'local')) this.publish()
    }, TICK_MS)
    // unref where available so a test process is not kept alive by the singleton
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  private publish() {
    const grown = this.reconcileIntake()
    this.rev += 1
    this.world = { ...this.world }
    for (const fn of this.listeners) fn(this.world)
    // A queued write, with its comment id, must be on disk before it can reach Linear, or a restart would mint a new id and post twice.
    if (grown.length > 0) this.flush()
    for (const issueId of grown) this.drain(issueId)
    if (!this.store || this.saveTimer || grown.length > 0) return
    this.saveTimer = setTimeout(() => this.flush(), SAVE_MS)
  }

  // ---- writes -------------------------------------------------------------

  private uid(prefix: string) {
    return `${prefix}-${Date.now().toString(36)}${(this.seq++).toString(36)}`
  }

  private patchAgent(id: AgentId, patch: Partial<Agent>) {
    const cur = this.world.agents[id]
    if (!cur) return
    this.world.agents = { ...this.world.agents, [id]: { ...cur, ...patch } }
  }
  private patchSandbox(id: SandboxId, patch: Partial<Sandbox>) {
    const cur = this.world.sandboxes[id]
    if (!cur) return
    this.world.sandboxes = { ...this.world.sandboxes, [id]: { ...cur, ...patch } }
  }
  private patchTrigger(id: TriggerId, patch: Partial<Trigger>) {
    const cur = this.world.triggers[id]
    if (!cur) return
    this.world.triggers = { ...this.world.triggers, [id]: { ...cur, ...patch } }
  }
  private patchTask(id: TaskId, patch: Partial<Task>) {
    const cur = this.world.tasks[id]
    if (!cur) return
    this.world.tasks = { ...this.world.tasks, [id]: { ...cur, ...patch } }
  }
  private patchRun(id: RunId, patch: Partial<Run>) {
    const cur = this.world.runs[id]
    if (!cur) return
    this.world.runs = { ...this.world.runs, [id]: { ...cur, ...patch } }
  }

  private log(level: LogLevel, msg: string, ref: { runId?: RunId; agentId?: AgentId } = {}, ts = ref.runId && this.world.runs[ref.runId]?.execution === 'local' ? Date.now() : this.world.now) {
    const local = ref.runId && this.world.runs[ref.runId]?.execution === 'local'
    const line = { id: ++this.seq, ts, level, runId: ref.runId ?? null, agentId: ref.agentId ?? null, msg: local ? boundedRunText(msg, LOG_TRUNCATED) : msg }
    if (local) this.runLogs?.append(line)
    const logs = this.world.logs.length >= MAX_LOGS ? this.world.logs.slice(-MAX_LOGS + 1) : this.world.logs.slice()
    logs.push(line)
    this.world.logs = logs
  }

  private event(kind: FactoryEvent['kind'], subject: Subject, msg: string) {
    const ev = { id: ++this.seq, ts: this.world.now, kind, subject, msg }
    const events = this.world.events.length >= MAX_EVENTS ? this.world.events.slice(-MAX_EVENTS + 1) : this.world.events.slice()
    events.push(ev)
    this.world.events = events
  }

  // ---- public API ---------------------------------------------------------

  updatePositions(moves: Array<{ id: NodeId; position: Position }>) {
    for (const { id, position } of moves) {
      const kind = nodeKindOf(this.world, id)
      if (kind === 'agent') this.patchAgent(id as AgentId, { position })
      else if (kind === 'sandbox') this.patchSandbox(id as SandboxId, { position })
      else if (kind === 'trigger') this.patchTrigger(id as TriggerId, { position })
    }
    this.publish()
  }

  createNode(kind: NodeKind, position: Position): NodeId {
    const w = this.world
    if (kind === 'agent') {
      const n = Object.keys(w.agents).length + 1
      const id = this.uid('ag') as AgentId
      const agent: Agent = {
        id, name: `Agent ${n}`, role: 'generalist', model: 'claude-sonnet-5', temperature: 0.3, concurrency: 1,
        timeoutMs: 120_000, retry: { maxAttempts: 2, backoffMs: 1000, backoff: 'fixed' }, tools: ['read_file', 'bash'],
        systemPrompt: 'You are a helpful engineering agent.', delivery: 'none', status: 'idle', position, completed: 0, failed: 0,
        groupId: null,
      }
      w.agents = { ...w.agents, [id]: agent }
      this.event('graph', { kind: 'agent', id }, `Agent ${agent.name} created`)
      this.publish()
      return id
    }
    if (kind === 'sandbox') {
      const n = Object.keys(w.sandboxes).length + 1
      const id = this.uid('sb') as SandboxId
      const sb: Sandbox = {
        id, name: `sandbox-${n}`, kind: 'docker', host: 'docker.internal', image: 'ghcr.io/factory/dev:node22',
        state: 'provisioning', stateSince: w.now, progress: 0, metrics: { cpu: 0, mem: 0, disk: 4 }, history: [],
        leases: [], capacity: 1, restartPending: false, position, groupId: null,
      }
      w.sandboxes = { ...w.sandboxes, [id]: sb }
      this.event('sandbox', { kind: 'sandbox', id }, `Provisioning ${sb.name}`)
      this.log('info', `provisioning ${sb.name} on ${sb.host}`)
      this.publish()
      return id
    }
    const n = Object.keys(w.triggers).length + 1
    const id = this.uid('tr') as TriggerId
    const tr: Trigger = {
      id, name: `Trigger ${n}`, kind: 'manual', intervalMs: 30_000, enabled: true, lastFiredAt: w.now, fired: 0,
      template: 'Do the thing', linear: null, position, groupId: null,
    }
    w.triggers = { ...w.triggers, [id]: tr }
    this.event('graph', { kind: 'trigger', id }, `Trigger ${tr.name} created`)
    this.publish()
    return id
  }

  deleteNodes(ids: NodeId[]) {
    const w = this.world
    if (ids.length === 0) return
    const firstId = ids[0]
    const subject = nodeSubject(nodeKindOf(w, firstId) ?? 'agent', firstId)
    const gone = new Set<string>(ids)
    if (Object.values(w.runs).some((run) => this.pendingCompletions.has(run.id) && (gone.has(run.agentId) || gone.has(run.sandboxId)))) {
      throw new Error('run is finishing; try deleting the node again shortly')
    }
    for (const r of Object.values(w.runs)) {
      if (r.status !== 'running') continue
      if (gone.has(r.agentId)) this.finishRun(r, { status: 'failed', reason: 'agent deleted', retryable: false })
      else if (gone.has(r.sandboxId)) this.finishRun(r, { status: 'failed', reason: 'sandbox deleted' })
    }
    for (const t of Object.values(w.tasks)) if (gone.has(t.agentId) && (t.status === 'queued' || t.status === 'waiting')) this.patchTask(t.id, { status: 'cancelled', blockedOn: null })
    const attached = new Set<string>(attachedEdges(w, ids).map((e) => e.id))
    w.agents = Object.fromEntries(Object.entries(w.agents).filter(([id]) => !gone.has(id))) as World['agents']
    w.triggers = Object.fromEntries(Object.entries(w.triggers).filter(([id]) => !gone.has(id))) as World['triggers']
    this.forgetPolls(ids as TriggerId[])
    for (const id of ids) if (w.sandboxes[id as SandboxId]) this.removeSandbox(id as SandboxId)
    w.edges = Object.fromEntries(Object.entries(w.edges).filter(([id]) => !attached.has(id))) as World['edges']
    this.event('graph', subject, `Deleted ${ids.length} node${ids.length === 1 ? '' : 's'}`)
    this.publish()
  }

  /** Write a node record into its bucket. The caller owns normalization; paste and restore differ only there. */
  private putNode(ref: NodeRef): Subject {
    const w = this.world
    if (ref.kind === 'agent') w.agents = { ...w.agents, [ref.node.id]: ref.node }
    else if (ref.kind === 'sandbox') w.sandboxes = { ...w.sandboxes, [ref.node.id]: ref.node }
    else w.triggers = { ...w.triggers, [ref.node.id]: ref.node }
    return nodeSubject(ref.kind, ref.node.id)
  }

  /** Write an edge under the same validity and duplicate rules as `connect`. False when the graph rejected it. */
  private putEdge(edge: Edge): boolean {
    const w = this.world
    if (w.edges[edge.id]) return false
    if (!connectable(w, edge.source, edge.target)?.kinds.includes(edge.kind)) return false
    if (edgeExists(w, edge.source, edge.target, edge.kind)) return false
    if (fanOutRefusal(w, edge.source, edge.kind)) return false
    w.edges = { ...w.edges, [edge.id]: edge }
    return true
  }

  /** Put node records back under their original ids with the reload normalization; ids already present are skipped. */
  restoreNodes(nodes: NodeRef[]) {
    const w = this.world
    const restored = nodes
      .filter((ref) => !nodeKindOf(w, ref.node.id))
      .map((ref) => this.putNode(restoredNode(ref, w.now)))
    if (restored.length === 0) return
    this.event('graph', restored[0], restored.length === 1 ? `Restored ${this.nameOf(restored[0].id)}` : `Restored ${restored.length} nodes`)
    this.publish()
  }

  /** Put edges back under their original ids, in order, under the same validity and duplicate rules as `connect`. */
  restoreEdges(edges: Edge[]) {
    const restored = edges.filter((edge) => this.putEdge(edge))
    if (restored.length > 0) this.publish()
  }

  /** Copy a fragment into the graph under new ids, each node moved by `offset`. Only edges with both endpoints in the fragment are recreated. */
  paste(fragment: GraphFragment, offset: Position): GraphFragment {
    const w = this.world
    const newIds = new Map<string, NodeId>()
    const nodes: NodeRef[] = []
    for (const ref of fragment.nodes) {
      const copy = pastedNode(ref, this.uid(ID_PREFIX[ref.kind]), offset, w.now)
      newIds.set(ref.node.id, copy.node.id)
      nodes.push(copy)
      this.putNode(copy)
      if (copy.kind === 'sandbox') this.log('info', `provisioning ${copy.node.name} (${copy.node.kind}) on ${copy.node.host}`)
    }
    if (nodes.length === 0) return { nodes: [], edges: [] }
    const edges = fragment.edges.flatMap(({ kind, source: from, target: to }) => {
      const source = newIds.get(from)
      const target = newIds.get(to)
      if (!source || !target) return []
      const edge: Edge = { id: this.uid('ed') as EdgeId, kind, source, target }
      return this.putEdge(edge) ? [edge] : []
    })
    this.event('graph', nodeSubject(nodes[0].kind, nodes[0].node.id), `Pasted ${nodes.length} node${nodes.length === 1 ? '' : 's'}`)
    this.publish()
    return { nodes, edges }
  }

  connect(source: NodeId, target: NodeId, preferred: EdgeKind | null): { ok: true; id: EdgeId } | { ok: false; reason: string } {
    const w = this.world
    const join = connectable(w, source, target)
    if (!join) return { ok: false, reason: 'unknown node' }
    if (join.kinds.length === 0) return { ok: false, reason: `${join.from} → ${join.to} is not a valid connection` }
    const kind = preferred && join.kinds.includes(preferred) ? preferred : join.kinds[0]
    if (edgeExists(w, source, target, kind)) return { ok: false, reason: 'edge already exists' }
    const refusal = fanOutRefusal(w, source, kind)
    if (refusal) return { ok: false, reason: refusal }
    const id = this.uid('ed') as EdgeId
    w.edges = { ...w.edges, [id]: { id, kind, source, target } }
    this.event('graph', { kind: 'edge', id }, `Connected ${this.nameOf(source)} → ${this.nameOf(target)} (${EDGE_RULES[kind].label})`)
    this.publish()
    return { ok: true, id }
  }

  setEdgeKind(id: EdgeId, kind: EdgeKind) {
    const e = this.world.edges[id]
    if (!e) return
    const join = connectable(this.world, e.source, e.target)
    if (!join || !join.kinds.includes(kind)) return
    if (edgeExists(this.world, e.source, e.target, kind, id)) return
    this.world.edges = { ...this.world.edges, [id]: { ...e, kind } }
    this.publish()
  }

  removeEdges(ids: EdgeId[]) {
    const gone = new Set(ids)
    this.world.edges = Object.fromEntries(Object.entries(this.world.edges).filter(([id]) => !gone.has(id as EdgeId))) as World['edges']
    this.publish()
  }

  private setGroupId(id: NodeId, groupId: GroupId | null) {
    const kind = nodeKindOf(this.world, id)
    if (kind === 'agent') this.patchAgent(id as AgentId, { groupId })
    else if (kind === 'sandbox') this.patchSandbox(id as SandboxId, { groupId })
    else if (kind === 'trigger') this.patchTrigger(id as TriggerId, { groupId })
  }

  private memberIds(groupId: GroupId): NodeId[] {
    const ids: NodeId[] = []
    for (const a of Object.values(this.world.agents)) if (a.groupId === groupId) ids.push(a.id)
    for (const s of Object.values(this.world.sandboxes)) if (s.groupId === groupId) ids.push(s.id)
    for (const t of Object.values(this.world.triggers)) if (t.groupId === groupId) ids.push(t.id)
    return ids
  }

  group(ids: NodeId[]): GroupId | null {
    const refs = [...new Set(ids)].map((id) => nodeRef(this.world, id)).filter((ref) => ref !== null)
    if (refs.length < 2 || refs.some((ref) => ref.node.groupId !== null)) return null
    const id = this.uid('gr') as GroupId
    const group: Group = { id, name: this.nextGroupName() }
    this.world.groups = { ...this.world.groups, [id]: group }
    for (const ref of refs) this.setGroupId(ref.node.id, id)
    this.event('graph', { kind: 'group', id }, `Grouped ${refs.length} nodes`)
    this.publish()
    return id
  }

  ungroup(id: GroupId) {
    const group = this.world.groups[id]
    if (!group) return
    for (const memberId of this.memberIds(id)) this.setGroupId(memberId, null)
    this.world.groups = Object.fromEntries(Object.entries(this.world.groups).filter(([gid]) => gid !== id)) as World['groups']
    this.event('graph', { kind: 'group', id }, `Ungrouped ${group.name}`)
    this.publish()
  }

  restoreGroup(group: Group, memberIds: NodeId[]) {
    if (this.world.groups[group.id]) return
    this.world.groups = { ...this.world.groups, [group.id]: group }
    for (const id of memberIds) {
      const ref = nodeRef(this.world, id)
      if (!ref || ref.node.groupId !== null) continue
      this.setGroupId(id, group.id)
    }
    this.publish()
  }

  updateGroup(id: GroupId, patch: { name: string }) {
    const cur = this.world.groups[id]
    if (!cur) return
    this.world.groups = { ...this.world.groups, [id]: { ...cur, ...patch } }
    this.publish()
  }

  updateAgent(id: AgentId, patch: AgentPatch) {
    const cur = this.world.agents[id]
    if (!cur) return
    this.patchAgent(id, { ...patch, retry: { ...cur.retry, ...patch.retry } })
    this.publish()
  }

  setAgentPaused(id: AgentId, paused: boolean) {
    const ag = this.world.agents[id]
    if (!ag) return
    this.patchAgent(id, { status: paused ? 'paused' : this.runningCount(id) > 0 ? 'working' : 'idle' })
    this.event('agent', { kind: 'agent', id }, `${ag.name} ${paused ? 'paused' : 'resumed'}`)
    this.publish()
  }

  enqueueTask(agentId: AgentId, input: { title: string; prompt: string; priority: Priority }, origin: Task['origin'] = { kind: 'manual' }): TaskId {
    const flowId = this.uid('fl') as FlowId
    const id = this.uid('tk') as TaskId
    const task: Task = { id, flowId, agentId, title: input.title, prompt: input.prompt, priority: input.priority, status: 'queued', origin, input: null, createdAt: this.world.now, attempts: 0, retryAt: null, blockedOn: null }
    this.world.tasks = { ...this.world.tasks, [id]: task }
    this.event('task', { kind: 'task', id }, `Queued “${task.title}” for ${this.nameOf(agentId)}`)
    this.publish()
    return id
  }

  cancelTask(id: TaskId) {
    const t = this.world.tasks[id]
    if (!t) return
    // A local run already collecting its artifacts cannot be stopped, but the cancel still holds back its handoffs and the rest of its flow.
    const record = this.openRecord(t.flowId)
    if (record && (t.status === 'queued' || t.status === 'waiting' || this.runningLocalRun(id))) {
      this.world.intake = { ...this.world.intake, [record.issue.id]: cancelRecord(record, { kind: 'factory', task: t.title }) }
      this.cancelFlow(t.flowId, 'cancelled by operator')
      this.publish()
      return
    }
    if (t.status === 'running') {
      const run = this.cancellableRun(id)
      if (!run) return
      this.finishRun(run, { status: 'cancelled', reason: 'cancelled by operator' })
      this.publish()
      return
    }
    if (t.status !== 'queued' && t.status !== 'waiting') return
    this.cancelPending(t, null)
    this.publish()
  }

  /** An operator can cancel only a local run. A simulated run has no process to stop. */
  private runningLocalRun(taskId: TaskId): Run | undefined {
    return Object.values(this.world.runs).find((candidate) => candidate.taskId === taskId && candidate.status === 'running' && candidate.execution === 'local')
  }

  /** The task's running local run, unless it is already finishing. */
  private cancellableRun(taskId: TaskId): Run | undefined {
    const run = this.runningLocalRun(taskId)
    return run && !this.pendingCompletions.has(run.id) ? run : undefined
  }

  /** Cancels every task of the flow that can still run, killing running processes. A killed run ends cancelled, so nothing retries. */
  private cancelFlow(flowId: FlowId, reason: string) {
    for (const task of Object.values(this.world.tasks)) {
      if (task.flowId !== flowId) continue
      if (task.status === 'running') {
        const run = Object.values(this.world.runs).find((r) => r.taskId === task.id && r.status === 'running')
        if (run) this.finishRun(run, { status: 'cancelled', reason })
      } else if (task.status === 'queued' || task.status === 'waiting') this.cancelPending(task, reason)
    }
  }

  private cancelPending(task: Task, reason: string | null) {
    this.patchTask(task.id, { status: 'cancelled', retryAt: null, blockedOn: null })
    this.event('task', { kind: 'task', id: task.id }, `Cancelled “${task.title}”${reason ? `: ${reason}` : ''}`)
  }

  private openRecord(flowId: FlowId): IntakeRecord | undefined {
    return Object.values(this.world.intake).find((r) => r.flowId === flowId && r.phase !== 'ended')
  }

  sandboxAction(id: SandboxId, action: SandboxAction) {
    const sb = this.world.sandboxes[id]
    if (!sb) return
    const next = SANDBOX_TRANSITIONS[sb.state][action]
    if (!next) return
    if (sb.leases.some((lease) => this.pendingCompletions.has(lease.runId))) {
      throw new Error('run is finishing; try the sandbox action again shortly')
    }
    for (const lease of [...sb.leases]) {
      const run = this.world.runs[lease.runId]
      if (run && run.status === 'running') this.finishRun(run, { status: 'failed', reason: `sandbox ${action}` })
    }
    this.patchSandbox(id, { state: next, stateSince: this.world.now, progress: 0, leases: [], restartPending: action === 'restart' })
    this.event('sandbox', { kind: 'sandbox', id }, `${sb.name}: ${action} → ${next}`)
    this.log('info', `${sb.name} ${action} requested (${sb.state} → ${next})`)
    this.publish()
  }

  createSandbox(input: { name: string; kind: SandboxKind; host: string; image: string; capacity?: number }, position?: Position): SandboxId {
    const id = this.uid('sb') as SandboxId
    const capacity = input.capacity !== undefined && isCapacity(input.capacity) ? input.capacity : 1
    const sb: Sandbox = {
      id, ...input, capacity, state: 'provisioning', stateSince: this.world.now, progress: 0,
      metrics: { cpu: 0, mem: 0, disk: 4 }, history: [], leases: [], restartPending: false,
      position: position ?? this.nextFreePosition(), groupId: null,
    }
    this.world.sandboxes = { ...this.world.sandboxes, [id]: sb }
    this.event('sandbox', { kind: 'sandbox', id }, `Provisioning ${sb.name}`)
    this.log('info', `provisioning ${sb.name} (${sb.kind}) on ${sb.host}`)
    this.publish()
    return id
  }

  updateSandbox(id: SandboxId, patch: { capacity?: number; host?: string }) {
    const sandbox = this.world.sandboxes[id]
    if (!sandbox) return
    if (patch.capacity !== undefined && !isCapacity(patch.capacity)) return
    if (patch.host !== undefined && (sandbox.kind !== 'local' || !isAbsolute(patch.host))) return
    // A run's worktree is removed from, and at start looked for under, the sandbox's root as it is then (ADR 0009).
    if (patch.host !== undefined && patch.host !== sandbox.host && sandbox.leases.length > 0) {
      throw new Error('a run is in progress on this sandbox; change its root once it ends')
    }
    this.patchSandbox(id, patch)
    this.publish()
  }

  updateTrigger(id: TriggerId, patch: Partial<Omit<Trigger, 'id' | 'position' | 'groupId'>>) {
    const cur = this.world.triggers[id]
    if (!cur) return
    const next: Trigger = { ...cur, ...patch }
    if (next.kind !== 'linear') {
      next.linear = null
      this.forgetPolls([id])
    } else if (cur.kind !== 'linear') {
      if (Object.values(this.world.edges).filter((e) => e.kind === 'triggers' && e.source === id).length > 1) {
        throw new Error('A Linear trigger feeds one agent. Remove all but one triggers edge first.')
      }
      next.enabled = false
    } else if (next.enabled && next.linear === null) {
      if (patch.enabled) throw new Error('Choose a team and pickup state before enabling a Linear trigger.')
      next.enabled = false
    }
    if (next.kind === 'linear' && (next.enabled !== cur.enabled || !sameSettings(next.linear, cur.linear))) this.pollStarted.delete(id)
    this.world.triggers = { ...this.world.triggers, [id]: next }
    this.publish()
  }

  async fireTrigger(id: TriggerId) {
    if (this.world.triggers[id]?.kind === 'linear') return this.poll(id)
    this.fire(id)
    this.publish()
  }

  linearCatalog(): Promise<LinearCatalog> {
    return this.linear.catalog()
  }

  async linearPreview(settings: IssueFilter): Promise<IntakePreview> {
    const issues = await this.linear.issues(settings)
    return {
      count: issues.length,
      issues: issues.slice(0, PREVIEW_ISSUES).map((issue) => ({ identifier: issue.ref.identifier, title: issue.title, url: issue.ref.url })),
    }
  }

  setSim(patch: Partial<World['sim']>) {
    this.world.sim = { ...this.world.sim, ...patch }
    this.publish()
  }

  reset() {
    for (const timeout of this.localTimeouts.values()) clearTimeout(timeout)
    this.localTimeouts.clear()
    for (const run of Object.values(this.world.runs)) {
      if (run.status !== 'running') continue
      this.runners[run.execution ?? 'simulated'].kill(run.id)
      this.discardWorkdir(run, this.workdirs.get(run.id)?.root ?? this.world.sandboxes[run.sandboxId]?.host, false)
    }
    this.workdirs.clear()
    this.store?.clear()
    this.pollStarted.clear()
    this.world = seedWorld(Date.now(), this.seedOptions)
    this.runLogs?.prune([])
    this.publish()
  }

  // ---- simulation ---------------------------------------------------------

  private tick(dt: number) {
    const w = this.world
    if (w.sim.paused) return
    w.now += dt
    this.tickSandboxes()
    this.tickTriggers()
    this.tickIntake()
    this.tickRuns(dt)
    this.schedule()
    this.publish()
  }

  private tickSandboxes() {
    for (const sb of Object.values(this.world.sandboxes)) {
      const timed = SANDBOX_TIMED[sb.state]
      let patch: Partial<Sandbox> = {}
      if (timed) {
        const progress = clamp((this.world.now - sb.stateSince) / timed.durationMs, 0, 1)
        patch.progress = progress
        if (progress >= 1) {
          if (sb.state === 'destroying') {
            this.removeSandbox(sb.id)
            this.event('sandbox', { kind: 'sandbox', id: sb.id }, `${sb.name} destroyed`)
            continue
          }
          let next = timed.next
          if (sb.state === 'stopping' && sb.restartPending) {
            next = 'provisioning'
            patch.restartPending = false
          }
          patch = { ...patch, state: next, stateSince: this.world.now, progress: next === 'running' ? 1 : 0 }
          this.event('sandbox', { kind: 'sandbox', id: sb.id }, `${sb.name} is ${next}`)
          this.log(next === 'running' ? 'info' : 'debug', `${sb.name} → ${next}`)
        }
      }
      const busy = sb.leases.length > 0
      const off = sb.state === 'stopped' || sb.state === 'destroying'
      const target = off ? { cpu: 0, mem: 0, disk: sb.metrics.disk } : busy
        ? { cpu: this.rand(55, 95), mem: this.rand(45, 80), disk: sb.metrics.disk + this.rand(0, 0.15) }
        : sb.state === 'running' ? { cpu: this.rand(2, 12), mem: this.rand(18, 30), disk: sb.metrics.disk }
        : { cpu: this.rand(20, 60), mem: this.rand(20, 50), disk: sb.metrics.disk + this.rand(0, 0.4) }
      const k = 0.35
      const metrics = {
        cpu: clamp(sb.metrics.cpu + (target.cpu - sb.metrics.cpu) * k, 0, 100),
        mem: clamp(sb.metrics.mem + (target.mem - sb.metrics.mem) * k, 0, 100),
        disk: clamp(target.disk, 0, 100),
      }
      const history = sb.history.length >= 40 ? sb.history.slice(-39) : sb.history.slice()
      history.push(metrics)
      this.patchSandbox(sb.id, { ...patch, metrics, history })
    }
  }

  private removeSandbox(id: SandboxId) {
    const w = this.world
    const attached = new Set<string>(attachedEdges(w, [id]).map((e) => e.id))
    w.sandboxes = Object.fromEntries(Object.entries(w.sandboxes).filter(([k]) => k !== id)) as World['sandboxes']
    w.edges = Object.fromEntries(Object.entries(w.edges).filter(([edgeId]) => !attached.has(edgeId))) as World['edges']
  }

  private tickTriggers() {
    for (const tr of Object.values(this.world.triggers)) {
      if (!tr.enabled || !FIRES_ON_INTERVAL[tr.kind]) continue
      if (tr.lastFiredAt === null) {
        this.patchTrigger(tr.id, { lastFiredAt: this.world.now - tr.intervalMs * 0.6 })
        continue
      }
      if (this.world.now - tr.lastFiredAt >= tr.intervalMs) this.fire(tr.id)
    }
  }

  private fire(id: TriggerId) {
    const tr = this.world.triggers[id]
    if (!tr) return
    this.patchTrigger(id, { lastFiredAt: this.world.now, fired: tr.fired + 1 })
    const targets = Object.values(this.world.edges).filter((e) => e.kind === 'triggers' && e.source === id)
    this.event('trigger', { kind: 'trigger', id }, `${tr.name} fired (${tr.kind})`)
    const flowId = this.uid('fl') as FlowId
    for (const e of targets) {
      this.enqueueTaskSilently(e.target as AgentId, { title: tr.template, prompt: `${tr.template}\n\nTriggered by ${tr.name}.`, priority: tr.kind === 'webhook' ? 'high' : 'normal', origin: { kind: 'trigger', id }, input: null }, flowId)
    }
  }

  private pollable(tr: Trigger | undefined): tr is Pollable {
    return !!tr && tr.kind === 'linear' && tr.enabled && tr.linear !== null && !this.world.sim.paused && !this.closed
  }

  private tickIntake() {
    const now = this.clock()
    for (const tr of Object.values(this.world.triggers)) {
      if (!this.pollable(tr) || this.polls.has(tr.id)) continue
      const last = this.pollStarted.get(tr.id)
      if (last === undefined || now - last >= LINEAR_POLL_MS) void this.poll(tr.id)
    }
    for (const record of Object.values(this.world.intake)) {
      if (nextWrite(record.writes, now, LINEAR_POLL_MS) !== -1) this.drain(record.issue.id)
    }
  }

  private poll(id: TriggerId): Promise<void> {
    const inFlight = this.polls.get(id)
    if (inFlight) return inFlight
    const tr = this.world.triggers[id]
    if (!this.pollable(tr)) return Promise.resolve()
    const settings = tr.linear
    this.pollStarted.set(id, this.clock())
    const open = Object.values(this.world.intake).filter((r) => r.trigger === id && r.phase !== 'ended' && r.cancel === null).map((r) => r.issue.id)
    // Only a poll begun after a round ended can show that its issue left, or came back.
    const ended = new Map(Object.values(this.world.intake).filter((r) => r.phase === 'ended').map((r) => [r.issue.id, r]))
    const done = Promise.all([this.linear.issues(settings), this.linear.issueStates(open)])
      .then(async ([issues, states]) => ({ issues, states, rounds: await this.roundContexts(id, issues, ended, settings) }))
      .then(
        ({ issues, states, rounds }) => this.finishPoll(id, settings, issues, open, states, null, ended, rounds),
        (err: unknown) => this.finishPoll(id, settings, [], [], new Map(), intakeErrorOf(err), new Map(), new Map()),
      )
      .finally(() => this.polls.delete(id))
    this.polls.set(id, done)
    return done
  }

  /** The agent a trigger's `triggers` edge feeds, if any. */
  private feedAgent(id: TriggerId): AgentId | null {
    const feed = Object.values(this.world.edges).find((e) => e.kind === 'triggers' && e.source === id && this.world.agents[e.target as AgentId])
    return feed ? feed.target as AgentId : null
  }

  /**
   * The context of each listed issue that starts a new round: the open pull request to continue or the closed one to
   * replace, and the trusted feedback since the last round. Review feedback counts from the ended round's start, when its
   * prompt was built. An issue whose comments or pull request cannot be read waits for the next poll, so a round never
   * guesses its branch. A trigger that feeds no agent starts no round, so it reads nothing.
   */
  private async roundContexts(id: TriggerId, issues: LinearIssue[], ended: Map<IssueId, IntakeRecord>, settings: LinearSettings): Promise<Map<IssueId, RoundContext>> {
    if (!this.feedAgent(id)) return new Map()
    const due = issues.map((issue) => ended.get(issue.ref.id)).filter((r): r is IntakeRecord => r !== undefined && reworkable(r, settings.pickupState))
    const waits = (record: IntakeRecord, what: string, error: unknown): null => {
      this.log('warn', `${record.issue.identifier}: could not read ${what}, so its next round waits for the next poll: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    const contexts = await Promise.all(due.map(async (record): Promise<[IssueId, RoundContext] | null> => {
      let linear: Screened
      try {
        linear = linearFeedback(record, await this.linear.comments(record.issue.id))
      } catch (error) {
        return waits(record, 'its Linear comments', error)
      }
      const pr = latestPullRequest(record)
      if (!pr) return [record.issue.id, { rework: null, review: [], linear: linear.quoted, leftOut: linear.leftOut }]
      try {
        const { view, feedback } = await readPullRequest(pr.url)
        const review = screen(feedback, record.takenAt)
        return [record.issue.id, { rework: reworkOf(pr, view), review: review.quoted, linear: linear.quoted, leftOut: [...review.leftOut, ...linear.leftOut] }]
      } catch (error) {
        return waits(record, pr.url, error)
      }
    }))
    return new Map(contexts.filter((c) => c !== null))
  }

  private finishPoll(
    id: TriggerId, settings: LinearSettings, issues: LinearIssue[], refreshed: IssueId[], states: Map<IssueId, IssueStatus>, error: IntakeError | null,
    ended: Map<IssueId, IntakeRecord>, rounds: Map<IssueId, RoundContext>,
  ) {
    const tr = this.world.triggers[id]
    if (!this.pollable(tr) || !sameSettings(tr.linear, settings)) return
    this.world.intakePolls = { ...this.world.intakePolls, [id]: { at: this.clock(), error } }
    const listed = new Set(issues.map((issue) => issue.ref.id))
    for (const [issueId, before] of ended) {
      const record = this.world.intake[issueId]
      if (error || listed.has(issueId) || !sameRound(record, before) || record.left || record.trigger !== id) continue
      if ((record.states?.pickupState ?? settings.pickupState) !== settings.pickupState) continue
      this.world.intake = { ...this.world.intake, [issueId]: { ...record, left: true } }
    }
    const queued = refreshed.length > 0 ? this.pendingIssueTasks() : new Map<FlowId, Task>()
    const unread: string[] = []
    for (const issueId of refreshed) {
      const status = states.get(issueId)
      this.followIssue(issueId, status?.state ?? null, settings)
      if (status && this.refreshUnstarted(issueId, status, queued) && status.moreRelations) unread.push(this.world.intake[issueId].issue.identifier)
    }
    const agentId = this.feedAgent(id)
    if (!agentId) {
      this.warnUnreadRelations(unread)
      this.publish()
      return
    }
    const taken: string[] = []
    for (const issue of issues) {
      const record = this.world.intake[issue.ref.id]
      const context = record ? rounds.get(issue.ref.id) : null
      // The round that ended before the poll must still be the issue's latest, or another poll already started the next.
      if (record && (!context || !sameRound(record, ended.get(issue.ref.id)))) continue
      const round = record ? record.round + 1 : 1
      const flowId = this.uid('fl') as FlowId
      const states = { pickupState: settings.pickupState, startedState: settings.startedState }
      const next = startRound(record, issue.ref, {
        trigger: id, flowId, takenAt: this.clock(), states, blockers: issue.blockers, rework: context?.rework ?? null, leftOut: context?.leftOut ?? [],
        feedback: feedbackBlock(context ?? null),
      })
      this.enqueueTaskSilently(agentId, {
        title: roundTitle(issue.ref.identifier, issue.title, round),
        prompt: roundPrompt({ title: issue.title, description: issue.description, url: issue.ref.url, untrusted: issue.untrusted }, next, this.world.agents[agentId].delivery === 'pull-request'),
        priority: issue.priority,
        origin: { kind: 'issue', trigger: id, issue: issue.ref },
        input: record ? latestOutput(record) : null,
      }, flowId)
      this.world.intake = { ...this.world.intake, [issue.ref.id]: next }
      taken.push(round > 1 ? `${issue.ref.identifier} (round ${round})` : issue.ref.identifier)
      if (issue.moreRelations) unread.push(issue.ref.identifier)
    }
    this.warnUnreadRelations(unread)
    if (taken.length > 0) {
      this.patchTrigger(id, { lastFiredAt: this.world.now, fired: tr.fired + taken.length })
      this.event('trigger', { kind: 'trigger', id }, `${tr.name} took ${taken.join(', ')}`)
    }
    this.publish()
    // A new round must be on disk before its run starts, or a restart would start the round again.
    if (taken.length > 0) this.flush()
  }

  /** Each issue task that has not started yet, by flow. */
  private pendingIssueTasks(): Map<FlowId, Task> {
    const found = new Map<FlowId, Task>()
    for (const t of Object.values(this.world.tasks)) {
      if (t.origin.kind === 'issue' && (t.status === 'queued' || t.status === 'waiting')) found.set(t.flowId, t)
    }
    return found
  }

  private warnUnreadRelations(identifiers: string[]) {
    if (identifiers.length > 0) this.log('warn', `${identifiers.join(', ')}: blockers beyond the first 100 relations are not read`)
  }

  /**
   * Until its flow's first run starts, a taken issue follows its priority and blockers in Linear, wherever the issue sits.
   * Returns whether the record was still unstarted.
   */
  private refreshUnstarted(issueId: IssueId, status: IssueStatus, queued: Map<FlowId, Task>): boolean {
    const record = this.world.intake[issueId]
    if (!record || record.phase !== 'taken' || record.cancel !== null) return false
    if (JSON.stringify(record.blockers) !== JSON.stringify(status.blockers)) {
      this.world.intake = { ...this.world.intake, [issueId]: { ...record, blockers: status.blockers } }
    }
    const task = queued.get(record.flowId)
    if (task && task.priority !== status.priority) this.patchTask(task.id, { priority: status.priority })
    return true
  }

  /** Cancels the issue's flow when the issue has left the trigger's states in Linear. */
  private followIssue(issueId: IssueId, state: IssueState | null, settings: LinearSettings) {
    const record = this.world.intake[issueId]
    if (!record || record.phase === 'ended' || record.cancel !== null) return
    const tasks = Object.values(this.world.tasks).filter((t) => t.flowId === record.flowId)
    const action = flowAction(state, flowOutcome(tasks) === null, record.states ?? settings)
    if (action.kind === 'none') return
    this.world.intake = { ...this.world.intake, [issueId]: cancelRecord(record, { kind: 'linear', reason: action.reason }) }
    this.cancelFlow(record.flowId, action.reason)
    this.event('trigger', { kind: 'trigger', id: record.trigger }, `${record.issue.identifier} ${action.reason}: cancelled its flow`)
  }

  /** Moves each open intake record along with its flow, and returns the issues that gained writes. */
  private reconcileIntake(): IssueId[] {
    const open = Object.values(this.world.intake).filter((record) => record.phase !== 'ended')
    if (open.length === 0) return []
    const flows = new Map<FlowId, Task[]>(open.map((record) => [record.flowId, []]))
    for (const task of Object.values(this.world.tasks)) flows.get(task.flowId)?.push(task)
    const grown: IssueId[] = []
    for (const record of open) {
      const next = reconcileRecord(record, flows.get(record.flowId) ?? [], this.world, randomUUID)
      if (next === record) continue
      this.world.intake = { ...this.world.intake, [record.issue.id]: next }
      if (next.writes.length > record.writes.length) grown.push(record.issue.id)
    }
    return grown
  }

  private drain(issueId: IssueId) {
    if (this.closed || this.drains.has(issueId)) return
    const done = this.drainWrites(issueId)
      .catch((err: unknown) => console.error(`write-back for ${issueId} stopped: ${intakeErrorOf(err).message}`))
      .finally(() => this.drains.delete(issueId))
    this.drains.set(issueId, done)
  }

  /**
   * Lands an issue's due writes. A failed move holds back later moves, not notes or attaches, until the next poll retries it.
   * A move is dropped when the issue has left the trigger's states. Task state is never touched.
   */
  private async drainWrites(issueId: IssueId) {
    for (;;) {
      const record: IntakeRecord | undefined = this.world.intake[issueId]
      const index = record ? nextWrite(record.writes, this.clock(), LINEAR_POLL_MS) : -1
      if (this.closed || !record || index === -1) return
      const write = record.writes[index]
      let status: WriteStatus
      try {
        let moved = true
        if (write.kind === 'move') moved = await this.linear.ensureState(issueId, write.stateId, this.ownStates(record))
        else if (write.kind === 'attach') await this.linear.ensureAttachment(issueId, write.url, write.title)
        else await this.linear.ensureComment(issueId, write.commentId, write.body ?? '')
        status = moved ? { state: 'landed', at: this.clock() } : { state: 'dropped' }
      } catch (err) {
        status = { state: 'failed', at: this.clock(), error: intakeErrorOf(err).message }
      }
      const current = this.world.intake[issueId]
      if (current) {
        // A move dropped by a cancel from Linear, or by a new round, while it was in flight stays dropped.
        const kept = current.writes[index]?.status.state !== 'dropped'
        const writes = current.writes.map((w, i) => (i === index && kept ? landed(w, status) : w))
        // An ended round's move out of its pickup state means a return to that state is a new entry.
        const left = current.left || (kept && status.state === 'landed' && current.phase === 'ended' && write.kind === 'move' && write.step !== 'started'
          && write.stateId !== (current.states ?? this.world.triggers[current.trigger]?.linear)?.pickupState)
        this.world.intake = { ...this.world.intake, [issueId]: { ...current, writes, left } }
        this.publish()
      }
    }
  }

  /**
   * The states Factory may move a record's issue out of, or null for an old record whose trigger is gone. Once an ended
   * round's issue has left, the pickup state is where a person put it, so a late finished or failed move leaves it there.
   */
  private ownStates(record: IntakeRecord): string[] | null {
    const states = record.states ?? this.world.triggers[record.trigger]?.linear
    if (!states) return null
    return record.phase === 'ended' && record.left ? workingStates(states).filter((s) => s !== states.pickupState) : workingStates(states)
  }

  private forgetPolls(ids: TriggerId[]) {
    for (const id of ids) this.pollStarted.delete(id)
    if (!ids.some((id) => id in this.world.intakePolls)) return
    const gone = new Set<string>(ids)
    this.world.intakePolls = Object.fromEntries(Object.entries(this.world.intakePolls).filter(([id]) => !gone.has(id))) as World['intakePolls']
  }

  private enqueueTaskSilently(agentId: AgentId, fields: Pick<Task, 'title' | 'prompt' | 'priority' | 'origin' | 'input'>, flowId: FlowId) {
    if (!this.world.agents[agentId]) return
    const id = this.uid('tk') as TaskId
    const task: Task = { id, flowId, agentId, ...fields, status: 'queued', createdAt: this.world.now, attempts: 0, retryAt: null, blockedOn: null }
    this.world.tasks = { ...this.world.tasks, [id]: task }
    this.event('task', { kind: 'task', id }, `Queued “${task.title}” for ${this.nameOf(agentId)}`)
  }

  private tickRuns(dt: number) {
    for (const run of Object.values(this.world.runs)) {
      if (run.status !== 'running' || run.execution === 'local') continue
      const agent = this.world.agents[run.agentId]
      const task = this.world.tasks[run.taskId]
      if (!agent || !task) continue
      const progress = this.runners.simulated.tick?.({ run, agent, task, workdir: '' }, dt, this.world.now, (event) => this.handleRunnerEvent(run.id, event))
      if (typeof progress === 'number' && this.world.runs[run.id]?.status === 'running') this.patchRun(run.id, { progress })
    }
  }

  private handleRunnerEvent(id: RunId, event: RunnerEvent) {
    const run = this.world.runs[id]
    if (!run || run.status !== 'running') return
    if (event.kind === 'log') this.log(event.level, event.message, { runId: id, agentId: run.agentId }, run.execution === 'local' ? Date.now() : this.world.now)
    else if (event.kind === 'tokens') this.patchRun(id, { tokens: event.count })
    else {
      const agent = this.world.agents[run.agentId]
      if (event.status === 'succeeded' && agent && run.execution === 'local') {
        const timeout = this.localTimeouts.get(run.id)
        if (timeout) clearTimeout(timeout)
        this.localTimeouts.delete(run.id)
        if (event.result === null) this.finishRun(run, { status: 'failed', reason: 'agent returned no final result' })
        else {
          const completion = this.completeLocalRun(run, agent, boundedRunText(event.result, RESULT_TRUNCATED))
          this.pendingCompletions.set(run.id, completion)
          void completion.then(() => this.pendingCompletions.delete(run.id), () => this.pendingCompletions.delete(run.id))
        }
      } else this.finishRun(run, event.status === 'succeeded' && agent
        ? { status: 'succeeded', agent }
        : { status: 'failed', reason: event.reason ?? 'agent unavailable' })
    }
    if (run.execution === 'local') this.publish()
  }

  private async completeLocalRun(run: Run, agent: Agent, result: string) {
    const prepared = this.workdirs.get(run.id)
    const delivering = prepared?.delivery ? prepared : null
    const listCommits = async (at: Parameters<typeof gitArtifacts>[0]) => {
      try { return await gitArtifacts(at, { lookupPr: !delivering }) }
      catch (error) {
        if (this.world.runs[run.id]?.status === 'running') this.log('warn', `git artifacts unavailable: ${error instanceof Error ? error.message : String(error)}`, { runId: run.id, agentId: run.agentId })
        return []
      }
    }
    let artifacts: RunOutput['artifacts'] = prepared && !delivering ? await listCommits(prepared) : []
    if (this.world.runs[run.id]?.status !== 'running') return
    if (delivering) {
      const task = this.world.tasks[run.taskId]
      const issue = task ? issueOfFlow(this.world, task.flowId) : null
      let delivery: Delivery
      try {
        const body = issue ? `${result}\n\n${issue.url}` : result
        delivery = await deliver(delivering, { title: run.title, body }, {
          request: () => this.recheckDelivery(task, run.id, agent.id),
          proceed: () => !(task && this.openRecord(task.flowId)?.cancel),
        })
      } catch (error) {
        if (this.world.runs[run.id]?.status !== 'running' || error instanceof RunEnded) return
        this.finishRun(run, { status: 'failed', reason: error instanceof Error ? error.message : String(error) }, true)
        this.publish()
        return
      }
      if (this.world.runs[run.id]?.status !== 'running') return
      if (delivery.kind === 'withheld') {
        this.finishRun(run, { status: 'cancelled', reason: 'its flow was cancelled' }, true)
        this.publish()
        return
      }
      const note: Artifact = { kind: 'note', label: 'No changes; no pull request opened', url: null }
      if (delivery.kind === 'no-changes') artifacts = [...(delivery.branch ? [{ kind: 'branch' as const, label: delivery.branch, url: null }] : []), note]
      else {
        if (task) this.keepPrBranch(task.flowId, delivery.branch)
        // Listed only now, so nothing after the pull request opened can fail the run and have a retry open another.
        const commits = await listCommits({ path: delivering.path, initialHead: delivery.initialHead, head: delivery.head })
        if (this.world.runs[run.id]?.status !== 'running') return
        // Name the branch on origin, not whichever branch the agent left checked out.
        artifacts = [{ kind: 'branch', label: delivery.branch, url: null }, ...commits.filter((a) => a.kind !== 'branch'), delivery.pr]
      }
    }
    this.finishRun(run, { status: 'succeeded', agent, output: { summary: result, artifacts } })
    this.publish()
  }

  /** Where a run that continued a pull request delivers, asked again before its push and after a push to the PR (ADR 0012). */
  private async recheckDelivery(task: Task | undefined, runId: RunId, agentId: AgentId): Promise<DeliveryRequest> {
    if (!task || !this.openRecord(task.flowId)?.rework) return Promise.reject(new Error('delivery failed: the round this run continues is no longer open'))
    const request = await this.deliveryRequest(task, runId, agentId)
    // A merge or close the reread found changes the prompt the finished run was given, so later runs and the note follow it.
    this.writePrompt(task, request !== null)
    return request
  }

  /** Keeps the head branch of a pull request delivered for the flow's issue, so no later delivery branch reuses it. */
  private keepPrBranch(flowId: FlowId, branch: string) {
    const record = this.openRecord(flowId)
    if (!record || record.prBranches.includes(branch)) return
    this.world.intake = { ...this.world.intake, [record.issue.id]: { ...record, prBranches: [...record.prBranches, branch] } }
  }

  /** `completing` is set only by the run's own completion, which a pending completion otherwise holds off. */
  private finishRun(run: Run, completion: RunCompletion, completing = false) {
    if (run.status !== 'running' || this.world.runs[run.id]?.status !== 'running') return
    if (completion.status !== 'succeeded' && !completing && this.pendingCompletions.has(run.id)) return
    // A failed run of a cancelled flow ends cancelled with no retry, as restore() ends an interrupted one.
    const flowId = this.world.tasks[run.taskId]?.flowId
    if (completion.status === 'failed' && flowId && this.openRecord(flowId)?.cancel) {
      completion = { status: 'cancelled', reason: 'its flow was cancelled' }
    }
    if (run.execution === 'local' && completion.status !== 'succeeded') completion = { ...completion, reason: boundedRunText(completion.reason, ERROR_TRUNCATED) }
    const timeout = this.localTimeouts.get(run.id)
    if (timeout) clearTimeout(timeout)
    this.localTimeouts.delete(run.id)
    this.runners[run.execution ?? 'simulated'].kill(run.id)
    const w = this.world
    const agent = w.agents[run.agentId]
    const task = w.tasks[run.taskId]
    const output = completion.status === 'succeeded' ? completion.output ?? createRunOutput(run, completion.agent) : null
    this.discardWorkdir(run, this.workdirs.get(run.id)?.root ?? w.sandboxes[run.sandboxId]?.host)
    this.workdirs.delete(run.id)
    this.patchRun(run.id, {
      status: completion.status,
      endedAt: run.execution === 'local' ? Date.now() : w.now,
      progress: completion.status === 'succeeded' && run.execution !== 'local' ? 1 : run.progress,
      output,
      error: completion.status === 'succeeded' ? null : completion.reason,
    })
    const sb = w.sandboxes[run.sandboxId]
    if (sb && sb.leases.some((l) => l.runId === run.id)) {
      this.patchSandbox(sb.id, { leases: sb.leases.filter((l) => l.runId !== run.id) })
    }
    if (completion.status === 'succeeded') {
      if (agent) this.patchAgent(agent.id, { completed: agent.completed + 1 })
      if (task) this.patchTask(task.id, { status: 'succeeded' })
      this.log('info', `run finished: ${run.title}`, { runId: run.id, agentId: run.agentId })
      this.event('run', { kind: 'run', id: run.id }, `${this.nameOf(run.agentId)} finished “${run.title}”`)
      // A local run that was already finishing when its flow was cancelled still succeeds, but hands nothing on.
      if (output && !(task && this.openRecord(task.flowId)?.cancel)) {
        const prompt = outputText(output)
        for (const e of Object.values(w.edges)) {
          if (e.kind === 'handoff' && e.source === run.agentId) {
            this.enqueueTaskSilently(e.target as AgentId, {
              title: `${run.title} → ${this.nameOf(e.target)}`, prompt, priority: task?.priority ?? 'normal',
              origin: { kind: 'handoff', from: run.agentId, runId: run.id }, input: { ...output, runId: run.id },
            }, task?.flowId ?? (this.uid('fl') as FlowId))
          }
        }
      }
    } else if (completion.status === 'cancelled') {
      if (task) this.patchTask(task.id, { status: 'cancelled', retryAt: null, blockedOn: null })
      this.log('info', `run cancelled: ${run.title}`, { runId: run.id, agentId: run.agentId })
      this.event('run', { kind: 'run', id: run.id }, `${this.nameOf(run.agentId)} cancelled “${run.title}”`)
    } else if (completion.status === 'failed' && task && agent) {
      const canRetry = (completion.retryable ?? true) && task.attempts < agent.retry.maxAttempts
      if (canRetry) {
        const delay = agent.retry.backoff === 'exponential' ? agent.retry.backoffMs * 2 ** (task.attempts - 1) : agent.retry.backoffMs
        this.patchTask(task.id, { status: 'waiting', retryAt: w.now + delay, blockedOn: `retry ${task.attempts + 1}/${agent.retry.maxAttempts} in ${Math.round(delay / 1000)}s` })
        this.log('warn', `run failed (${completion.reason}); retrying attempt ${task.attempts + 1}/${agent.retry.maxAttempts} in ${Math.round(delay / 1000)}s`, { runId: run.id, agentId: run.agentId })
        this.event('run', { kind: 'run', id: run.id }, `${agent.name} failed “${run.title}” (${completion.reason}), retrying`)
      } else {
        this.patchTask(task.id, { status: 'failed', blockedOn: null })
        this.patchAgent(agent.id, { failed: agent.failed + 1, status: agent.status === 'paused' ? 'paused' : 'error' })
        this.log('error', `run failed permanently (${completion.reason}): ${run.title}`, { runId: run.id, agentId: run.agentId })
        this.event('run', { kind: 'run', id: run.id }, `${agent.name} gave up on “${run.title}” (${completion.reason})`)
      }
    }
    this.refreshAgentStatus(run.agentId)
  }

  private runningCount(agentId: AgentId) {
    return Object.values(this.world.runs).filter((r) => r.agentId === agentId && r.status === 'running').length
  }

  private refreshAgentStatus(agentId: AgentId) {
    const ag = this.world.agents[agentId]
    if (!ag || ag.status === 'paused') return
    const running = this.runningCount(agentId)
    if (running > 0 && ag.status !== 'working') this.patchAgent(agentId, { status: 'working' })
    if (running === 0 && ag.status === 'working') this.patchAgent(agentId, { status: 'idle' })
  }

  /**
   * Phase 1 holds an issue's task while its intake record lists unfinished
   * Linear blockers, then resolves dependency outcomes for every pending task from task
   * records (never agent or run status), so terminal prerequisite failures
   * cannot hide behind paused, full, or retrying agents. Phase 2 runs the
   * existing admission checks (priority, concurrency, pause, retry deadline,
   * sandbox capacity) for tasks whose dependencies allow them to proceed.
   */
  private schedule() {
    const w = this.world
    const edges = Object.values(w.edges)
    const dependsSources = new Map<AgentId, Set<AgentId>>()
    for (const e of edges) {
      if (e.kind !== 'depends-on') continue
      const set = dependsSources.get(e.target as AgentId) ?? new Set<AgentId>()
      set.add(e.source as AgentId)
      dependsSources.set(e.target as AgentId, set)
    }
    const depBlocked = new Set<TaskId>()
    // one index per pass: dependency matching scans flow/agent buckets instead of
    // rescanning all tasks per pending task. Statuses are read fresh from w.tasks
    // below, so cancellations made earlier in this pass stay visible.
    const tasksByFlowAgent = new Map<FlowId, Map<AgentId, Task[]>>()
    for (const t of Object.values(w.tasks)) {
      const byAgent = tasksByFlowAgent.get(t.flowId) ?? new Map<AgentId, Task[]>()
      const bucket = byAgent.get(t.agentId) ?? []
      bucket.push(t)
      byAgent.set(t.agentId, bucket)
      tasksByFlowAgent.set(t.flowId, byAgent)
    }
    // an issue's flow waits for the issue's blockers in Linear until its first run starts
    const issueBlocked = new Map<FlowId, string>()
    for (const record of Object.values(w.intake)) {
      const reason = record.phase === 'taken' && record.cancel === null ? blockedReason(record.blockers) : null
      if (reason) issueBlocked.set(record.flowId, reason)
    }
    const pending = Object.values(w.tasks).filter((t) => t.status === 'queued' || t.status === 'waiting')
    for (const task of pending) {
      if (task.origin.kind === 'issue') {
        const reason = issueBlocked.get(task.flowId)
        if (reason) {
          if (task.status !== 'waiting' || task.blockedOn !== reason) this.patchTask(task.id, { status: 'waiting', blockedOn: reason })
          depBlocked.add(task.id)
          continue
        }
        // blockers cleared: back to the queue so admission reasons show through
        if (task.blockedOn?.startsWith('blocked by')) this.patchTask(task.id, { status: 'queued', blockedOn: null })
      }
      const sources = dependsSources.get(task.agentId)
      if (!sources) {
        // the agent lost its depends-on edges: a stale waiting-on reason must not survive the pass
        if (task.blockedOn?.startsWith('waiting on')) this.patchTask(task.id, { blockedOn: null })
        continue
      }
      const byAgent = tasksByFlowAgent.get(task.flowId)
      const matches = (byAgent ? [...sources].flatMap((a) => byAgent.get(a) ?? []) : [])
        .filter((t) => t.id !== task.id)
        .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      const terminal = matches.map((m) => w.tasks[m.id]).find((m) => m.status === 'failed' || m.status === 'cancelled')
      if (terminal) {
        // re-read the record: an earlier cancellation or start this pass must not be overwritten
        const cur = w.tasks[task.id]
        if (!cur || (cur.status !== 'queued' && cur.status !== 'waiting')) continue
        this.patchTask(task.id, { status: 'cancelled', retryAt: null, blockedOn: null })
        this.event('task', { kind: 'task', id: task.id },
          `Cancelled “${task.title}” (task ${task.id}, flow ${task.flowId}): prerequisite “${terminal.title}” (task ${terminal.id}) ${terminal.status}`)
        continue
      }
      const active = matches.map((m) => w.tasks[m.id]).filter((m) => m.status === 'queued' || m.status === 'waiting' || m.status === 'running')
      if (active.length > 0) {
        const names = active.map((m) => `“${m.title}” (task ${m.id})`).join(', ')
        this.patchTask(task.id, { status: 'waiting', blockedOn: `waiting on ${names}` })
        depBlocked.add(task.id)
      } else if (task.blockedOn?.startsWith('waiting on')) {
        // dependencies cleared: drop the stale reason so admission reasons show through
        this.patchTask(task.id, { blockedOn: null })
      }
      // all matches succeeded, or no matches exist: eligible for admission
    }
    for (const agent of Object.values(w.agents)) {
      if (agent.status === 'paused') continue
      let free = agent.concurrency - this.runningCount(agent.id)
      const pending = Object.values(w.tasks)
        .filter((t) => t.agentId === agent.id && (t.status === 'queued' || t.status === 'waiting'))
        .sort((x, y) => PRIORITY_RANK[x.priority] - PRIORITY_RANK[y.priority] || x.createdAt - y.createdAt)
      for (const task of pending) {
        if (free <= 0) break
        if (depBlocked.has(task.id)) continue
        if (task.retryAt !== null && task.retryAt > w.now) continue
        // least-loaded attached sandbox with room; the reduce keeps edge insertion
        // order on ties, so an idle Coder still picks mac-studio before builder-a
        const attached = edges.filter((e) => e.kind === 'runs-in' && e.source === agent.id)
        const candidates = attached
          .map((e) => w.sandboxes[e.target as SandboxId])
          .filter((x): x is Sandbox => !!x && x.state === 'running' && x.leases.length < x.capacity)
        const sandbox = candidates.length === 0 ? undefined : candidates.reduce((best, x) => (x.leases.length < best.leases.length ? x : best))
        if (!sandbox) {
          this.patchTask(task.id, { status: 'waiting', blockedOn: attached.length > 0 ? 'no free sandbox' : 'no sandbox attached' })
          continue
        }
        this.startRun(agent, task, sandbox)
        free -= 1
      }
    }
  }

  private startRun(agent: Agent, task: Task, sandbox: Sandbox) {
    const id = this.uid('run') as RunId
    const runner = sandbox.kind === 'local' ? this.localRunner : this.runners.simulated
    const execution = runner.execution
    const startedAt = execution === 'local' ? Date.now() : this.world.now
    const run: Run = {
      id, taskId: task.id, agentId: agent.id, sandboxId: sandbox.id, title: task.title, attempt: task.attempts + 1,
      status: 'running', execution, progress: execution === 'local' ? null : 0, durationMs: execution === 'local' ? null : this.rand(7000, 18000), startedAt, endedAt: null, tokens: 0,
      output: null, error: null,
    }
    this.world.runs = { ...this.world.runs, [id]: run }
    this.patchTask(task.id, { status: 'running', attempts: task.attempts + 1, retryAt: null, blockedOn: null })
    this.patchSandbox(sandbox.id, { leases: [...sandbox.leases, { agentId: agent.id, runId: id, since: startedAt }] })
    this.patchAgent(agent.id, { status: 'working' })
    this.log('info', `run started on ${sandbox.name} (attempt ${run.attempt}): ${task.title}`, { runId: id, agentId: agent.id })
    if (task.input) {
      const n = task.input.artifacts.length
      const upstream = task.origin.kind === 'handoff' ? this.nameOf(task.origin.from) : 'upstream'
      this.log('info', `input: ${n} artifact${n === 1 ? '' : 's'} from ${upstream} run ${task.input.runId.slice(-6)}`, { runId: id, agentId: agent.id })
    }
    if (task.origin.kind === 'issue') {
      for (const line of this.openRecord(task.flowId)?.leftOut ?? []) this.log('warn', `left out of the prompt: ${line}`, { runId: id, agentId: agent.id })
    }
    this.event('run', { kind: 'run', id }, `${agent.name} started “${task.title}” on ${sandbox.name}`)
    if (execution === 'local') {
      const timeout = setTimeout(() => {
        const active = this.world.runs[id]
        if (!active || active.status !== 'running') return
        this.log('error', `run exceeded timeout of ${Math.round(agent.timeoutMs / 1000)}s`, { runId: id, agentId: agent.id }, Date.now())
        this.finishRun(active, { status: 'failed', reason: 'timeout' })
        this.publish()
      }, agent.timeoutMs)
      timeout.unref?.()
      this.localTimeouts.set(id, timeout)
      const delivery = agent.delivery === 'pull-request' ? this.deliveryRequest(task, id, agent.id) : Promise.resolve(null)
      const setup = delivery.then((request) => {
        this.writePrompt(task, request !== null)
        return prepareWorkdir(sandbox.host, id, request)
      }).then((workdir) => {
        if (this.closed || this.world.runs[id]?.status !== 'running') return
        this.workdirs.set(id, workdir)
        const branch = workdir.delivery ? ` on branch ${workdir.delivery.branch} from origin/${workdir.delivery.base}` : ''
        this.log('info', `working directory: ${workdir.path}${branch}`, { runId: id, agentId: agent.id }, Date.now())
        this.publish()
        this.runners.local.start({ run, agent, task: this.world.tasks[task.id] ?? task, workdir: workdir.path }, (event) => this.handleRunnerEvent(id, event))
      }).catch((error: unknown) => {
        if (this.closed) return
        this.handleRunnerEvent(id, { kind: 'complete', status: 'failed', result: null, reason: error instanceof Error ? error.message : String(error) })
      })
      this.setups.set(id, setup)
      void setup.finally(() => this.setups.delete(id))
    } else this.runners.simulated.start({ run, agent, task, workdir: '' }, (event) => this.handleRunnerEvent(id, event))
  }

  /** Gives a local run its prompt before its worktree is prepared, during which a parallel run may save a merge (ADR 0012). */
  private writePrompt({ id, flowId }: Task, delivers: boolean) {
    const task = this.world.tasks[id]
    const prompt = task && runPrompt(task, this.openRecord(flowId), delivers)
    if (!task || prompt === task.prompt) return
    this.patchTask(id, { prompt })
    this.publish()
  }

  /**
   * A round that continues a pull request rereads the PR, which may have merged, closed, moved or been retargeted while the
   * round waited, and saves what changed, so the run's prompt, the round's note and its later runs follow it. A read that a
   * parallel run's save overtook is read once more, and a second such read fails the run rather than guess (ADR 0012).
   */
  private async deliveryRequest({ flowId }: Task, runId: RunId, agentId: AgentId): Promise<DeliveryRequest> {
    for (let reads = 1; ; reads++) {
      const seen = this.openRecord(flowId)?.rework
      if (seen?.kind !== 'continue') break
      const view = await viewPullRequest(seen.pr.url).catch((error: unknown) => {
        throw new Error(`delivery failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      if (this.closed || this.world.runs[runId]?.status !== 'running') throw new RunEnded()
      const record = this.openRecord(flowId)
      const reread = record ? rereadRework(record.rework, seen, view) : null
      if (reread === 'again' && reads === 2) throw new Error(`delivery failed: pull request #${prNumber(seen.pr)} changed again while this run read it`)
      if (reread === 'again') continue
      if (record && reread) {
        if (reread.rework.kind === 'fresh') {
          // A cancelled flow delivers nothing, so its record keeps saying how the round started.
          if (record.rework?.kind === 'continue' && !record.cancel) {
            const { branch } = record.rework
            const prBranches = record.prBranches.includes(branch) ? record.prBranches : [...record.prBranches, branch]
            this.world.intake = { ...this.world.intake, [record.issue.id]: { ...record, rework: reread.rework, prBranches } }
            this.log('info', `pull request #${prNumber(seen.pr)} ${reread.change}`, { runId, agentId }, Date.now())
            this.publish()
          }
          return { kind: 'new', branch: issueOfFlow(this.world, flowId)?.branchName ?? `factory-${runId}`, retired: this.openRecord(flowId)?.prBranches ?? [] }
        }
        this.world.intake = { ...this.world.intake, [record.issue.id]: { ...record, rework: reread.rework } }
        this.log('info', `pull request #${prNumber(seen.pr)} ${reread.change}`, { runId, agentId }, Date.now())
        this.publish()
      }
      break
    }
    const rework = this.openRecord(flowId)?.rework
    if (rework?.kind === 'continue') return { kind: 'continue', pr: rework.pr, branch: rework.branch, base: rework.base }
    return { kind: 'new', branch: issueOfFlow(this.world, flowId)?.branchName ?? `factory-${runId}`, retired: this.openRecord(flowId)?.prBranches ?? [] }
  }

  private nameOf(id: string): string {
    const w = this.world
    return w.agents[id as AgentId]?.name ?? w.sandboxes[id as SandboxId]?.name ?? w.triggers[id as TriggerId]?.name ?? w.groups[id as GroupId]?.name ?? id
  }

  private nextFreePosition(): Position {
    const n = Object.keys(this.world.sandboxes).length
    return { x: 320 + (n % 4) * 320, y: 680 }
  }

  private nextGroupName(): string {
    const used = new Set(Object.values(this.world.groups).map((g) => g.name))
    let n = 1
    while (used.has(`Group ${n}`)) n++
    return `Group ${n}`
  }
}

type Persisted = Pick<World, 'now' | 'agents' | 'sandboxes' | 'triggers' | 'edges' | 'groups' | 'sim' | 'tasks' | 'runs' | 'intake' | 'events'>

const persisted = object<Persisted>({
  now: number,
  agents: record(id<AgentId>(), agent),
  sandboxes: record(id<SandboxId>(), sandbox),
  triggers: record(id<TriggerId>(), trigger),
  edges: record(id<EdgeId>(), edge),
  groups: record(id<GroupId>(), group),
  tasks: record(id<TaskId>(), task),
  runs: record(id<RunId>(), run),
  intake: defaulted(record(id<IssueId>(), intakeRecord), () => ({})),
  sim: object({ paused: boolean, speed: oneOf(1, 2, 4) }),
  events: array(event),
})

/**
 * The save payload for a world: what survives a restart. Logs never do. Every
 * running run is kept plus the newest MAX_COMPLETED_RUNS finished runs; tasks
 * are kept when they are pending, referenced by a kept run, or share a flow
 * with a kept queued/waiting task, so post-restart dependency evaluation sees
 * the same prerequisites. The intake map is kept whole: it is what stops an
 * issue from starting a second flow after its tasks are pruned. Returned
 * slices alias the live world and must be serialized or copied before the
 * world mutates.
 */
export function retainWorld(w: World): Persisted {
  const runs: World['runs'] = {}
  for (const run of Object.values(w.runs)) if (run.status === 'running') runs[run.id] = run
  const completed = Object.values(w.runs)
    .filter((run) => run.status !== 'running')
    .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_COMPLETED_RUNS)
  for (const run of completed) runs[run.id] = run

  const runTaskIds = new Set(Object.values(runs).map((run) => run.taskId))
  const pendingFlowIds = new Set(
    Object.values(w.tasks).filter((t) => t.status === 'queued' || t.status === 'waiting').map((t) => t.flowId),
  )
  const tasks: World['tasks'] = {}
  for (const task of Object.values(w.tasks)) {
    const pending = task.status === 'queued' || task.status === 'waiting'
    if (task.status === 'running' || pending || runTaskIds.has(task.id) || pendingFlowIds.has(task.flowId)) tasks[task.id] = task
  }

  const membered = new Set<string>()
  for (const a of Object.values(w.agents)) if (a.groupId) membered.add(a.groupId)
  for (const s of Object.values(w.sandboxes)) if (s.groupId) membered.add(s.groupId)
  for (const t of Object.values(w.triggers)) if (t.groupId) membered.add(t.groupId)
  const groups = Object.fromEntries(Object.entries(w.groups).filter(([id]) => membered.has(id))) as World['groups']

  return {
    now: w.now,
    agents: w.agents,
    sandboxes: w.sandboxes,
    triggers: w.triggers,
    edges: w.edges,
    groups,
    sim: w.sim,
    tasks,
    runs,
    intake: w.intake,
    events: w.events.slice(-MAX_EVENTS),
  }
}

/**
 * Normalization for a node record coming back from a save or an undo: runtime
 * state (live status, leases, metric history, trigger schedule) starts fresh,
 * everything else returns as captured.
 */
function restoredAgent(a: Agent): Agent {
  return { ...a, status: a.status === 'paused' ? 'paused' : 'idle', groupId: a.groupId ?? null }
}

function restoredSandbox(s: Sandbox, now: number): Sandbox {
  return { ...s, capacity: isCapacity(s.capacity) ? s.capacity : 1, leases: [], history: [], stateSince: now, groupId: s.groupId ?? null }
}

function restoredTrigger(t: Trigger): Trigger {
  return { ...t, lastFiredAt: null, groupId: t.groupId ?? null }
}

/** A stored record readied for the live world again: the reload normalization, under its own id. */
function restoredNode(ref: NodeRef, now: number): NodeRef {
  switch (ref.kind) {
    case 'agent': return { kind: 'agent', node: restoredAgent(ref.node) }
    case 'sandbox': return { kind: 'sandbox', node: restoredSandbox(ref.node, now) }
    case 'trigger': return { kind: 'trigger', node: restoredTrigger(ref.node) }
  }
}

/** Configuration only, under a new id. Runtime state starts as a new node's, except that a paused agent stays paused. */
function pastedNode(ref: NodeRef, id: string, offset: Position, now: number): NodeRef {
  const position = { x: ref.node.position.x + offset.x, y: ref.node.position.y + offset.y }
  switch (ref.kind) {
    case 'agent': {
      const { name, role, model, temperature, concurrency, timeoutMs, retry, tools, systemPrompt, delivery, status } = ref.node
      return {
        kind: 'agent',
        node: {
          id: id as AgentId, name, role, model, temperature, concurrency, timeoutMs, retry: { ...retry }, tools: [...tools], systemPrompt, delivery,
          status: status === 'paused' ? 'paused' : 'idle', position, completed: 0, failed: 0, groupId: null,
        },
      }
    }
    case 'sandbox': {
      const { name, kind, host, image, capacity } = ref.node
      return {
        kind: 'sandbox',
        node: {
          id: id as SandboxId, name, kind, host, image, capacity: isCapacity(capacity) ? capacity : 1, state: 'provisioning', stateSince: now, progress: 0,
          metrics: { cpu: 0, mem: 0, disk: 4 }, history: [], leases: [], restartPending: false, position, groupId: null,
        },
      }
    }
    case 'trigger': {
      const { name, kind, intervalMs, enabled, template, linear } = ref.node
      return {
        kind: 'trigger',
        node: {
          id: id as TriggerId, name, kind, intervalMs, enabled: kind === 'linear' ? false : enabled, template, linear: linear && { ...linear },
          lastFiredAt: null, fired: 0, position, groupId: null,
        },
      }
    }
  }
}

/** A saved world document ready to run, or null when it is not one. */
function parseWorld(text: string): World | null {
  const parsed: unknown = JSON.parse(text)
  let p: Persisted
  try {
    p = persisted(parsed, 'world')
  } catch {
    return null
  }
  const now = p.now
  const agents = Object.fromEntries(Object.entries(p.agents).map(([id, a]) => [id, restoredAgent(a)])) as World['agents']
  const sandboxes = Object.fromEntries(Object.entries(p.sandboxes).map(([id, s]) => [id, restoredSandbox(s, now)])) as World['sandboxes']
  const triggers = Object.fromEntries(Object.entries(p.triggers).map(([id, t]) => [id, restoredTrigger(t)])) as World['triggers']
  return {
    now,
    agents,
    sandboxes,
    triggers,
    edges: p.edges,
    groups: p.groups,
    tasks: p.tasks,
    runs: p.runs,
    intake: p.intake,
    intakePolls: {},
    logs: [],
    events: p.events,
    sim: p.sim,
  }
}
