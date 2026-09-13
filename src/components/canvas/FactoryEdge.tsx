import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { EDGE_RULES, type EdgeKind } from '../../domain/types'
import { cx } from '../ui'

export type FactoryEdgeType = Edge<{ kind: EdgeKind; active: boolean }, 'factory'>

export function FactoryEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<FactoryEdgeType>) {
  const kind = data?.kind ?? 'handoff'
  const rule = EDGE_RULES[kind]
  const active = data?.active ?? false
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={cx('fe-path', active && (rule.dash ? 'fe-active' : 'fe-active-solid'))}
        style={{ stroke: rule.color, color: rule.color, strokeDasharray: rule.dash || undefined, opacity: active || selected ? 1 : 0.7 }}
        interactionWidth={16}
      />
      {(selected || active) && (
        <EdgeLabelRenderer>
          <div
            className="absolute pointer-events-none rounded px-1.5 py-0.5 text-[10px] font-medium border bg-ink-900"
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, color: rule.color, borderColor: `${rule.color}66` }}
          >
            {rule.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const edgeTypes = { factory: FactoryEdge }

export function EdgeLegend() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/90 backdrop-blur px-3 py-1.5 text-[10px] text-ink-300">
      {(Object.entries(EDGE_RULES) as Array<[EdgeKind, (typeof EDGE_RULES)[EdgeKind]]>).map(([k, r]) => (
        <span key={k} className="flex items-center gap-1.5">
          <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke={r.color} strokeWidth="2" strokeDasharray={r.dash || undefined} /></svg>
          {r.label}
        </span>
      ))}
    </div>
  )
}
