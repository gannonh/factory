import { useEffect, useRef } from 'react'
import { existingSubject, type EventKind, type FactoryEvent } from '../../domain/types'
import { useStore } from '../../store'
import { cx, fmtTime } from '../ui'

const KIND_COLOR: Record<EventKind, string> = { agent: '#a78bfa', sandbox: '#22d3ee', trigger: '#34d399', run: '#38bdf8', graph: '#94a3b8', task: '#fbbf24' }

export function EventsTab() {
  const world = useStore((s) => s.world)
  const select = useStore((s) => s.select)
  const setView = useStore((s) => s.setView)
  const setDockTab = useStore((s) => s.setDockTab)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [world.events.length])

  const open = (ev: FactoryEvent) => {
    const selection = existingSubject(world, ev.subject)
    if (ev.subject.kind === 'run') setDockTab('runs')
    if (!selection) return
    if (selection.kind === 'edge') setView('canvas')
    select(selection)
  }

  if (world.events.length === 0) return <div className="h-full flex items-center justify-center text-xs text-ink-500">No events yet.</div>
  return (
    <div ref={ref} className="h-full overflow-y-auto px-2 py-1 text-xs">
      {world.events.map((ev) => (
        <button key={ev.id} onClick={() => open(ev)} title={ev.msg} aria-label={ev.msg} className={cx('group w-full flex items-center gap-3 rounded px-1 py-[3px] text-left hover:bg-ink-850 outline-none focus-visible:bg-ink-850')}>
          <span className="font-mono text-[11px] text-ink-500 tabular-nums">{fmtTime(ev.ts)}</span>
          <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider font-medium" style={{ color: KIND_COLOR[ev.kind] }}>{ev.kind}</span>
          <span className="text-ink-200 truncate group-focus-visible:whitespace-normal group-focus-visible:break-words">{ev.msg}</span>
        </button>
      ))}
    </div>
  )
}
