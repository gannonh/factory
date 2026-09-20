import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, SelectionMode, useEdgesState, useNodesState, useReactFlow,
  type Connection, type IsValidConnection, type OnEdgesChange, type OnNodesChange,
} from '@xyflow/react'
import { LayoutGrid, Maximize2, Redo2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AGENT_STATUS_COLOR, SANDBOX_STATE_COLOR, edgeKindFor, nodeKindOf, nodeSubject, type EdgeId, type GroupId, type NodeId, type NodeKind, type Subject, type World } from '../../domain/types'
import { useShortcuts } from '../../shortcuts'
import { clipboard, history, useStore, type Selection } from '../../store'
import { Button, cx } from '../ui'
import { ContextMenu, type MenuState } from './ContextMenu'
import { EdgeLegend, edgeTypes, type FactoryEdgeType } from './FactoryEdge'
import { groupFrame } from './groups'
import { autoLayout, SIZE } from './layout'
import { nodeTypes, type FactoryNode } from './nodes'

function buildNodes(world: World): FactoryNode[] {
  const runs = Object.values(world.runs)
  const tasks = Object.values(world.tasks)
  const out: FactoryNode[] = []
  for (const t of Object.values(world.triggers)) {
    const nextIn = t.enabled && t.kind !== 'manual' && t.lastFiredAt !== null ? t.lastFiredAt + t.intervalMs - world.now : null
    out.push({ id: t.id, type: 'trigger', position: t.position, data: { trigger: t, nextIn } })
  }
  for (const a of Object.values(world.agents)) {
    out.push({
      id: a.id, type: 'agent', position: a.position,
      data: {
        agent: a,
        running: runs.filter((r) => r.agentId === a.id && r.status === 'running').length,
        queued: tasks.filter((t) => t.agentId === a.id && (t.status === 'queued' || t.status === 'waiting')).length,
      },
    })
  }
  for (const s of Object.values(world.sandboxes)) {
    const holders = [...new Set(s.leases.map((l) => world.agents[l.agentId]?.name).filter((n): n is string => Boolean(n)))]
    out.push({ id: s.id, type: 'sandbox', position: s.position, data: { sandbox: s, holders } })
  }
  return out
}

function memberGroupId(n: FactoryNode): GroupId | null {
  if (n.type === 'agent') return n.data.agent.groupId
  if (n.type === 'sandbox') return n.data.sandbox.groupId
  if (n.type === 'trigger') return n.data.trigger.groupId
  return null
}

function applyGroupFrames(world: World, nodes: FactoryNode[], prevById: Map<string, FactoryNode>): FactoryNode[] {
  const grouped = new Map<GroupId, FactoryNode[]>()
  for (const n of nodes) {
    const gid = memberGroupId(n)
    if (gid === null) continue
    const list = grouped.get(gid)
    if (list) list.push(n)
    else grouped.set(gid, [n])
  }
  const origins = new Map<GroupId, { x: number; y: number }>()
  const frames: FactoryNode[] = []
  for (const [gid, members] of grouped) {
    const group = world.groups[gid]
    if (!group) continue
    const rects = members.map((n) => {
      const prev = prevById.get(n.id)
      const fb = n.type === 'group' ? { w: 0, h: 0 } : SIZE[n.type]
      return { x: n.position.x, y: n.position.y, width: prev?.measured?.width ?? fb.w, height: prev?.measured?.height ?? fb.h }
    })
    const frame = groupFrame(rects)
    origins.set(gid, frame.position)
    frames.push({
      id: gid,
      type: 'group',
      position: frame.position,
      width: frame.width,
      height: frame.height,
      style: { width: frame.width, height: frame.height },
      className: 'pointer-events-none',
      data: { group },
      deletable: false,
      connectable: false,
    })
  }
  const children = nodes.map((n) => {
    const gid = memberGroupId(n)
    const origin = gid ? origins.get(gid) : undefined
    if (!gid || !origin) return n
    return { ...n, parentId: gid, position: { x: n.position.x - origin.x, y: n.position.y - origin.y } }
  })
  return [...frames, ...children]
}

function buildEdges(world: World): FactoryEdgeType[] {
  return Object.values(world.edges).map((e) => {
    let active = false
    if (e.kind === 'triggers') {
      const t = world.triggers[e.source as keyof typeof world.triggers]
      active = !!t && t.lastFiredAt !== null && world.now - t.lastFiredAt < 2500
    } else if (e.kind === 'runs-in') {
      const s = world.sandboxes[e.target as keyof typeof world.sandboxes]
      active = !!s && s.leases.some((l) => l.agentId === e.source)
    } else {
      active = world.agents[e.source as keyof typeof world.agents]?.status === 'working'
    }
    return { id: e.id, type: 'factory', source: e.source, target: e.target, sourceHandle: 'out', targetHandle: 'in', data: { kind: e.kind, active } }
  })
}

type CanvasSelection = Extract<Subject, { kind: 'agent' | 'sandbox' | 'trigger' | 'edge' }>

function isCanvasSelection(selection: Selection): selection is CanvasSelection {
  return selection !== null && (
    selection.kind === 'agent' ||
    selection.kind === 'sandbox' ||
    selection.kind === 'trigger' ||
    selection.kind === 'edge'
  )
}

export function Canvas() {
  const world = useStore((s) => s.world)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const agentEdgeTool = useStore((s) => s.agentEdgeTool)
  const setAgentEdgeTool = useStore((s) => s.setAgentEdgeTool)
  const [nodes, setNodes, onNodesChange] = useNodesState<FactoryNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<FactoryEdgeType>([])
  const [menu, setMenu] = useState<MenuState>(null)
  const [toast, setToast] = useState<string | null>(null)
  const { screenToFlowPosition, fitView, getNodes } = useReactFlow()
  const fitted = useRef(false)
  const graphSelectionPending = useRef(false)
  /** ids the next world sync should select, set by paste and duplicate; the world they landed in triggers that sync */
  const pasted = useRef<Set<string> | null>(null)
  const canUndo = useSyncExternalStore(history.subscribe, history.canUndo)
  const canRedo = useSyncExternalStore(history.subscribe, history.canRedo)

  useEffect(() => {
    const fresh = pasted.current
    pasted.current = null
    if (fresh) graphSelectionPending.current = true
    const currentSelection = useStore.getState().selection
    const selectedId = isCanvasSelection(currentSelection) ? currentSelection.id : null
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      return applyGroupFrames(world, buildNodes(world), prevById).map((n) => {
        const p = prevById.get(n.id)
        const dragging = p?.dragging ?? false
        const selected = fresh ? fresh.has(n.id) : p ? p.selected ?? false : selectedId === n.id
        return { ...n, position: dragging && p ? p.position : n.position, dragging, selected, measured: p?.measured }
      }) as FactoryNode[]
    })
    setEdges((prev) => {
      const prevById = new Map(prev.map((e) => [e.id, e]))
      return buildEdges(world).map((e) => ({ ...e, selected: fresh ? false : prevById.get(e.id)?.selected ?? selectedId === e.id }))
    })
  }, [world, setNodes, setEdges])

  /** set by the mirror effect when a canvas selection is pushed into the store; the effect below consumes it */
  const pushed = useRef<{ selection: Selection } | null>(null)

  useEffect(() => {
    const origin = pushed.current?.selection
    pushed.current = null
    if (origin === selection) return
    graphSelectionPending.current = false
    const id = isCanvasSelection(selection) ? selection.id : null
    setNodes((prev) => (prev.every((n) => n.selected === (n.id === id)) ? prev : prev.map((n) => ({ ...n, selected: n.id === id }))))
    setEdges((prev) => (prev.every((e) => e.selected === (e.id === id)) ? prev : prev.map((e) => ({ ...e, selected: e.id === id }))))
  }, [selection, setNodes, setEdges])

  const onGraphNodesChange = useCallback<OnNodesChange<FactoryNode>>((changes) => {
    if (changes.some((change) => change.type === 'select')) graphSelectionPending.current = true
    onNodesChange(changes)
  }, [onNodesChange])

  const onGraphEdgesChange = useCallback<OnEdgesChange<FactoryEdgeType>>((changes) => {
    if (changes.some((change) => change.type === 'select')) graphSelectionPending.current = true
    onEdgesChange(changes)
  }, [onEdgesChange])

  useEffect(() => {
    if (fitted.current || nodes.length === 0) return
    fitted.current = true
    requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }))
  }, [nodes.length, fitView])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (!graphSelectionPending.current) return
    graphSelectionPending.current = false
    const { world: w, selection: cur, select: set } = useStore.getState()
    if (cur !== selection) return
    const push = (next: Selection) => {
      pushed.current = { selection: next }
      set(next)
    }
    const n = nodes.find((x) => x.selected)
    if (n) {
      if (cur?.id === n.id) return
      const kind = nodeKindOf(w, n.id)
      if (kind) push(nodeSubject(kind, n.id as NodeId))
      return
    }
    const e = edges.find((x) => x.selected)
    if (e) {
      if (cur?.id !== e.id) push({ kind: 'edge', id: e.id as EdgeId })
      return
    }
    if (isCanvasSelection(cur)) push(null)
  }, [nodes, edges, selection])

  const isValidConnection = useCallback<IsValidConnection>(
    (c) => {
      if (!c.source || !c.target || c.source === c.target) return false
      const from = nodeKindOf(world, c.source)
      const to = nodeKindOf(world, c.target)
      return !!from && !!to && edgeKindFor(from, to).length > 0
    },
    [world],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return
      const r = history.connect(c.source as NodeId, c.target as NodeId, agentEdgeTool)
      if (!r.ok) setToast(r.reason)
    },
    [agentEdgeTool],
  )

  const onNodeDragStop = useCallback(
    (_: unknown, __: FactoryNode, dragged: FactoryNode[]) => {
      history.move(dragged.map((n) => ({ id: n.id as NodeId, position: n.position })))
    },
    [],
  )

  const onPaneContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }) })
    },
    [screenToFlowPosition],
  )

  const spawn = useCallback(
    (kind: NodeKind) => {
      if (!menu) return
      select(nodeSubject(kind, history.createNode(kind, menu.flow)))
      setMenu(null)
    },
    [menu, select],
  )

  const selectedNodeIds = () => getNodes().filter((n) => n.selected && n.type !== 'group').map((n) => n.id as NodeId)
  // the canvas keeps Cmd/Ctrl+V and Cmd/Ctrl+D even when nothing lands, so Cmd+D never opens the bookmark dialog
  const applyPaste = (ids: NodeId[]) => {
    // the copies already reached the store, so the next world to render is the one holding them
    if (ids.length > 0) pasted.current = new Set(ids)
    return true
  }
  useShortcuts({
    // selected text, in the dock logs for example, keeps the native copy
    copy: () => !window.getSelection()?.toString() && clipboard.copy(selectedNodeIds()),
    paste: () => applyPaste(clipboard.paste()),
    duplicate: () => applyPaste(clipboard.duplicate(selectedNodeIds())),
  })

  const runLayout = useCallback(() => {
    history.move(autoLayout(world))
    requestAnimationFrame(() => fitView({ padding: 0.15, duration: 400 }))
  }, [world, fitView])

  const minimapColor = useMemo(
    () => (n: FactoryNode) =>
      n.type === 'agent' ? AGENT_STATUS_COLOR[n.data.agent.status]
        : n.type === 'sandbox' ? SANDBOX_STATE_COLOR[n.data.sandbox.state]
          : n.type === 'group' ? '#64748b'
            : '#34d399',
    [],
  )

  const selectedNodes = nodes.filter((n) => n.selected)
  const groupable = selectedNodes.filter((n) => n.type !== 'group')
  const canGroup = groupable.length >= 2 && groupable.every((n) => memberGroupId(n) === null)
  const ungroupId = (() => {
    const gids = new Set<GroupId>()
    for (const n of selectedNodes) {
      if (n.type === 'group') gids.add(n.id as GroupId)
      else {
        const gid = memberGroupId(n)
        if (gid) gids.add(gid)
      }
    }
    return gids.size === 1 ? [...gids][0] : null
  })()

  return (
    <div className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onGraphNodesChange}
        onEdgesChange={onGraphEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeDragStop={onNodeDragStop}
        onDelete={({ nodes: ns, edges: es }) => history.delete({
          nodeIds: ns.filter((n) => n.type !== 'group').map((n) => n.id as NodeId),
          edgeIds: es.map((e) => e.id as EdgeId),
        })}
        onPaneContextMenu={onPaneContextMenu}
        onPaneClick={() => setMenu(null)}
        selectionOnDrag
        panOnDrag={[1]}
        selectionMode={SelectionMode.Partial}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={['Meta', 'Shift']}
        minZoom={0.2}
        maxZoom={2}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1c2538" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" pannable zoomable nodeColor={minimapColor} maskColor="rgba(7,9,15,0.7)" nodeStrokeWidth={0} style={{ width: 160, height: 100 }} />
      </ReactFlow>

      <div className="absolute top-3 left-3 flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900/90 backdrop-blur p-1">
          <Button variant="ghost" size="xs" onClick={() => history.undo()} disabled={!canUndo} title="Undo (⌘/Ctrl+Z)">
            <Undo2 size={13} /> Undo <span className="text-ink-500">⌘/Ctrl+Z</span>
          </Button>
          <Button variant="ghost" size="xs" onClick={() => history.redo()} disabled={!canRedo} title="Redo (⇧⌘/Ctrl+Z or ⌘/Ctrl+Y)">
            <Redo2 size={13} /> Redo <span className="text-ink-500">⇧⌘/Ctrl+Z</span>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!canGroup}
            onClick={() => history.group(groupable.map((n) => n.id as NodeId))}
          >
            Group
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={!ungroupId}
            onClick={() => { if (ungroupId) history.ungroup(ungroupId) }}
          >
            Ungroup
          </Button>
          <Button variant="ghost" size="xs" onClick={runLayout} title="Auto-layout (dagre)"><LayoutGrid size={13} /> Layout</Button>
          <Button variant="ghost" size="xs" onClick={() => fitView({ padding: 0.15, duration: 300 })} title="Fit view"><Maximize2 size={13} /> Fit</Button>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900/90 backdrop-blur p-1 text-[10px]">
          <span className="text-ink-400 px-1">agent → agent draws</span>
          {(['handoff', 'depends-on'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setAgentEdgeTool(k)}
              className={cx('h-6 rounded-md px-2 font-medium', agentEdgeTool === k ? (k === 'handoff' ? 'bg-violet-500/20 text-violet-200' : 'bg-amber-400/20 text-amber-200') : 'text-ink-300 hover:bg-ink-800')}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="absolute top-3 right-3"><EdgeLegend /></div>
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-ink-500 pointer-events-none">
        drag to marquee-select · space/middle-drag to pan · right-click to spawn · ⌫ deletes · ⌘/Ctrl+C, V, D copy, paste, duplicate
      </div>
      {toast && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 rounded-md border border-red-400/40 bg-red-500/15 text-red-200 px-3 py-1.5 text-xs shadow-lg">
          {toast}
        </div>
      )}
      <ContextMenu menu={menu} onPick={spawn} onClose={() => setMenu(null)} />
    </div>
  )
}
