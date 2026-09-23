import type {
  AgentId, AgentPatch, EdgeKind, GraphFragment, Group, GroupId, NodeId, NodeKind, NodeRef, Position, Priority, SandboxAction, SandboxId, Trigger, TriggerId,
} from '../src/domain/types'
import type { MockServer } from './simulation'

type Command = (simulation: MockServer, args: readonly unknown[]) => unknown

function at<T>(args: readonly unknown[], index: number): T {
  return args[index] as T
}

const commands: Record<string, Command> = {
  'graph.updatePositions': (s, a) => s.updatePositions(at(a, 0)),
  'graph.createNode': (s, a) => s.createNode(at<NodeKind>(a, 0), at<Position>(a, 1)),
  'graph.deleteNodes': (s, a) => s.deleteNodes(at<NodeId[]>(a, 0)),
  'graph.connect': (s, a) => s.connect(at<NodeId>(a, 0), at<NodeId>(a, 1), at<EdgeKind | null>(a, 2)),
  'graph.setEdgeKind': (s, a) => s.setEdgeKind(at(a, 0), at<EdgeKind>(a, 1)),
  'graph.removeEdges': (s, a) => s.removeEdges(at(a, 0)),
  'graph.restoreNodes': (s, a) => s.restoreNodes(at<NodeRef[]>(a, 0)),
  'graph.restoreEdges': (s, a) => s.restoreEdges(at(a, 0)),
  'graph.paste': (s, a) => s.paste(at<GraphFragment>(a, 0), at<Position>(a, 1)),
  'graph.group': (s, a) => s.group(at<NodeId[]>(a, 0)),
  'graph.ungroup': (s, a) => s.ungroup(at<GroupId>(a, 0)),
  'graph.restoreGroup': (s, a) => s.restoreGroup(at<Group>(a, 0), at<NodeId[]>(a, 1)),
  'groups.update': (s, a) => s.updateGroup(at<GroupId>(a, 0), at(a, 1)),
  'agents.update': (s, a) => s.updateAgent(at<AgentId>(a, 0), at<AgentPatch>(a, 1)),
  'agents.setPaused': (s, a) => s.setAgentPaused(at<AgentId>(a, 0), at<boolean>(a, 1)),
  'agents.enqueue': (s, a) => s.enqueueTask(at<AgentId>(a, 0), at<{ title: string; prompt: string; priority: Priority }>(a, 1)),
  'tasks.cancel': (s, a) => s.cancelTask(at(a, 0)),
  'sandboxes.act': (s, a) => s.sandboxAction(at<SandboxId>(a, 0), at<SandboxAction>(a, 1)),
  'sandboxes.create': (s, a) => s.createSandbox(at(a, 0)),
  'sandboxes.update': (s, a) => s.updateSandbox(at<SandboxId>(a, 0), at(a, 1)),
  'triggers.update': (s, a) => s.updateTrigger(at<TriggerId>(a, 0), at<Partial<Omit<Trigger, 'id' | 'position' | 'groupId'>>>(a, 1)),
  'triggers.fire': (s, a) => s.fireTrigger(at<TriggerId>(a, 0)),
  'sim.set': (s, a) => s.setSim(at(a, 0)),
  'sim.reset': (s) => s.reset(),
}

export function runCommand(simulation: MockServer, method: string, args: readonly unknown[]): unknown {
  const command = commands[method]
  if (!command) throw new Error(`unknown command ${method}`)
  return command(simulation, args)
}
