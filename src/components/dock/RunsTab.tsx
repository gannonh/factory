import { useStore } from '../../store'
import { Badge, Dot, FlowBadge, fmtDuration, fmtTime } from '../ui'
import { Empty } from './QueueTab'

const COLOR = { running: '#22d3ee', succeeded: '#34d399', failed: '#f87171' } as const

export function RunsTab() {
  const world = useStore((s) => s.world)
  const select = useStore((s) => s.select)
  const runs = Object.values(world.runs).sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
  if (runs.length === 0) return <Empty>No runs yet.</Empty>
  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-ink-900 text-[10px] uppercase tracking-wider text-ink-400">
          <tr>{['Status', 'Run', 'Agent', 'Flow', 'Sandbox', 'Progress', 'Attempt', 'Tokens', 'Started', 'Duration'].map((h) => <th key={h} className="text-left font-medium px-3 py-1.5">{h}</th>)}</tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const flowId = world.tasks[r.taskId]?.flowId
            return (
              <tr key={r.id} onClick={() => select({ kind: 'run', id: r.id })} className="border-t border-ink-800 hover:bg-ink-850 cursor-pointer">
                <td className="px-3 py-1.5"><Badge color={COLOR[r.status]}><Dot color={COLOR[r.status]} pulse={r.status === 'running'} />{r.status}</Badge></td>
                <td className="px-3 py-1.5 max-w-[320px] truncate">
                  <button className="hover:underline" onClick={(event) => { event.stopPropagation(); select({ kind: 'run', id: r.id }) }}>{r.title}</button>
                  <span className="text-ink-500 font-mono ml-2">{r.id.slice(-6)}</span>
                </td>
                <td className="px-3 py-1.5">
                  {world.agents[r.agentId]
                    ? <button className="text-cyan-300 hover:underline" onClick={(event) => { event.stopPropagation(); select({ kind: 'agent', id: r.agentId }) }}>{world.agents[r.agentId].name}</button>
                    : <span className="text-ink-500">deleted</span>}
                </td>
                <td className="px-3 py-1.5">{flowId ? <FlowBadge flowId={flowId} /> : <span className="text-ink-500">—</span>}</td>
                <td className="px-3 py-1.5">
                  {world.sandboxes[r.sandboxId]
                    ? <button className="font-mono text-ink-300 hover:underline" onClick={(event) => { event.stopPropagation(); select({ kind: 'sandbox', id: r.sandboxId }) }}>{world.sandboxes[r.sandboxId].name}</button>
                    : <span className="text-ink-500">gone</span>}
                </td>
              <td className="px-3 py-1.5 w-32">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-ink-700 overflow-hidden"><div className="h-full transition-[width] duration-300" style={{ width: `${r.progress * 100}%`, background: COLOR[r.status] }} /></div>
                  <span className="font-mono tabular-nums text-ink-400 w-8 text-right">{Math.round(r.progress * 100)}%</span>
                </div>
              </td>
              <td className="px-3 py-1.5 font-mono tabular-nums text-ink-300">{r.attempt}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums text-ink-300">{r.tokens.toLocaleString()}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums text-ink-400">{fmtTime(r.startedAt)}</td>
              <td className="px-3 py-1.5 font-mono tabular-nums text-ink-300">{fmtDuration((r.endedAt ?? world.now) - r.startedAt)}</td>
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
