import type {
  Agent, AgentId, Edge, EdgeId, EdgeKind, GraphFragment, Group, GroupId, NodeId, NodeKind, NodeRef, Position, Priority, SandboxAction, SandboxId, SandboxKind, TaskId, Trigger, TriggerId, World,
} from '../domain/types'

export type MaybePromise<T> = T | PromiseLike<T>

export type ConnectResult = { ok: true; id: EdgeId } | { ok: false; reason: string }

export type Api = {
  subscribe: (fn: (world: World) => void) => () => void
  graph: {
    updatePositions: (moves: Array<{ id: NodeId; position: Position }>) => MaybePromise<void>
    createNode: (kind: NodeKind, position: Position) => MaybePromise<NodeId>
    deleteNodes: (ids: NodeId[]) => MaybePromise<void>
    connect: (source: NodeId, target: NodeId, preferred: EdgeKind | null) => MaybePromise<ConnectResult>
    setEdgeKind: (id: EdgeId, kind: EdgeKind) => MaybePromise<void>
    removeEdges: (ids: EdgeId[]) => MaybePromise<void>
    restoreNodes: (nodes: NodeRef[]) => MaybePromise<void>
    restoreEdges: (edges: Edge[]) => MaybePromise<void>
    paste: (fragment: GraphFragment, offset: Position) => MaybePromise<GraphFragment>
    group: (ids: NodeId[]) => MaybePromise<GroupId | null>
    ungroup: (id: GroupId) => MaybePromise<void>
    restoreGroup: (group: Group, memberIds: NodeId[]) => MaybePromise<void>
  }
  groups: {
    update: (id: GroupId, patch: { name: string }) => MaybePromise<void>
  }
  agents: {
    update: (id: AgentId, patch: Partial<Omit<Agent, 'id' | 'status' | 'position' | 'groupId'>>) => MaybePromise<void>
    setPaused: (id: AgentId, paused: boolean) => MaybePromise<void>
    enqueue: (id: AgentId, input: { title: string; prompt: string; priority: Priority }) => MaybePromise<TaskId>
  }
  tasks: {
    cancel: (id: TaskId) => MaybePromise<void>
  }
  sandboxes: {
    act: (id: SandboxId, action: SandboxAction) => MaybePromise<void>
    create: (input: { name: string; kind: SandboxKind; host: string; image: string; capacity?: number }) => MaybePromise<SandboxId>
    update: (id: SandboxId, patch: { capacity: number }) => MaybePromise<void>
  }
  triggers: {
    update: (id: TriggerId, patch: Partial<Omit<Trigger, 'id' | 'position' | 'groupId'>>) => MaybePromise<void>
    fire: (id: TriggerId) => MaybePromise<void>
  }
  sim: {
    set: (patch: Partial<World['sim']>) => MaybePromise<void>
    reset: () => MaybePromise<void>
  }
}
