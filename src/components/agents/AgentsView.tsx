import { AGENT_STATUS_COLOR, type Agent } from '../../domain/types'
import { useStore } from '../../store'
import { Badge, Dot, Kpi, cx } from '../ui'

export function AgentsView() {
  const world = useStore((s) => s.world)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const agents = Object.values(world.agents)
  const runs = Object.values(world.runs)
  const tasks = Object.values(world.tasks)
  const done = runs.filter((r) => r.status !== 'running')
  const succeeded = done.filter((r) => r.status === 'succeeded')
  const avgMs = succeeded.length ? succeeded.reduce((a, r) => a + ((r.endedAt ?? r.startedAt) - r.startedAt), 0) / succeeded.length : 0
  const tokens = runs.reduce((a, r) => a + r.tokens, 0)
  const capacity = agents.reduce((a, x) => a + (x.status === 'paused' ? 0 : x.concurrency), 0)
  const active = runs.filter((r) => r.status === 'running').length
  const rows = agents.map((a) => ({
    agent: a,
    running: runs.filter((r) => r.agentId === a.id && r.status === 'running').length,
    queued: tasks.filter((t) => t.agentId === a.id && (t.status === 'queued' || t.status === 'waiting')).length,
    tokens: runs.filter((r) => r.agentId === a.id).reduce((s, r) => s + r.tokens, 0),
    sandboxes: Object.values(world.edges).filter((e) => e.kind === 'runs-in' && e.source === a.id).length,
  }))
  return (
    <div className="absolute inset-0 overflow-y-auto p-4 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold">Agents</h2>
        <span className="text-xs text-ink-400">fleet roster · select a row to open the inspector</span>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Kpi label="utilization" value={capacity ? `${Math.round((active / capacity) * 100)}%` : '–'} sub={`${active}/${capacity} slots`} color="#22d3ee" />
        <Kpi label="throughput" value={succeeded.length} sub="runs succeeded" color="#34d399" />
        <Kpi label="failure rate" value={done.length ? `${Math.round(((done.length - succeeded.length) / done.length) * 100)}%` : '–'} sub={`${done.length - succeeded.length} failed`} color={done.length - succeeded.length ? '#f87171' : undefined} />
        <Kpi label="avg run" value={avgMs ? `${(avgMs / 1000).toFixed(1)}s` : '–'} sub="successful runs" />
        <Kpi label="tokens" value={tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} sub="all runs" />
      </div>
      <div className="rounded-xl border border-ink-700 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-ink-850 text-[10px] uppercase tracking-wider text-ink-400">
            <tr>
              {['Agent', 'Status', 'Model', 'Temp', 'Load', 'Queue', 'Done', 'Failed', 'Tokens', 'Sandboxes', 'Tools'].map((h) => (
                <th key={h} className="text-left font-medium px-3 py-2 first:pl-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ agent: a, running, queued, tokens: tk, sandboxes }) => (
              <Row key={a.id} agent={a} running={running} queued={queued} tokens={tk} sandboxes={sandboxes} selected={selection?.id === a.id} onClick={() => select({ kind: 'agent', id: a.id })} />
            ))}
          </tbody>
        </table>
        {agents.length === 0 && <div className="p-6 text-sm text-ink-500 text-center">No agents yet. Right-click the canvas to spawn one.</div>}
      </div>
    </div>
  )
}

function Row({ agent: a, running, queued, tokens, sandboxes, selected, onClick }: { agent: Agent; running: number; queued: number; tokens: number; sandboxes: number; selected: boolean; onClick: () => void }) {
  const color = AGENT_STATUS_COLOR[a.status]
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cx('border-t border-ink-800 cursor-pointer outline-none focus-visible:bg-ink-800', selected ? 'bg-cyan-500/10' : 'hover:bg-ink-850')}
    >
      <td className="px-3 py-2 pl-4">
        <div className="font-medium">{a.name}</div>
        <div className="text-[10px] text-ink-400">{a.role}</div>
      </td>
      <td className="px-3 py-2"><Badge color={color}><Dot color={color} pulse={a.status === 'working'} />{a.status}</Badge></td>
      <td className="px-3 py-2 font-mono text-ink-300">{a.model}</td>
      <td className="px-3 py-2 font-mono tabular-nums">{a.temperature.toFixed(2)}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 rounded-full bg-ink-700 overflow-hidden"><div className="h-full bg-cyan-400" style={{ width: `${(running / a.concurrency) * 100}%` }} /></div>
          <span className="font-mono tabular-nums text-ink-300">{running}/{a.concurrency}</span>
        </div>
      </td>
      <td className="px-3 py-2 font-mono tabular-nums" style={{ color: queued ? '#fbbf24' : undefined }}>{queued}</td>
      <td className="px-3 py-2 font-mono tabular-nums text-emerald-300">{a.completed}</td>
      <td className="px-3 py-2 font-mono tabular-nums" style={{ color: a.failed ? '#f87171' : undefined }}>{a.failed}</td>
      <td className="px-3 py-2 font-mono tabular-nums text-ink-300">{tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}</td>
      <td className="px-3 py-2 font-mono tabular-nums" style={{ color: sandboxes ? undefined : '#fbbf24' }}>{sandboxes}</td>
      <td className="px-3 py-2 text-ink-400 truncate max-w-[220px]">{a.tools.join(', ')}</td>
    </tr>
  )
}
