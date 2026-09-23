import type {
  AgentId, AgentPatch, Edge, EdgeId, EdgeKind, GraphFragment, Group, GroupId, NodeId, NodeKind, NodeRef, Position, Priority, SandboxAction, SandboxId, SandboxKind, TaskId, Trigger, TriggerId, World,
} from '../domain/types'
import type { Api, ConnectResult } from './types'

export type { Api, ConnectResult }

export type Link = 'connecting' | 'up' | 'down'

const configured = import.meta.env.VITE_FACTORY_SERVER
const httpBase = configured || ''
const wsUrl = configured
  ? `${configured.replace(/^http/, 'ws')}/world`
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/world`

type Snapshot = { rev: number; world: World }

const listeners = new Set<(world: World) => void>()
const linkListeners = new Set<(link: Link) => void>()
let latest: Snapshot | null = null
let link: Link = 'connecting'
let socket: WebSocket | null = null
let started = false

function setLink(next: Link) {
  if (link === next) return
  link = next
  for (const fn of linkListeners) fn(link)
}

function apply(rev: number, world: World) {
  if (latest && rev < latest.rev) return
  latest = { rev, world }
  for (const fn of listeners) fn(world)
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('rev' in value) || !('world' in value)) return null
  if (typeof value.rev !== 'number' || typeof value.world !== 'object' || value.world === null) return null
  return { rev: value.rev, world: value.world as World }
}

async function command(method: string, args: unknown[]): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${httpBase}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }),
    })
  } catch {
    setLink('down')
    throw new Error('disconnected from server')
  }
  if (response.status === 403) throw new Error('forbidden origin')
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('ok' in body)) throw new Error('bad response')
  if (body.ok !== true) {
    const error = 'error' in body && typeof body.error === 'string' ? body.error : 'command failed'
    throw new Error(error)
  }
  const snap = parseSnapshot(body)
  if (!snap) throw new Error('bad response')
  apply(snap.rev, snap.world)
  return 'result' in body ? body.result : undefined
}

export function subscribeLink(fn: (next: Link) => void) {
  linkListeners.add(fn)
  fn(link)
  return () => { linkListeners.delete(fn) }
}

export function startClient() {
  if (started) return
  started = true
  socket = new WebSocket(wsUrl)
  socket.addEventListener('open', () => setLink('up'))
  socket.addEventListener('message', (event) => {
    const snap = parseSnapshot(JSON.parse(String(event.data)))
    if (snap) apply(snap.rev, snap.world)
  })
  socket.addEventListener('close', () => setLink('down'))
  socket.addEventListener('error', () => setLink('down'))
}

function call<T>(method: string, args: unknown[]): Promise<T> {
  return command(method, args) as Promise<T>
}

export const api: Api = {
  subscribe: (fn) => {
    listeners.add(fn)
    if (latest) fn(latest.world)
    return () => { listeners.delete(fn) }
  },
  graph: {
    updatePositions: (moves) => call('graph.updatePositions', [moves]),
    createNode: (kind: NodeKind, position: Position) => call<NodeId>('graph.createNode', [kind, position]),
    deleteNodes: (ids: NodeId[]) => call('graph.deleteNodes', [ids]),
    connect: (source: NodeId, target: NodeId, preferred: EdgeKind | null) => call<ConnectResult>('graph.connect', [source, target, preferred]),
    setEdgeKind: (id: EdgeId, kind: EdgeKind) => call('graph.setEdgeKind', [id, kind]),
    removeEdges: (ids: EdgeId[]) => call('graph.removeEdges', [ids]),
    restoreNodes: (nodes: NodeRef[]) => call('graph.restoreNodes', [nodes]),
    restoreEdges: (edges: Edge[]) => call('graph.restoreEdges', [edges]),
    paste: (fragment: GraphFragment, offset: Position) => call<GraphFragment>('graph.paste', [fragment, offset]),
    group: (ids: NodeId[]) => call<GroupId | null>('graph.group', [ids]),
    ungroup: (id: GroupId) => call('graph.ungroup', [id]),
    restoreGroup: (group: Group, memberIds: NodeId[]) => call('graph.restoreGroup', [group, memberIds]),
  },
  groups: {
    update: (id: GroupId, patch: { name: string }) => call('groups.update', [id, patch]),
  },
  agents: {
    update: (id: AgentId, patch: AgentPatch) => call('agents.update', [id, patch]),
    setPaused: (id: AgentId, paused: boolean) => call('agents.setPaused', [id, paused]),
    enqueue: (id: AgentId, input: { title: string; prompt: string; priority: Priority }) => call<TaskId>('agents.enqueue', [id, input]),
  },
  tasks: {
    cancel: (id: TaskId) => call('tasks.cancel', [id]),
  },
  sandboxes: {
    act: (id: SandboxId, action: SandboxAction) => call('sandboxes.act', [id, action]),
    create: (input: { name: string; kind: SandboxKind; host: string; image: string; capacity?: number }) => call<SandboxId>('sandboxes.create', [input]),
    update: (id: SandboxId, patch: { capacity: number }) => call('sandboxes.update', [id, patch]),
  },
  triggers: {
    update: (id: TriggerId, patch: Partial<Omit<Trigger, 'id' | 'position' | 'groupId'>>) => call('triggers.update', [id, patch]),
    fire: (id: TriggerId) => call('triggers.fire', [id]),
  },
  sim: {
    set: (patch: Partial<World['sim']>) => call('sim.set', [patch]),
    reset: () => call('sim.reset', []),
  },
}
