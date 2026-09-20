import dagre from '@dagrejs/dagre'
import type { Edge, NodeId, Position, World } from '../../domain/types'

export const SIZE = { agent: { w: 220, h: 84 }, sandbox: { w: 220, h: 84 }, trigger: { w: 200, h: 52 } }

/** Left-to-right flow for triggers/agents; sandboxes hang under the agents that run in them. */
export function autoLayout(world: World): Array<{ id: NodeId; position: Position }> {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 110, marginx: 40, marginy: 40 })
  for (const a of Object.values(world.agents)) g.setNode(a.id, { width: SIZE.agent.w, height: SIZE.agent.h })
  for (const t of Object.values(world.triggers)) g.setNode(t.id, { width: SIZE.trigger.w, height: SIZE.trigger.h })
  const flow = (e: Edge) => e.kind !== 'runs-in'
  for (const e of Object.values(world.edges)) if (flow(e)) g.setEdge(e.source, e.target)
  dagre.layout(g)
  const out: Array<{ id: NodeId; position: Position }> = []
  let maxY = 0
  for (const id of g.nodes()) {
    const n = g.node(id)
    out.push({ id: id as NodeId, position: { x: n.x - n.width / 2, y: n.y - n.height / 2 } })
    maxY = Math.max(maxY, n.y + n.height / 2)
  }
  const sandboxes = Object.values(world.sandboxes)
  const runsIn = Object.values(world.edges).filter((e) => e.kind === 'runs-in')
  const agentX = new Map(out.map((o) => [o.id, o.position.x]))
  const placed = sandboxes
    .map((sb) => {
      const xs = runsIn.filter((e) => e.target === sb.id).map((e) => agentX.get(e.source as NodeId)).filter((x): x is number => x !== undefined)
      return { id: sb.id, anchor: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity }
    })
    .sort((a, b) => a.anchor - b.anchor)
  let cursor = 40
  for (const p of placed) {
    const x = Math.max(cursor, Number.isFinite(p.anchor) ? p.anchor : cursor)
    out.push({ id: p.id, position: { x, y: maxY + 90 } })
    cursor = x + SIZE.sandbox.w + 40
  }
  return out
}
