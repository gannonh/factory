/**
 * Session undo and redo for graph edits. Each wrapper reads the inverse from
 * the world before its write, records the edit as data, and replay calls the
 * raw API so ids stay stable across the stack.
 */
import type { Api } from './api/client'
import {
  nodeKindOf,
  type AgentId,
  type Edge,
  type EdgeId,
  type EdgeKind,
  type NodeId,
  type NodeKind,
  type NodeRef,
  type Position,
  type SandboxId,
  type TriggerId,
  type World,
} from './domain/types'

export const HISTORY_LIMIT = 100

type Move = { id: NodeId; position: Position }
type PatchTarget = 'agent' | 'trigger' | 'sandbox'

/**
 * A patch `key` is the top-level key the write touched (sorted keys joined by
 * `,` for a multi-key write); `before` and `after` hold the values of those keys.
 */
export type HistoryEntry =
  | { kind: 'create'; node: NodeRef }
  | { kind: 'delete'; nodes: NodeRef[]; attached: Edge[]; standalone: Edge[] }
  | { kind: 'connect'; edge: Edge }
  | { kind: 'remove-edges'; edges: Edge[] }
  | { kind: 'edge-kind'; id: EdgeId; before: EdgeKind; after: EdgeKind }
  | { kind: 'move'; before: Move[]; after: Move[] }
  | { kind: 'patch'; target: PatchTarget; id: NodeId; key: string; before: Record<string, unknown>; after: Record<string, unknown> }

/** Structural equality for JSON-like values: primitives, arrays and plain objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length
    && keys.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

function nodeRef(world: World, id: NodeId): NodeRef | null {
  switch (nodeKindOf(world, id)) {
    case 'agent': return { kind: 'agent', node: world.agents[id as AgentId] }
    case 'sandbox': return { kind: 'sandbox', node: world.sandboxes[id as SandboxId] }
    case 'trigger': return { kind: 'trigger', node: world.triggers[id as TriggerId] }
    default: return null
  }
}

export function createHistory(api: Api, getWorld: () => World) {
  const entries: HistoryEntry[] = []
  let cursor = 0
  // true while the top entry is a patch that the next same-key patch may extend
  let mergeable = false
  const listeners = new Set<() => void>()

  function notify() {
    for (const fn of listeners) fn()
  }

  function push(entry: HistoryEntry) {
    entries.length = cursor
    entries.push(entry)
    if (entries.length > HISTORY_LIMIT) entries.shift()
    cursor = entries.length
    mergeable = entry.kind === 'patch'
    notify()
  }

  function clear() {
    entries.length = 0
    cursor = 0
    mergeable = false
    notify()
  }

  function readPatch(target: PatchTarget, id: NodeId, keys: string[]): Record<string, unknown> | null {
    const w = getWorld()
    const record: Record<string, unknown> | undefined =
      target === 'agent' ? w.agents[id as AgentId] : target === 'sandbox' ? w.sandboxes[id as SandboxId] : w.triggers[id as TriggerId]
    return record ? Object.fromEntries(keys.map((k) => [k, record[k]])) : null
  }

  function writePatch(target: PatchTarget, id: NodeId, patch: object) {
    if (target === 'agent') api.agents.update(id as AgentId, patch)
    else if (target === 'sandbox') api.sandboxes.update(id as SandboxId, patch as { capacity: number })
    else api.triggers.update(id as TriggerId, patch)
  }

  function recordPatch(target: PatchTarget, id: NodeId, patch: object) {
    const keys = Object.keys(patch).sort()
    const before = readPatch(target, id, keys)
    writePatch(target, id, patch)
    const after = readPatch(target, id, keys)
    if (!before || !after || deepEqual(before, after)) return
    const key = keys.join(',')
    const top = entries[cursor - 1]
    if (!mergeable || top?.kind !== 'patch' || top.target !== target || top.id !== id || top.key !== key) {
      push({ kind: 'patch', target, id, key, before, after })
    } else if (deepEqual(top.before, after)) {
      // edited back to where the entry started: nothing left to undo
      cursor -= 1
      entries.length = cursor
      mergeable = false
      notify()
    } else {
      entries[cursor - 1] = { ...top, after }
    }
  }

  // delete replays skip ids that are already gone so the server logs no phantom delete
  function deleteExistingNodes(ids: NodeId[]) {
    const existing = ids.filter((id) => nodeKindOf(getWorld(), id) !== null)
    if (existing.length > 0) api.graph.deleteNodes(existing)
  }

  function removeExistingEdges(ids: EdgeId[]) {
    const existing = ids.filter((id) => getWorld().edges[id])
    if (existing.length > 0) api.graph.removeEdges(existing)
  }

  function revert(entry: HistoryEntry) {
    switch (entry.kind) {
      case 'create': return deleteExistingNodes([entry.node.node.id])
      case 'delete':
        api.graph.restoreNodes(entry.nodes)
        return api.graph.restoreEdges([...entry.attached, ...entry.standalone])
      case 'connect': return removeExistingEdges([entry.edge.id])
      case 'remove-edges': return api.graph.restoreEdges(entry.edges)
      case 'edge-kind': return api.graph.setEdgeKind(entry.id, entry.before)
      case 'move': return api.graph.updatePositions(entry.before)
      case 'patch': return writePatch(entry.target, entry.id, entry.before)
    }
  }

  function apply(entry: HistoryEntry) {
    switch (entry.kind) {
      case 'create': return api.graph.restoreNodes([entry.node])
      case 'delete':
        deleteExistingNodes(entry.nodes.map((ref) => ref.node.id))
        return removeExistingEdges(entry.standalone.map((e) => e.id))
      case 'connect': return api.graph.restoreEdges([entry.edge])
      case 'remove-edges': return removeExistingEdges(entry.edges.map((e) => e.id))
      case 'edge-kind': return api.graph.setEdgeKind(entry.id, entry.after)
      case 'move': return api.graph.updatePositions(entry.after)
      case 'patch': return writePatch(entry.target, entry.id, entry.after)
    }
  }

  return {
    undo: () => {
      if (cursor === 0) return
      cursor -= 1
      mergeable = false
      revert(entries[cursor])
      notify()
    },
    redo: () => {
      if (cursor === entries.length) return
      cursor += 1
      mergeable = false
      apply(entries[cursor - 1])
      notify()
    },
    /** Reset the simulation to the seed; the stack goes with the world it described. */
    reset: () => {
      api.sim.reset()
      clear()
    },
    clear,
    canUndo: () => cursor > 0,
    canRedo: () => cursor < entries.length,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    createNode: (kind: NodeKind, position: Position): NodeId => {
      const id = api.graph.createNode(kind, position)
      const ref = nodeRef(getWorld(), id)
      if (ref) push({ kind: 'create', node: ref })
      return id
    },
    /** One Delete keypress: the nodes, every edge attached to them, and separately selected edges. */
    delete: ({ nodeIds, edgeIds }: { nodeIds: NodeId[]; edgeIds: EdgeId[] }) => {
      const world = getWorld()
      const nodes = nodeIds.map((id) => nodeRef(world, id)).filter((ref) => ref !== null)
      const gone = new Set<string>(nodes.map((ref) => ref.node.id))
      const attached = Object.values(world.edges).filter((e) => gone.has(e.source) || gone.has(e.target))
      const standalone = edgeIds.map((id) => world.edges[id]).filter((e) => e && !attached.includes(e))
      if (nodes.length === 0 && standalone.length === 0) return
      if (nodes.length > 0) api.graph.deleteNodes(nodes.map((ref) => ref.node.id))
      if (standalone.length > 0) api.graph.removeEdges(standalone.map((e) => e.id))
      push({ kind: 'delete', nodes, attached, standalone })
    },
    connect: (source: NodeId, target: NodeId, preferred: EdgeKind | null) => {
      const result = api.graph.connect(source, target, preferred)
      if (result.ok) push({ kind: 'connect', edge: getWorld().edges[result.id] })
      return result
    },
    removeEdges: (ids: EdgeId[]) => {
      const world = getWorld()
      const edges = ids.map((id) => world.edges[id]).filter(Boolean)
      if (edges.length === 0) return
      api.graph.removeEdges(edges.map((e) => e.id))
      push({ kind: 'remove-edges', edges })
    },
    /** A drag or an auto layout: every moved node in one entry. */
    move: (moves: Move[]) => {
      const positions = () => moves.flatMap(({ id }) => {
        const ref = nodeRef(getWorld(), id)
        return ref ? [{ id, position: ref.node.position }] : []
      })
      const before = positions()
      api.graph.updatePositions(moves)
      const after = positions()
      if (!deepEqual(before, after)) push({ kind: 'move', before, after })
    },
    setEdgeKind: (id: EdgeId, kind: EdgeKind) => {
      const before = getWorld().edges[id]?.kind
      api.graph.setEdgeKind(id, kind)
      const after = getWorld().edges[id]?.kind
      if (before && after && before !== after) push({ kind: 'edge-kind', id, before, after })
    },
    updateAgent: (id: AgentId, patch: Parameters<Api['agents']['update']>[1]) => recordPatch('agent', id, patch),
    updateTrigger: (id: TriggerId, patch: Parameters<Api['triggers']['update']>[1]) => recordPatch('trigger', id, patch),
    updateSandbox: (id: SandboxId, patch: Parameters<Api['sandboxes']['update']>[1]) => recordPatch('sandbox', id, patch),
  }
}
