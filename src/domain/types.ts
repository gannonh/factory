export type AgentId = string & { readonly __brand: 'AgentId' }
export type SandboxId = string & { readonly __brand: 'SandboxId' }
export type TriggerId = string & { readonly __brand: 'TriggerId' }
export type EdgeId = string & { readonly __brand: 'EdgeId' }
export type TaskId = string & { readonly __brand: 'TaskId' }
export type RunId = string & { readonly __brand: 'RunId' }
export type FlowId = string & { readonly __brand: 'FlowId' }
export type GroupId = string & { readonly __brand: 'GroupId' }
export type IssueId = string & { readonly __brand: 'IssueId' }

export type NodeId = AgentId | SandboxId | TriggerId
export type Position = { x: number; y: number }

export type ModelName =
  | 'claude-fable-5-1'
  | 'claude-opus-5'
  | 'claude-sonnet-5'
  | 'claude-haiku-4-5-20251001'

export const MODELS: ModelName[] = [
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]

export type AgentStatus = 'idle' | 'working' | 'paused' | 'error'

export type RetryPolicy = { maxAttempts: number; backoffMs: number; backoff: 'fixed' | 'exponential' }

/** What Factory does with a succeeded local run's commits: nothing, or push the branch and open a pull request (ADR 0009). */
export type Delivery = 'none' | 'pull-request'
export const DELIVERIES: Delivery[] = ['none', 'pull-request']

export type Agent = {
  id: AgentId
  name: string
  role: string
  model: ModelName
  temperature: number
  concurrency: number
  timeoutMs: number
  retry: RetryPolicy
  tools: string[]
  systemPrompt: string
  delivery: Delivery
  status: AgentStatus
  position: Position
  completed: number
  failed: number
  groupId: GroupId | null
}

/** The editable agent fields. `retry` merges into the current policy, so each retry field is written on its own. */
export type AgentPatch = Partial<Omit<Agent, 'id' | 'status' | 'position' | 'groupId' | 'retry'>> & { retry?: Partial<RetryPolicy> }

export type SandboxKind = 'local' | 'docker' | 'vps' | 'remote'

/** Lifecycle state machine; SANDBOX_TRANSITIONS is the only place the edges live. */
export type SandboxState =
  | 'provisioning'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'rebuilding'
  | 'destroying'
  | 'error'

export type SandboxAction = 'start' | 'stop' | 'restart' | 'rebuild' | 'destroy'

export const SANDBOX_TRANSITIONS: Record<SandboxState, Partial<Record<SandboxAction, SandboxState>>> = {
  provisioning: { destroy: 'destroying' },
  running: { stop: 'stopping', restart: 'stopping', rebuild: 'rebuilding', destroy: 'destroying' },
  stopping: {},
  stopped: { start: 'provisioning', rebuild: 'rebuilding', destroy: 'destroying' },
  rebuilding: { destroy: 'destroying' },
  destroying: {},
  error: { start: 'provisioning', rebuild: 'rebuilding', destroy: 'destroying' },
}

/** Timed states advance automatically after this many ms of simulated time. */
export const SANDBOX_TIMED: Partial<Record<SandboxState, { durationMs: number; next: SandboxState }>> = {
  provisioning: { durationMs: 6000, next: 'running' },
  stopping: { durationMs: 2000, next: 'stopped' },
  rebuilding: { durationMs: 9000, next: 'running' },
  destroying: { durationMs: 1500, next: 'stopped' },
}

export type Metrics = { cpu: number; mem: number; disk: number }

export type Lease = { agentId: AgentId; runId: RunId; since: number }

export type Sandbox = {
  id: SandboxId
  name: string
  kind: SandboxKind
  host: string
  image: string
  state: SandboxState
  stateSince: number
  /** Only meaningful in timed states, 0..1 */
  progress: number
  metrics: Metrics
  history: Metrics[]
  /** runs currently hosted; may exceed `capacity` after a capacity decrease */
  leases: Lease[]
  /** admission limit for new leases; changing it never evicts running runs */
  capacity: number
  /** set when a restart was requested; stopping -> stopped -> provisioning */
  restartPending: boolean
  position: Position
  groupId: GroupId | null
}

/** The admission-limit rule for `Sandbox.capacity`. */
export const isCapacity = (v: number) => Number.isInteger(v) && v >= 1

export type TriggerKind = 'cron' | 'webhook' | 'manual' | 'event' | 'linear'

/**
 * Linear ids chosen in the trigger inspector. A null project takes every issue in the team.
 * The lifecycle states are where write-back moves a taken issue; null leaves the issue alone.
 */
export type LinearSettings = {
  team: string
  project: string | null
  pickupState: string
  startedState: string | null
  finishedState: string | null
  failedState: string | null
}

/** The settings that choose which issues intake takes. */
export type IssueFilter = Pick<LinearSettings, 'team' | 'project' | 'pickupState'>

export const LINEAR_POLL_MS = 30_000

export type Trigger = {
  id: TriggerId
  name: string
  kind: TriggerKind
  /** cron & event triggers fire every intervalMs of simulated time */
  intervalMs: number
  enabled: boolean
  lastFiredAt: number | null
  fired: number
  template: string
  /** set only when `kind` is `linear`, and only once a team and pickup state are chosen */
  linear: LinearSettings | null
  position: Position
  groupId: GroupId | null
}

export type IssueRef = { backend: 'linear'; id: IssueId; identifier: string; url: string; branchName: string }

/** Where a write to Linear stands. `at` is wall-clock ms. A dropped move is never sent: the issue left Factory's states before it landed. */
export type WriteStatus = { state: 'pending' } | { state: 'landed'; at: number } | { state: 'failed'; at: number; error: string } | { state: 'dropped' }

/**
 * One write-back to the taken issue. A note's body and comment id are fixed when the write becomes due. The body is dropped once the note lands.
 * An attach links one pull request a run delivered to the issue, keyed by its URL.
 */
export type IssueWrite =
  | { kind: 'move'; step: 'started' | 'finished' | 'failed'; stateId: string; status: WriteStatus }
  | { kind: 'note'; outcome: 'finished' | 'failed' | 'cancelled'; commentId: string; body: string | null; status: WriteStatus }
  | { kind: 'attach'; url: string; title: string; status: WriteStatus }

/** How far the issue's flow has gone: no run yet, a run started, or every task terminal. */
export type IntakePhase = 'taken' | 'started' | 'ended'

/** Why an issue's flow was cancelled: the issue left the trigger's states in Linear, or an operator cancelled one of its tasks. */
export type FlowCancel = { kind: 'linear'; reason: string } | { kind: 'factory'; task: string }

/** The states a Linear trigger works in. An issue that leaves them while its flow is open cancels the flow. */
export type TriggerStates = Pick<LinearSettings, 'pickupState' | 'startedState'>

/**
 * One issue taken by intake. Retention never prunes these, so an issue never starts a second flow.
 * `writes` is the ordered write-back queue; each phase change appends to it and nothing removes from it.
 * `states` are the trigger's states when it took the issue, or null for a record saved before they were kept.
 */
export type IntakeRecord = {
  issue: IssueRef; trigger: TriggerId; flowId: FlowId; takenAt: number; phase: IntakePhase; writes: IssueWrite[]
  states: TriggerStates | null; cancel: FlowCancel | null
}

export type IntakeError = { kind: 'missing-key' | 'auth' | 'network' | 'api'; message: string }

/** The latest finished poll of one Linear trigger. Runtime only: not saved. `at` is wall-clock ms. */
export type IntakePoll = { at: number; error: IntakeError | null }

export type WorkflowStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
export type WorkflowState = { id: string; name: string; type: WorkflowStateType; position: number }
export type LinearTeam = { id: string; key: string; name: string; states: WorkflowState[]; projects: Array<{ id: string; name: string }> }
export type LinearCatalog = { teams: LinearTeam[] }
export type IntakePreview = { count: number; issues: Array<{ identifier: string; title: string; url: string }> }

export type RecommendedStates = Pick<LinearSettings, 'startedState' | 'finishedState' | 'failedState'> & { pickupState: string | null }

/**
 * Epic decision 8, by position: pickup is the first `unstarted` state with the word Start, else the
 * first `unstarted` state (Todo). A Start state is the explicit signal to build, so a workflow
 * that has one keeps Todo as a queue. Started is the first `started` state (In Progress),
 * finished is the first `started` state named like review, and failed leaves the issue where it is.
 */
export function recommendedStates(states: readonly WorkflowState[]): RecommendedStates {
  const ordered = [...states].sort((a, b) => a.position - b.position)
  const unstarted = ordered.filter((s) => s.type === 'unstarted')
  const started = ordered.filter((s) => s.type === 'started')
  return {
    pickupState: (unstarted.find((s) => /\bstart\b/i.test(s.name)) ?? unstarted[0])?.id ?? null,
    startedState: started[0]?.id ?? null,
    finishedState: started.find((s) => /review/i.test(s.name))?.id ?? null,
    failedState: null,
  }
}

/**
 * A kind change with the fields the server normalizes alongside it, so undo
 * records them: leaving `linear` clears its settings, and entering it disables
 * the trigger until the operator has seen the preview.
 */
export function triggerKindPatch(trigger: Trigger, kind: TriggerKind): Pick<Trigger, 'kind' | 'linear' | 'enabled'> {
  return kind === 'linear'
    ? { kind, linear: trigger.kind === 'linear' ? trigger.linear : null, enabled: trigger.kind === 'linear' && trigger.enabled }
    : { kind, linear: null, enabled: trigger.enabled }
}

export type Group = { id: GroupId; name: string }

export type NodeKind = 'agent' | 'sandbox' | 'trigger'

export type EdgeKind = 'triggers' | 'handoff' | 'depends-on' | 'runs-in'

export type EdgeRule = { from: NodeKind; to: NodeKind; label: string; color: string; dash: string }

/** Which node kinds each edge kind may join. Connection validation and rendering both read this. */
export const EDGE_RULES: Record<EdgeKind, EdgeRule> = {
  triggers: { from: 'trigger', to: 'agent', label: 'triggers', color: '#34d399', dash: '' },
  handoff: { from: 'agent', to: 'agent', label: 'handoff', color: '#a78bfa', dash: '' },
  'depends-on': { from: 'agent', to: 'agent', label: 'depends on', color: '#fbbf24', dash: '8 6' },
  'runs-in': { from: 'agent', to: 'sandbox', label: 'runs in', color: '#22d3ee', dash: '2 5' },
}

export const EDGE_KINDS = Object.keys(EDGE_RULES) as EdgeKind[]

export type Edge = {
  id: EdgeId
  kind: EdgeKind
  source: NodeId
  target: NodeId
}

export type Priority = 'low' | 'normal' | 'high'

export type TaskStatus = 'queued' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type Task = {
  id: TaskId
  /** flow this task belongs to; minted at manual enqueue or trigger firing, inherited on handoff */
  flowId: FlowId
  agentId: AgentId
  title: string
  prompt: string
  priority: Priority
  status: TaskStatus
  origin:
    | { kind: 'trigger'; id: TriggerId }
    | { kind: 'issue'; trigger: TriggerId; issue: IssueRef }
    | { kind: 'handoff'; from: AgentId; runId: RunId }
    | { kind: 'manual' }
  input: TaskInput | null
  createdAt: number
  attempts: number
  /** set after a failed attempt; the scheduler skips the task until this simulated time */
  retryAt: number | null
  /** why it is waiting, for the queue view */
  blockedOn: string | null
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export type ArtifactKind = 'branch' | 'commit' | 'pr' | 'file' | 'note'

export type Artifact = {
  kind: ArtifactKind
  label: string
  url: string | null
}

export type RunOutput = {
  summary: string
  artifacts: Artifact[]
}

export type TaskInput = RunOutput & { runId: RunId }

export type Run = {
  id: RunId
  taskId: TaskId
  agentId: AgentId
  sandboxId: SandboxId
  title: string
  attempt: number
  status: RunStatus
  execution: 'simulated' | 'local'
  progress: number | null
  durationMs: number | null
  startedAt: number
  endedAt: number | null
  tokens: number
  output: RunOutput | null
  error: string | null
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export type LogLine = {
  id: number
  ts: number
  level: LogLevel
  runId: RunId | null
  agentId: AgentId | null
  msg: string
}

export type Subject =
  | { kind: 'agent'; id: AgentId }
  | { kind: 'sandbox'; id: SandboxId }
  | { kind: 'trigger'; id: TriggerId }
  | { kind: 'run'; id: RunId }
  | { kind: 'task'; id: TaskId }
  | { kind: 'edge'; id: EdgeId }
  | { kind: 'group'; id: GroupId }

export type EventKind = 'agent' | 'sandbox' | 'trigger' | 'run' | 'graph' | 'task'

export type FactoryEvent = {
  id: number
  ts: number
  kind: EventKind
  subject: Subject
  msg: string
}

export type World = {
  now: number
  agents: Record<AgentId, Agent>
  sandboxes: Record<SandboxId, Sandbox>
  triggers: Record<TriggerId, Trigger>
  edges: Record<EdgeId, Edge>
  groups: Record<GroupId, Group>
  tasks: Record<TaskId, Task>
  runs: Record<RunId, Run>
  intake: Record<IssueId, IntakeRecord>
  intakePolls: Record<TriggerId, IntakePoll>
  logs: LogLine[]
  events: FactoryEvent[]
  sim: { paused: boolean; speed: 1 | 2 | 4 }
}

export type NodeRef = { kind: 'agent'; node: Agent } | { kind: 'sandbox'; node: Sandbox } | { kind: 'trigger'; node: Trigger }

export function nodeKindOf(world: World, id: string): NodeKind | null {
  if (id in world.agents) return 'agent'
  if (id in world.sandboxes) return 'sandbox'
  if (id in world.triggers) return 'trigger'
  return null
}

export function nodeRef(world: World, id: NodeId): NodeRef | null {
  switch (nodeKindOf(world, id)) {
    case 'agent': return { kind: 'agent', node: world.agents[id as AgentId] }
    case 'sandbox': return { kind: 'sandbox', node: world.sandboxes[id as SandboxId] }
    case 'trigger': return { kind: 'trigger', node: world.triggers[id as TriggerId] }
    default: return null
  }
}

/** The subject naming a graph node, so callers stop rebuilding the kind-to-subject ternary. */
export function nodeSubject(kind: NodeKind, id: NodeId): Subject {
  switch (kind) {
    case 'agent': return { kind, id: id as AgentId }
    case 'sandbox': return { kind, id: id as SandboxId }
    case 'trigger': return { kind, id: id as TriggerId }
  }
}

/** Resolve a subject against the world: the subject while its record exists, otherwise null. Used by event clicks and selection cleanup. */
export function existingSubject(world: World, subject: Subject): Subject | null {
  switch (subject.kind) {
    case 'agent': return world.agents[subject.id] ? subject : null
    case 'sandbox': return world.sandboxes[subject.id] ? subject : null
    case 'trigger': return world.triggers[subject.id] ? subject : null
    case 'run': return world.runs[subject.id] ? subject : null
    case 'task': return world.tasks[subject.id] ? subject : null
    case 'edge': return world.edges[subject.id] ? subject : null
    case 'group': return world.groups[subject.id] ? subject : null
  }
}

export function taskOriginLabel(world: World, origin: Task['origin']): string {
  switch (origin.kind) {
    case 'trigger': return world.triggers[origin.id]?.name ?? 'trigger'
    case 'issue': return origin.issue.identifier
    case 'handoff': return `handoff from ${world.agents[origin.from]?.name ?? 'agent'}`
    case 'manual': return 'manual'
  }
}

export function issueOfFlow(world: World, flowId: FlowId): IssueRef | null {
  return Object.values(world.intake).find((r) => r.flowId === flowId)?.issue ?? null
}

export function edgeKindFor(from: NodeKind, to: NodeKind): EdgeKind[] {
  return EDGE_KINDS.filter((k) => EDGE_RULES[k].from === from && EDGE_RULES[k].to === to)
}

/** Edges with an endpoint among `ids`; deleting a node takes these with it. */
export function attachedEdges(world: World, ids: Iterable<NodeId>): Edge[] {
  const endpoints = new Set<string>(ids)
  return Object.values(world.edges).filter((e) => endpoints.has(e.source) || endpoints.has(e.target))
}

/** Nodes plus the edges that travel with them: what copy holds, and what paste takes and returns. */
export type GraphFragment = { nodes: NodeRef[]; edges: Edge[] }

/** The nodes in `ids` and only the edges whose source and target are both in `ids`. */
export function fragmentOf(world: World, ids: Iterable<NodeId>): GraphFragment {
  const nodes = [...new Set(ids)].map((id) => nodeRef(world, id)).filter((ref) => ref !== null)
  const inside = new Set<string>(nodes.map((ref) => ref.node.id))
  return { nodes, edges: Object.values(world.edges).filter((e) => inside.has(e.source) && inside.has(e.target)) }
}

export const AGENT_STATUS_COLOR: Record<AgentStatus, string> = {
  idle: '#64748b',
  working: '#22d3ee',
  paused: '#fbbf24',
  error: '#f87171',
}

export const SANDBOX_STATE_COLOR: Record<SandboxState, string> = {
  provisioning: '#38bdf8',
  running: '#34d399',
  stopping: '#fbbf24',
  stopped: '#64748b',
  rebuilding: '#a78bfa',
  destroying: '#f87171',
  error: '#f87171',
}

export const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  queued: '#94a3b8',
  waiting: '#fbbf24',
  running: '#22d3ee',
  succeeded: '#34d399',
  failed: '#f87171',
  cancelled: '#64748b',
}

export const LOG_LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '#64748b',
  info: '#cbd5e1',
  warn: '#fbbf24',
  error: '#f87171',
}
