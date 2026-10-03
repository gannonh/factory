import {
  DELIVERIES, EDGE_KINDS, MODELS, SANDBOX_TRANSITIONS, isCapacity,
  type Agent, type AgentId, type Artifact, type Edge, type EdgeId, type FactoryEvent, type FlowId, type Group, type GroupId,
  type FlowCancel, type IntakeRecord, type IssueFilter, type IssueId, type IssueWrite, type IssueRef, type Lease, type LinearSettings, type Metrics, type NodeId, type Position, type Priority, type RetryPolicy, type Run, type RunId, type TriggerStates,
  type RunOutput, type Sandbox, type SandboxId, type SandboxKind, type SandboxState, type Subject,
  type Task, type TaskId, type TaskInput, type Trigger, type TriggerId, type TriggerKind, type WriteStatus,
} from '../src/domain/types'
import { array, boolean, defaulted, id, nullable, number, object, oneOf, refine, string, tagged, type Parser } from './parse'
import { isRestorableInteger } from './storedNumber'

export const nodeId = id<NodeId>()
export const agentId = id<AgentId>()
export const sandboxId = id<SandboxId>()
export const triggerId = id<TriggerId>()
export const edgeId = id<EdgeId>()
export const groupId = id<GroupId>()

export const edgeKind = oneOf(...EDGE_KINDS)
export const priority: Parser<Priority> = oneOf('low', 'normal', 'high')
export const sandboxKind: Parser<SandboxKind> = oneOf('local', 'docker', 'vps', 'remote')
const sandboxState = oneOf(...(Object.keys(SANDBOX_TRANSITIONS) as SandboxState[]))
const triggerKind: Parser<TriggerKind> = oneOf('cron', 'webhook', 'manual', 'event', 'linear')
export const capacity = refine(number, isCapacity, 'an integer of at least 1')

export const position = object<Position>({ x: number, y: number })

export const retryFields = { maxAttempts: number, backoffMs: number, backoff: oneOf('fixed', 'exponential') }

export const agentFields = {
  name: string,
  role: string,
  model: oneOf(...MODELS),
  temperature: number,
  concurrency: number,
  timeoutMs: number,
  tools: array(string),
  systemPrompt: string,
  delivery: oneOf(...DELIVERIES),
  completed: number,
  failed: number,
}

// `delivery` arrived after worlds were first saved; ADR 0002 has no migrations, so it defaults to off.
export const agent = object<Agent>({
  ...agentFields,
  delivery: defaulted(agentFields.delivery, () => 'none' as const),
  id: agentId,
  retry: object<RetryPolicy>(retryFields),
  status: oneOf('idle', 'working', 'paused', 'error'),
  position,
  groupId: nullable(groupId),
})

const metrics = object<Metrics>({ cpu: number, mem: number, disk: number })

export const sandbox = object<Sandbox>({
  id: sandboxId,
  name: string,
  kind: sandboxKind,
  host: string,
  image: string,
  state: sandboxState,
  stateSince: number,
  progress: number,
  metrics,
  history: array(metrics),
  leases: array(object<Lease>({ agentId, runId: id<RunId>(), since: number })),
  capacity,
  restartPending: boolean,
  position,
  groupId: nullable(groupId),
})

const lifecycleState = defaulted(nullable(string), () => null)

// The lifecycle states arrived after Linear settings were first saved, so they default to leaving the issue alone.
export const linearSettings = object<LinearSettings>({
  team: string,
  project: nullable(string),
  pickupState: string,
  startedState: lifecycleState,
  finishedState: lifecycleState,
  failedState: lifecycleState,
})

export const issueFilter = object<IssueFilter>({ team: string, project: nullable(string), pickupState: string })

export const triggerFields = {
  name: string,
  kind: triggerKind,
  intervalMs: number,
  enabled: boolean,
  lastFiredAt: nullable(number),
  fired: number,
  template: string,
  linear: nullable(linearSettings),
}

// `linear` arrived after worlds were first saved; ADR 0002 has no migrations, so it defaults.
export const trigger = object<Trigger>({ ...triggerFields, linear: defaulted(triggerFields.linear, () => null), id: triggerId, position, groupId: nullable(groupId) })

export const edge = object<Edge>({ id: edgeId, kind: edgeKind, source: nodeId, target: nodeId })

export const group = object<Group>({ id: groupId, name: string })

export const issueRef = object<IssueRef>({ backend: oneOf('linear'), id: id<IssueId>(), identifier: string, url: string, branchName: string })

const taskId = id<TaskId>()
const runId = id<RunId>()
const artifact = object<Artifact>({ kind: oneOf('branch', 'commit', 'pr', 'file', 'note'), label: string, url: nullable(string) })
const outputFields = { summary: string, artifacts: array(artifact) }
const output = object<RunOutput>(outputFields)
const input = object<TaskInput>({ ...outputFields, runId })
const origin = tagged<Task['origin']>({
  manual: object({ kind: oneOf('manual') }),
  trigger: object({ kind: oneOf('trigger'), id: triggerId }),
  handoff: object({ kind: oneOf('handoff'), from: agentId, runId }),
  issue: object({ kind: oneOf('issue'), trigger: triggerId, issue: issueRef }),
})

export const task = object<Task>({
  id: taskId,
  flowId: id<FlowId>(),
  agentId,
  title: string,
  prompt: string,
  priority,
  status: oneOf('queued', 'waiting', 'running', 'succeeded', 'failed', 'cancelled'),
  origin,
  input: nullable(input),
  createdAt: number,
  attempts: number,
  retryAt: nullable(number),
  blockedOn: nullable(string),
})

export const run = object<Run>({
  id: runId,
  taskId,
  agentId,
  sandboxId,
  title: string,
  attempt: number,
  status: oneOf('running', 'succeeded', 'failed', 'cancelled'),
  execution: oneOf('simulated', 'local'),
  progress: nullable(number),
  durationMs: nullable(number),
  startedAt: number,
  endedAt: nullable(number),
  tokens: number,
  output: nullable(output),
  error: nullable(string),
})

const writeStatuses: { [S in WriteStatus['state']]: Parser<Extract<WriteStatus, { state: S }>> } = {
  pending: object({ state: oneOf('pending') }),
  landed: object({ state: oneOf('landed'), at: number }),
  failed: object({ state: oneOf('failed'), at: number, error: string }),
  dropped: object({ state: oneOf('dropped') }),
}
const writeState = oneOf('pending', 'landed', 'failed', 'dropped')
const writeStatus: Parser<WriteStatus> = (value, path) =>
  writeStatuses[writeState((value as { state?: unknown } | null)?.state, `${path}.state`)](value, path)

const issueWrite = tagged<IssueWrite>({
  move: object({ kind: oneOf('move'), step: oneOf('started', 'finished', 'failed'), stateId: string, status: writeStatus }),
  note: object({ kind: oneOf('note'), outcome: oneOf('finished', 'failed', 'cancelled'), commentId: string, body: nullable(string), status: writeStatus }),
  attach: object({ kind: oneOf('attach'), url: string, title: string, status: writeStatus }),
})

// A record saved before write-back counts as ended with nothing to write, so upgrading never posts notes for older flows.
export const intakeRecord = object<IntakeRecord>({
  issue: issueRef,
  trigger: triggerId,
  flowId: id<FlowId>(),
  takenAt: number,
  phase: defaulted(oneOf('taken', 'started', 'ended'), () => 'ended' as const),
  writes: defaulted(array(issueWrite), () => []),
  states: defaulted(nullable(object<TriggerStates>({ pickupState: string, startedState: nullable(string) })), () => null),
  cancel: defaulted(nullable(tagged<FlowCancel>({
    linear: object({ kind: oneOf('linear'), reason: string }),
    factory: object({ kind: oneOf('factory'), task: string }),
  })), () => null),
})

const subject = tagged<Subject>({
  agent: object({ kind: oneOf('agent'), id: agentId }),
  sandbox: object({ kind: oneOf('sandbox'), id: sandboxId }),
  trigger: object({ kind: oneOf('trigger'), id: triggerId }),
  run: object({ kind: oneOf('run'), id: runId }),
  task: object({ kind: oneOf('task'), id: taskId }),
  edge: object({ kind: oneOf('edge'), id: edgeId }),
  group: object({ kind: oneOf('group'), id: groupId }),
})

export const event = object<FactoryEvent>({
  id: refine(number, isRestorableInteger, 'a restorable integer'),
  ts: number,
  kind: oneOf('agent', 'sandbox', 'trigger', 'run', 'graph', 'task'),
  subject,
  msg: string,
})
