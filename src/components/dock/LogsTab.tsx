import { ArrowDownToLine } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LOG_LEVELS, LOG_LEVEL_COLOR, type LogLevel } from '../../domain/types'
import { useStore } from '../../store'
import { Input, cx, fmtTime } from '../ui'

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function LogsTab() {
  const world = useStore((s) => s.world)
  const level = useStore((s) => s.logLevel)
  const setLevel = useStore((s) => s.setLogLevel)
  const follow = useStore((s) => s.followTail)
  const setFollow = useStore((s) => s.setFollowTail)
  const selection = useStore((s) => s.selection)
  const [query, setQuery] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const agentFilter = onlySelected && selection?.kind === 'agent' ? selection.id : null
  const lines = useMemo(() => {
    const q = query.toLowerCase()
    return world.logs.filter((l) => RANK[l.level] >= RANK[level] && (!agentFilter || l.agentId === agentFilter) && (!q || l.msg.toLowerCase().includes(q)))
  }, [world.logs, level, agentFilter, query])

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines, follow])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    if (follow && !atBottom) setFollow(false)
    else if (!follow && atBottom) setFollow(true)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-ink-800">
        <div className="flex shrink-0 rounded-md border border-ink-700 overflow-hidden">
          {LOG_LEVELS.map((l) => (
            <button key={l} onClick={() => setLevel(l)} className={cx('h-6 px-2 text-[10px] font-mono uppercase shrink-0', level === l ? 'bg-ink-700' : 'hover:bg-ink-800')} style={{ color: RANK[l] >= RANK[level] ? LOG_LEVEL_COLOR[l] : '#3b475f' }}>{l}</button>
          ))}
        </div>
        <Input placeholder="filter…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-48 shrink-0 h-6 py-0" />
        <label className={cx('flex items-center gap-1.5 text-[11px]', selection?.kind === 'agent' ? 'text-ink-300' : 'text-ink-600')}>
          <input type="checkbox" className="accent-cyan-400" checked={onlySelected} disabled={selection?.kind !== 'agent'} onChange={(e) => setOnlySelected(e.target.checked)} />
          selected agent only
        </label>
        <span className="flex-1" />
        <span className="text-[10px] text-ink-500 font-mono">{lines.length} lines</span>
        <button onClick={() => setFollow(true)} className={cx('h-6 rounded-md px-2 text-[11px] flex items-center gap-1 border', follow ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-200' : 'border-ink-700 text-ink-400 hover:text-ink-100')}>
          <ArrowDownToLine size={11} />{follow ? 'following' : 'follow tail'}
        </button>
      </div>
      <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto font-mono text-[11px] leading-[18px] px-2 py-1">
        {lines.length === 0 && <div className="text-ink-500 py-4 text-center">No log lines at this level yet.</div>}
        {lines.map((l) => (
          <div key={l.id} className="flex gap-2 whitespace-pre hover:bg-ink-850 rounded px-1">
            <span className="text-ink-500 tabular-nums">{fmtTime(l.ts)}</span>
            <span className="w-11 shrink-0 uppercase" style={{ color: LOG_LEVEL_COLOR[l.level] }}>{l.level}</span>
            <span className="w-20 shrink-0 text-violet-300/90 truncate">{l.agentId ? world.agents[l.agentId]?.name ?? '–' : 'system'}</span>
            <span className="w-14 shrink-0 text-ink-500">{l.runId ? l.runId.slice(-6) : ''}</span>
            <span className="text-ink-200 whitespace-pre-wrap">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
