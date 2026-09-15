/**
 * The API surface the UI talks to. Today it is backed by the in-browser mock server;
 * swapping in HTTP + a websocket means reimplementing this object and nothing else.
 */
import { mockServer, MockServer } from './mockServer'
import type {
  Agent, AgentId, EdgeId, EdgeKind, NodeId, NodeKind, Position, Priority, SandboxAction, SandboxId, SandboxKind, TaskId, Trigger, TriggerId, World,
} from '../domain/types'

const buildApi = (server: MockServer) => ({
  subscribe: (fn: (world: World) => void) => server.subscribe(fn),
  graph: {
    updatePositions: (moves: Array<{ id: NodeId; position: Position }>) => server.updatePositions(moves),
    createNode: (kind: NodeKind, position: Position) => server.createNode(kind, position),
    deleteNodes: (ids: NodeId[]) => server.deleteNodes(ids),
    connect: (source: NodeId, target: NodeId, preferred: EdgeKind | null) => server.connect(source, target, preferred),
    setEdgeKind: (id: EdgeId, kind: EdgeKind) => server.setEdgeKind(id, kind),
    removeEdges: (ids: EdgeId[]) => server.removeEdges(ids),
  },
  agents: {
    update: (id: AgentId, patch: Partial<Omit<Agent, 'id' | 'status' | 'position'>>) => server.updateAgent(id, patch),
    setPaused: (id: AgentId, paused: boolean) => server.setAgentPaused(id, paused),
    enqueue: (id: AgentId, input: { title: string; prompt: string; priority: Priority }) => server.enqueueTask(id, input),
  },
  tasks: {
    cancel: (id: TaskId) => server.cancelTask(id),
  },
  sandboxes: {
    act: (id: SandboxId, action: SandboxAction) => server.sandboxAction(id, action),
    create: (input: { name: string; kind: SandboxKind; host: string; image: string }) => server.createSandbox(input),
  },
  triggers: {
    update: (id: TriggerId, patch: Partial<Omit<Trigger, 'id' | 'position'>>) => server.updateTrigger(id, patch),
    fire: (id: TriggerId) => server.fireTrigger(id),
  },
  sim: {
    set: (patch: Partial<World['sim']>) => server.setSim(patch),
    /** advance simulated time by `ms` and run one tick; manual-mode servers only */
    advance: (ms: number) => server.advance(ms),
    reset: () => server.reset(),
  },
})

export type Api = ReturnType<typeof buildApi>

/** Create an API bound to a server instance; tests use this with a manual-mode server. */
export const createApi = (server: MockServer) => buildApi(server)

export const api = buildApi(mockServer)
