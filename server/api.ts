import type { MockServer } from './simulation'
import type {
  Agent, AgentId, Edge, EdgeId, EdgeKind, GraphFragment, Group, GroupId, NodeId, NodeKind, NodeRef, Position, Priority, SandboxAction, SandboxId, SandboxKind, TaskId, Trigger, TriggerId, World,
} from '../src/domain/types'

/** In-process binding for tests. `advance` stays here and is not a network command. */
export const createApi = (server: MockServer) => ({
  subscribe: (fn: (world: World) => void) => server.subscribe(fn),
  graph: {
    updatePositions: (moves: Array<{ id: NodeId; position: Position }>) => server.updatePositions(moves),
    createNode: (kind: NodeKind, position: Position) => server.createNode(kind, position),
    deleteNodes: (ids: NodeId[]) => server.deleteNodes(ids),
    connect: (source: NodeId, target: NodeId, preferred: EdgeKind | null) => server.connect(source, target, preferred),
    setEdgeKind: (id: EdgeId, kind: EdgeKind) => server.setEdgeKind(id, kind),
    removeEdges: (ids: EdgeId[]) => server.removeEdges(ids),
    restoreNodes: (nodes: NodeRef[]) => server.restoreNodes(nodes),
    restoreEdges: (edges: Edge[]) => server.restoreEdges(edges),
    paste: (fragment: GraphFragment, offset: Position) => server.paste(fragment, offset),
    group: (ids: NodeId[]) => server.group(ids),
    ungroup: (id: GroupId) => server.ungroup(id),
    restoreGroup: (group: Group, memberIds: NodeId[]) => server.restoreGroup(group, memberIds),
  },
  groups: {
    update: (id: GroupId, patch: { name: string }) => server.updateGroup(id, patch),
  },
  agents: {
    update: (id: AgentId, patch: Partial<Omit<Agent, 'id' | 'status' | 'position' | 'groupId'>>) => server.updateAgent(id, patch),
    setPaused: (id: AgentId, paused: boolean) => server.setAgentPaused(id, paused),
    enqueue: (id: AgentId, input: { title: string; prompt: string; priority: Priority }) => server.enqueueTask(id, input),
  },
  tasks: {
    cancel: (id: TaskId) => server.cancelTask(id),
  },
  sandboxes: {
    act: (id: SandboxId, action: SandboxAction) => server.sandboxAction(id, action),
    create: (input: { name: string; kind: SandboxKind; host: string; image: string; capacity?: number }) => server.createSandbox(input),
    update: (id: SandboxId, patch: { capacity: number }) => server.updateSandbox(id, patch),
  },
  triggers: {
    update: (id: TriggerId, patch: Partial<Omit<Trigger, 'id' | 'position' | 'groupId'>>) => server.updateTrigger(id, patch),
    fire: (id: TriggerId) => server.fireTrigger(id),
  },
  sim: {
    set: (patch: Partial<World['sim']>) => server.setSim(patch),
    advance: (ms: number) => server.advance(ms),
    reset: () => server.reset(),
  },
})

export type InProcessApi = ReturnType<typeof createApi>
