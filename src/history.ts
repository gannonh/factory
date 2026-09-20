/**
 * Session undo and redo for graph edits. Each wrapper reads the inverse from
 * the world before its write, records the edit as data, and replay calls the
 * raw API so ids stay stable across the stack.
 */
import type { Api } from './api/client'
import {
  attachedEdges,
  nodeKindOf,
  nodeRef,
  type AgentId,
  type Edge,
  type EdgeId,
  type EdgeKind,
  type GraphFragment,
  type Group,
  type GroupId,
  type NodeId,
  type NodeKind,
  type NodeRef,
  type Position,
  type SandboxId,
  type TriggerId,
  type World,
} from './domain/types'

const HISTORY_LIMIT = 100

type Move = { id: NodeId; position: Position }

/**
 * A patch write: the record the wrapper targeted and the values of the top-level
 * keys the write touched. An entry holds one of these per side, so before and
 * after stay correlated with their target without casts.
 */
type PatchWrite =
  | { target: 'agent'; id: AgentId; values: Parameters<Api['agents']['update']>[1] }
  | { target: 'sandbox'; id: SandboxId; values: Parameters<Api['sandboxes']['update']>[1] }
  | { target: 'trigger'; id: TriggerId; values: Parameters<Api['triggers']['update']>[1] }

type PatchEntry = { kind: 'patch'; key: string; before: PatchWrite; after: PatchWrite }

/** What create adds and delete removes: the same set, read in opposite directions. */
type NodeSet = { nodes: NodeRef[]; edges: Edge[] }

type HistoryEntry =
  | ({ kind: 'create' } & NodeSet)
  | ({ kind: 'delete' } & NodeSet)
  | { kind: 'connect'; edge: Edge }
  | { kind: 'remove-edges'; edges: Edge[] }
  | { kind: 'edge-kind'; id: EdgeId; before: EdgeKind; after: EdgeKind }
  | { kind: 'move'; before: Move[]; after: Move[] }
  | { kind: 'group'; group: Group; memberIds: NodeId[] }
  | { kind: 'ungroup'; group: Group; memberIds: NodeId[] }
  | PatchEntry

/** Structural equality for JSON-like values: primitives, arrays and plain objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length
    && keys.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** Copy `keys` out of a world record; the result is the patch payload for one side of an entry. */
function pick<T extends object>(record: T | undefined, keys: string[]): Partial<T> | null {
  if (!record) return null
  return Object.fromEntries(keys.map((key) => [key, (record as Record<string, unknown>)[key]])) as Partial<T>
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

  function readPatch(write: PatchWrite, keys: string[]): PatchWrite | null {
    const w = getWorld()
    switch (write.target) {
      case 'agent': {
        const values = pick(w.agents[write.id], keys)
        return values && { target: 'agent', id: write.id, values }
      }
      case 'trigger': {
        const values = pick(w.triggers[write.id], keys)
        return values && { target: 'trigger', id: write.id, values }
      }
      case 'sandbox': {
        // the sandbox API writes capacity only
        const capacity = w.sandboxes[write.id]?.capacity
        return capacity === undefined ? null : { target: 'sandbox', id: write.id, values: { capacity } }
      }
    }
  }

  function writePatch(write: PatchWrite) {
    switch (write.target) {
      case 'agent': return api.agents.update(write.id, write.values)
      case 'sandbox': return api.sandboxes.update(write.id, write.values)
      case 'trigger': return api.triggers.update(write.id, write.values)
    }
  }

  /** Merge into the top patch entry when it targets the same record and key, dropping a round trip back to the start. */
  function pushPatch(entry: PatchEntry) {
    const top = entries[cursor - 1]
    if (
      mergeable && top?.kind === 'patch'
      && top.after.target === entry.after.target && top.after.id === entry.after.id && top.key === entry.key
    ) {
      if (deepEqual(top.before.values, entry.after.values)) {
        // edited back to where the entry started: nothing left to undo
        cursor -= 1
        entries.length = cursor
        mergeable = false
        notify()
      } else {
        top.after = entry.after
      }
      return
    }
    push(entry)
  }

  function recordPatch(write: PatchWrite) {
    const keys = Object.keys(write.values).sort()
    const before = readPatch(write, keys)
    if (!before) return
    writePatch(write)
    const after = readPatch(write, keys)
    if (!after || deepEqual(before.values, after.values)) return
    pushPatch({ kind: 'patch', key: keys.join(','), before, after })
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

  function addNodeSet(entry: NodeSet) {
    api.graph.restoreNodes(entry.nodes)
    api.graph.restoreEdges(entry.edges)
  }

  function removeNodeSet(entry: NodeSet) {
    deleteExistingNodes(entry.nodes.map((ref) => ref.node.id))
    removeExistingEdges(entry.edges.map((e) => e.id))
  }

  function revert(entry: HistoryEntry) {
    switch (entry.kind) {
      case 'create': return removeNodeSet(entry)
      case 'delete': return addNodeSet(entry)
      case 'connect': return removeExistingEdges([entry.edge.id])
      case 'remove-edges': return api.graph.restoreEdges(entry.edges)
      case 'edge-kind': return api.graph.setEdgeKind(entry.id, entry.before)
      case 'move': return api.graph.updatePositions(entry.before)
      case 'patch': return writePatch(entry.before)
      case 'group':
        if (getWorld().groups[entry.group.id]) api.graph.ungroup(entry.group.id)
        return
      case 'ungroup': return api.graph.restoreGroup(entry.group, entry.memberIds)
    }
  }

  function apply(entry: HistoryEntry) {
    switch (entry.kind) {
      case 'create': return addNodeSet(entry)
      case 'delete': return removeNodeSet(entry)
      case 'connect': return api.graph.restoreEdges([entry.edge])
      case 'remove-edges': return removeExistingEdges(entry.edges.map((e) => e.id))
      case 'edge-kind': return api.graph.setEdgeKind(entry.id, entry.after)
      case 'move': return api.graph.updatePositions(entry.after)
      case 'patch': return writePatch(entry.after)
      case 'group': return api.graph.restoreGroup(entry.group, entry.memberIds)
      case 'ungroup':
        if (getWorld().groups[entry.group.id]) api.graph.ungroup(entry.group.id)
        return
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
      if (ref) push({ kind: 'create', nodes: [ref], edges: [] })
      return id
    },
    /** Paste or duplicate: every new node and the edges between them in one entry. */
    paste: (fragment: GraphFragment, offset: Position): GraphFragment => {
      const created = api.graph.paste(fragment, offset)
      if (created.nodes.length > 0) push({ kind: 'create', ...created })
      return created
    },
    /** One Delete keypress: the nodes, every edge attached to them, and separately selected edges. */
    delete: ({ nodeIds, edgeIds }: { nodeIds: NodeId[]; edgeIds: EdgeId[] }) => {
      const world = getWorld()
      const nodes = nodeIds.map((id) => nodeRef(world, id)).filter((ref) => ref !== null)
      const attached = attachedEdges(world, nodes.map((ref) => ref.node.id))
      const attachedIds = new Set(attached.map((e) => e.id))
      const standalone = edgeIds.map((id) => world.edges[id]).filter((e) => e && !attachedIds.has(e.id))
      if (nodes.length === 0 && standalone.length === 0) return
      if (nodes.length > 0) api.graph.deleteNodes(nodes.map((ref) => ref.node.id))
      if (standalone.length > 0) api.graph.removeEdges(standalone.map((e) => e.id))
      push({ kind: 'delete', nodes, edges: [...attached, ...standalone] })
    },
    connect: (source: NodeId, target: NodeId, preferred: EdgeKind | null) => {
      const result = api.graph.connect(source, target, preferred)
      if (result.ok) {
        const edge = getWorld().edges[result.id]
        if (edge) push({ kind: 'connect', edge })
      }
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
    updateAgent: (id: AgentId, patch: Parameters<Api['agents']['update']>[1]) => recordPatch({ target: 'agent', id, values: patch }),
    updateTrigger: (id: TriggerId, patch: Parameters<Api['triggers']['update']>[1]) => recordPatch({ target: 'trigger', id, values: patch }),
    updateSandbox: (id: SandboxId, patch: Parameters<Api['sandboxes']['update']>[1]) => recordPatch({ target: 'sandbox', id, values: patch }),
    group: (ids: NodeId[]): GroupId | null => {
      const id = api.graph.group(ids)
      if (id === null) return null
      const group = getWorld().groups[id]
      if (!group) return id
      const memberIds: NodeId[] = []
      const w = getWorld()
      for (const a of Object.values(w.agents)) if (a.groupId === id) memberIds.push(a.id)
      for (const s of Object.values(w.sandboxes)) if (s.groupId === id) memberIds.push(s.id)
      for (const t of Object.values(w.triggers)) if (t.groupId === id) memberIds.push(t.id)
      push({ kind: 'group', group, memberIds })
      return id
    },
    ungroup: (id: GroupId) => {
      const w = getWorld()
      const group = w.groups[id]
      if (!group) return
      const memberIds: NodeId[] = []
      for (const a of Object.values(w.agents)) if (a.groupId === id) memberIds.push(a.id)
      for (const s of Object.values(w.sandboxes)) if (s.groupId === id) memberIds.push(s.id)
      for (const t of Object.values(w.triggers)) if (t.groupId === id) memberIds.push(t.id)
      api.graph.ungroup(id)
      push({ kind: 'ungroup', group, memberIds })
    },
  }
}
