import {
  EDGE_KINDS, MODELS, SANDBOX_TRANSITIONS, isCapacity,
  type Agent, type AgentId, type Artifact, type Edge, type EdgeId, type FactoryEvent, type FlowId, type Group, type GroupId,
  type Lease, type Metrics, type NodeId, type Position, type Priority, type RetryPolicy, type Run, type RunId,
  type RunOutput, type Sandbox, type SandboxId, type SandboxKind, type SandboxState, type Subject,
  type Task, type TaskId, type TaskInput, type Trigger, type TriggerId, type TriggerKind,
} from '../src/domain/types'
import { array, boolean, id, nullable, number, object, oneOf, refine, string, tagged, type Parser } from './parse'
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
const triggerKind: Parser<TriggerKind> = oneOf('cron', 'webhook', 'manual', 'event')
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
  completed: number,
  failed: number,
}

export const agent = object<Agent>({
  ...agentFields,
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

export const triggerFields = {
  name: string,
  kind: triggerKind,
  intervalMs: number,
  enabled: boolean,
  lastFiredAt: nullable(number),
  fired: number,
  template: string,
}

export const trigger = object<Trigger>({ ...triggerFields, id: triggerId, position, groupId: nullable(groupId) })

export const edge = object<Edge>({ id: edgeId, kind: edgeKind, source: nodeId, target: nodeId })

export const group = object<Group>({ id: groupId, name: string })

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
