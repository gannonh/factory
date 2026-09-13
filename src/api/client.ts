/**
 * The API surface the UI talks to. Today it is backed by the in-browser mock server;
 * swapping in HTTP + a websocket means reimplementing this object and nothing else.
 */
import { mockServer } from './mockServer'
import type {
  Agent, AgentId, EdgeId, EdgeKind, NodeId, NodeKind, Position, Priority, SandboxAction, SandboxId, SandboxKind, TaskId, Trigger, TriggerId, World,
} from '../domain/types'

export const api = {
  subscribe: (fn: (world: World) => void) => mockServer.subscribe(fn),
  graph: {
    updatePositions: (moves: Array<{ id: NodeId; position: Position }>) => mockServer.updatePositions(moves),
    createNode: (kind: NodeKind, position: Position) => mockServer.createNode(kind, position),
    deleteNodes: (ids: NodeId[]) => mockServer.deleteNodes(ids),
    connect: (source: NodeId, target: NodeId, preferred: EdgeKind | null) => mockServer.connect(source, target, preferred),
    setEdgeKind: (id: EdgeId, kind: EdgeKind) => mockServer.setEdgeKind(id, kind),
    removeEdges: (ids: EdgeId[]) => mockServer.removeEdges(ids),
  },
  agents: {
    update: (id: AgentId, patch: Partial<Omit<Agent, 'id' | 'status' | 'position'>>) => mockServer.updateAgent(id, patch),
    setPaused: (id: AgentId, paused: boolean) => mockServer.setAgentPaused(id, paused),
    enqueue: (id: AgentId, input: { title: string; prompt: string; priority: Priority }) => mockServer.enqueueTask(id, input),
  },
  tasks: {
    cancel: (id: TaskId) => mockServer.cancelTask(id),
  },
  sandboxes: {
    act: (id: SandboxId, action: SandboxAction) => mockServer.sandboxAction(id, action),
    create: (input: { name: string; kind: SandboxKind; host: string; image: string }) => mockServer.createSandbox(input),
  },
  triggers: {
    update: (id: TriggerId, patch: Partial<Omit<Trigger, 'id' | 'position'>>) => mockServer.updateTrigger(id, patch),
    fire: (id: TriggerId) => mockServer.fireTrigger(id),
  },
  sim: {
    set: (patch: Partial<World['sim']>) => mockServer.setSim(patch),
    reset: () => mockServer.reset(),
  },
}
