import { X } from 'lucide-react'
import { api } from '../../api/client'
import { TASK_STATUS_COLOR, type Task } from '../../domain/types'
import { useStore } from '../../store'
import { Badge, Dot, fmtAgo } from '../ui'

const RANK: Record<Task['priority'], number> = { high: 0, normal: 1, low: 2 }

export function QueueTab() {
  const world = useStore((s) => s.world)
  const select = useStore((s) => s.select)
  const tasks = Object.values(world.tasks)
    .filter((t) => t.status === 'queued' || t.status === 'waiting' || t.status === 'running')
    .sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : 0) || RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt)
  if (tasks.length === 0) return <Empty>Queue is empty. Compose a task in an agent's inspector or wait for a trigger.</Empty>
  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-ink-900 text-[10px] uppercase tracking-wider text-ink-400">
          <tr>{['Status', 'Task', 'Agent', 'Priority', 'Origin', 'Waiting on', 'Age', ''].map((h) => <th key={h} className="text-left font-medium px-3 py-1.5">{h}</th>)}</tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const agent = world.agents[t.agentId]
            const origin = t.origin.kind === 'trigger' ? world.triggers[t.origin.id]?.name ?? 'trigger' : t.origin.kind === 'handoff' ? `↳ ${world.agents[t.origin.from]?.name ?? 'agent'}` : 'manual'
            return (
              <tr key={t.id} className="border-t border-ink-800 hover:bg-ink-850">
                <td className="px-3 py-1.5"><Badge color={TASK_STATUS_COLOR[t.status]}><Dot color={TASK_STATUS_COLOR[t.status]} pulse={t.status === 'running'} />{t.status}</Badge></td>
                <td className="px-3 py-1.5 max-w-[360px] truncate" title={t.prompt}>{t.title}{t.attempts > 1 && <span className="text-ink-500"> · attempt {t.attempts}</span>}</td>
                <td className="px-3 py-1.5"><button className="text-cyan-300 hover:underline" onClick={() => agent && select({ kind: 'agent', id: agent.id })}>{agent?.name ?? '?'}</button></td>
                <td className="px-3 py-1.5" style={{ color: t.priority === 'high' ? '#f87171' : t.priority === 'low' ? '#64748b' : undefined }}>{t.priority}</td>
                <td className="px-3 py-1.5 text-ink-400">{origin}</td>
                <td className="px-3 py-1.5 text-amber-300/90">{t.blockedOn ?? ''}</td>
                <td className="px-3 py-1.5 text-ink-400 font-mono tabular-nums">{fmtAgo(world.now, t.createdAt)}</td>
                <td className="px-3 py-1.5 text-right">{t.status !== 'running' && <button onClick={() => api.tasks.cancel(t.id)} className="text-ink-500 hover:text-red-300" title="Cancel"><X size={12} /></button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center text-xs text-ink-500">{children}</div>
}
