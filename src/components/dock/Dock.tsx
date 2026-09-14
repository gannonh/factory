import { ChevronDown, ChevronUp } from 'lucide-react'
import { useCallback, useRef } from 'react'
import { useStore, type DockTab } from '../../store'
import { cx } from '../ui'
import { EventsTab } from './EventsTab'
import { LogsTab } from './LogsTab'
import { QueueTab } from './QueueTab'
import { RunsTab } from './RunsTab'

const TABS: Array<{ id: DockTab; label: string }> = [
  { id: 'queue', label: 'Queue' },
  { id: 'runs', label: 'Runs' },
  { id: 'logs', label: 'Logs' },
  { id: 'events', label: 'Events' },
]

export function Dock() {
  const world = useStore((s) => s.world)
  const tab = useStore((s) => s.dockTab)
  const setTab = useStore((s) => s.setDockTab)
  const height = useStore((s) => s.dockHeight)
  const setHeight = useStore((s) => s.setDockHeight)
  const open = useStore((s) => s.dockOpen)
  const toggle = useStore((s) => s.toggleDock)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: height }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'row-resize'
      const move = (ev: PointerEvent) => {
        if (!dragRef.current) return
        setHeight(Math.max(120, Math.min(window.innerHeight * 0.75, dragRef.current.startH + (dragRef.current.startY - ev.clientY))))
      }
      const up = () => {
        dragRef.current = null
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [height, setHeight],
  )

  const counts: Record<DockTab, number> = {
    queue: Object.values(world.tasks).filter((t) => t.status === 'queued' || t.status === 'waiting').length,
    runs: Object.values(world.runs).filter((r) => r.status === 'running').length,
    logs: world.logs.length,
    events: world.events.length,
  }

  return (
    <div className="relative shrink-0 border-t border-ink-800 bg-ink-900 flex flex-col" style={{ height: open ? height : 32 }}>
      {open && <div onPointerDown={onPointerDown} className="absolute -top-1 left-0 right-0 h-2 z-10 cursor-row-resize hover:bg-cyan-400/40 active:bg-cyan-400/60" />}
      <div className="h-7 shrink-0 flex items-center px-2 gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx('h-6 rounded-md px-2.5 text-xs flex items-center gap-1.5', tab === t.id && open ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-100 hover:bg-ink-800')}
          >
            {t.label}
            <span className={cx('font-mono text-[10px] tabular-nums', t.id === 'queue' && counts.queue ? 'text-amber-300' : t.id === 'runs' && counts.runs ? 'text-cyan-300' : 'text-ink-500')}>{counts[t.id]}</span>
          </button>
        ))}
        <span className="flex-1" />
        <button onClick={toggle} aria-label={open ? 'Collapse dock' : 'Expand dock'} className="text-ink-400 hover:text-ink-100 px-1">{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
      </div>
      {open && (
        <div className="flex-1 min-h-0">
          {tab === 'queue' && <QueueTab />}
          {tab === 'runs' && <RunsTab />}
          {tab === 'logs' && <LogsTab />}
          {tab === 'events' && <EventsTab />}
        </div>
      )}
    </div>
  )
}
