import { Trash2 } from 'lucide-react'
import { api } from '../../api/client'
import { EDGE_RULES, edgeKindFor, nodeKindOf, type Edge } from '../../domain/types'
import { useStore } from '../../store'
import { Button, Section, cx } from '../ui'

export function EdgeInspector({ edge }: { edge: Edge }) {
  const world = useStore((s) => s.world)
  const name = (id: string) => world.agents[id as keyof typeof world.agents]?.name ?? world.sandboxes[id as keyof typeof world.sandboxes]?.name ?? world.triggers[id as keyof typeof world.triggers]?.name ?? id
  const from = nodeKindOf(world, edge.source)
  const to = nodeKindOf(world, edge.target)
  const options = from && to ? edgeKindFor(from, to) : []
  const rule = EDGE_RULES[edge.kind]
  return (
    <>
      <div className="text-sm">
        <span className="font-semibold">{name(edge.source)}</span>
        <span className="mx-2" style={{ color: rule.color }}>→</span>
        <span className="font-semibold">{name(edge.target)}</span>
      </div>
      <Section title="Kind">
        <div className="flex flex-col gap-1.5">
          {options.map((k) => (
            <button
              key={k}
              onClick={() => api.graph.setEdgeKind(edge.id, k)}
              className={cx('flex items-center gap-3 rounded-md border px-2 py-1.5 text-xs text-left', edge.kind === k ? 'border-cyan-400/50 bg-cyan-500/10' : 'border-ink-700 hover:bg-ink-800')}
            >
              <svg width="30" height="6"><line x1="0" y1="3" x2="30" y2="3" stroke={EDGE_RULES[k].color} strokeWidth="2" strokeDasharray={EDGE_RULES[k].dash || undefined} /></svg>
              <span className="flex-1">{EDGE_RULES[k].label}</span>
              <span className="text-[10px] text-ink-400">{DESCRIPTION[k]}</span>
            </button>
          ))}
        </div>
      </Section>
      <Button variant="danger" onClick={() => api.graph.removeEdges([edge.id])}><Trash2 size={12} />Delete edge</Button>
    </>
  )
}

const DESCRIPTION: Record<Edge['kind'], string> = {
  triggers: 'enqueues a task',
  handoff: 'result feeds next agent',
  'depends-on': 'target waits for source tasks in the same flow',
  'runs-in': 'lease a sandbox',
}
