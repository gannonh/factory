import {
  EDGE_KINDS, MODELS, SANDBOX_TRANSITIONS, isCapacity,
  type Agent, type AgentId, type AgentPatch, type Edge, type EdgeId, type GraphFragment, type Group, type GroupId, type Lease, type Metrics, type NodeId, type NodeKind,
  type NodeRef, type Position, type Priority, type RetryPolicy, type RunId, type Sandbox, type SandboxAction, type SandboxId, type SandboxKind, type SandboxState,
  type TaskId, type Trigger, type TriggerId, type TriggerKind, type World,
} from '../src/domain/types'
import { args, array, boolean, id, nullable, number, object, oneOf, optional, partial, refine, string, tagged, type Parser } from './parse'
import type { MockServer } from './simulation'

const nodeId = id<NodeId>()
const agentId = id<AgentId>()
const sandboxId = id<SandboxId>()
const triggerId = id<TriggerId>()
const edgeId = id<EdgeId>()
const groupId = id<GroupId>()

const nodeKind: Parser<NodeKind> = oneOf('agent', 'sandbox', 'trigger')
const edgeKind = oneOf(...EDGE_KINDS)
const priority: Parser<Priority> = oneOf('low', 'normal', 'high')
const sandboxKind: Parser<SandboxKind> = oneOf('local', 'docker', 'vps', 'remote')
const sandboxState = oneOf(...(Object.keys(SANDBOX_TRANSITIONS) as SandboxState[]))
const sandboxAction: Parser<SandboxAction> = oneOf('start', 'stop', 'restart', 'rebuild', 'destroy')
const triggerKind: Parser<TriggerKind> = oneOf('cron', 'webhook', 'manual', 'event')
const capacity = refine(number, isCapacity, 'an integer of at least 1')

const position = object<Position>({ x: number, y: number })

const retryFields = { maxAttempts: number, backoffMs: number, backoff: oneOf('fixed', 'exponential') }

const agentFields = {
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

const agent = object<Agent>({
  ...agentFields,
  id: agentId,
  retry: object<RetryPolicy>(retryFields),
  status: oneOf('idle', 'working', 'paused', 'error'),
  position,
  groupId: nullable(groupId),
})

const agentPatch = partial<AgentPatch>({ ...agentFields, retry: partial<RetryPolicy>(retryFields) })

const metrics = object<Metrics>({ cpu: number, mem: number, disk: number })

const sandbox = object<Sandbox>({
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

const triggerFields = {
  name: string,
  kind: triggerKind,
  intervalMs: number,
  enabled: boolean,
  lastFiredAt: nullable(number),
  fired: number,
  template: string,
}

const trigger = object<Trigger>({ ...triggerFields, id: triggerId, position, groupId: nullable(groupId) })

const triggerPatch = partial<Omit<Trigger, 'id' | 'position' | 'groupId'>>(triggerFields)

const edge = object<Edge>({ id: edgeId, kind: edgeKind, source: nodeId, target: nodeId })

const group = object<Group>({ id: groupId, name: string })

const nodeRef = tagged<NodeRef>({
  agent: object({ kind: oneOf('agent'), node: agent }),
  sandbox: object({ kind: oneOf('sandbox'), node: sandbox }),
  trigger: object({ kind: oneOf('trigger'), node: trigger }),
})

const fragment = object<GraphFragment>({ nodes: array(nodeRef), edges: array(edge) })

const simPatch = partial<World['sim']>({ paused: boolean, speed: oneOf(1, 2, 4) })

// Split so a malformed payload is rejected before anything reaches the simulation.
type Command = (raw: unknown) => (simulation: MockServer) => unknown

function command<T extends unknown[]>(parse: Parser<T>, run: (simulation: MockServer, args: T) => unknown): Command {
  return (raw) => {
    const parsed = parse(raw, 'args')
    return (simulation) => run(simulation, parsed)
  }
}

const commands: Record<string, Command> = {
  'graph.updatePositions': command(args(array(object({ id: nodeId, position }))), (s, [moves]) => s.updatePositions(moves)),
  'graph.createNode': command(args(nodeKind, position), (s, [kind, at]) => s.createNode(kind, at)),
  'graph.deleteNodes': command(args(array(nodeId)), (s, [ids]) => s.deleteNodes(ids)),
  'graph.connect': command(args(nodeId, nodeId, nullable(edgeKind)), (s, [source, target, preferred]) => s.connect(source, target, preferred)),
  'graph.setEdgeKind': command(args(edgeId, edgeKind), (s, [id, kind]) => s.setEdgeKind(id, kind)),
  'graph.removeEdges': command(args(array(edgeId)), (s, [ids]) => s.removeEdges(ids)),
  'graph.restoreNodes': command(args(array(nodeRef)), (s, [nodes]) => s.restoreNodes(nodes)),
  'graph.restoreEdges': command(args(array(edge)), (s, [edges]) => s.restoreEdges(edges)),
  'graph.paste': command(args(fragment, position), (s, [pasted, offset]) => s.paste(pasted, offset)),
  'graph.group': command(args(array(nodeId)), (s, [ids]) => s.group(ids)),
  'graph.ungroup': command(args(groupId), (s, [id]) => s.ungroup(id)),
  'graph.restoreGroup': command(args(group, array(nodeId)), (s, [restored, memberIds]) => s.restoreGroup(restored, memberIds)),
  'groups.update': command(args(groupId, object({ name: string })), (s, [id, patch]) => s.updateGroup(id, patch)),
  'agents.update': command(args(agentId, agentPatch), (s, [id, patch]) => s.updateAgent(id, patch)),
  'agents.setPaused': command(args(agentId, boolean), (s, [id, paused]) => s.setAgentPaused(id, paused)),
  'agents.enqueue': command(
    args(agentId, object({ title: string, prompt: string, priority })),
    (s, [id, input]) => s.enqueueTask(id, input),
  ),
  'tasks.cancel': command(args(id<TaskId>()), (s, [id]) => s.cancelTask(id)),
  'sandboxes.act': command(args(sandboxId, sandboxAction), (s, [id, action]) => s.sandboxAction(id, action)),
  'sandboxes.create': command(
    args(object<Parameters<MockServer['createSandbox']>[0]>({ name: string, kind: sandboxKind, host: string, image: string, capacity: optional(capacity) })),
    (s, [input]) => s.createSandbox(input),
  ),
  'sandboxes.update': command(args(sandboxId, object({ capacity })), (s, [id, patch]) => s.updateSandbox(id, patch)),
  'triggers.update': command(args(triggerId, triggerPatch), (s, [id, patch]) => s.updateTrigger(id, patch)),
  'triggers.fire': command(args(triggerId), (s, [id]) => s.fireTrigger(id)),
  'sim.set': command(args(simPatch), (s, [patch]) => s.setSim(patch)),
  'sim.reset': command(args(), (s) => s.reset()),
}

export function runCommand(simulation: MockServer, method: string, raw: readonly unknown[]): unknown {
  const command = commands[method]
  if (!command) throw new Error(`unknown command ${method}`)
  let call: ReturnType<Command>
  try {
    call = command(raw)
  } catch (err: unknown) {
    throw new Error(`${method}: ${err instanceof Error ? err.message : 'bad arguments'}`)
  }
  return call(simulation)
}
