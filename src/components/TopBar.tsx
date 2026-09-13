import { Pause, Play, RotateCcw } from 'lucide-react'
import { api } from '../api/client'
import { useStore } from '../store'
import { Button, cx } from './ui'

export function TopBar() {
  const world = useStore((s) => s.world)
  const agents = Object.values(world.agents)
  const runs = Object.values(world.runs)
  const tasks = Object.values(world.tasks)
  const sandboxes = Object.values(world.sandboxes)
  const working = agents.filter((a) => a.status === 'working').length
  const queued = tasks.filter((t) => t.status === 'queued' || t.status === 'waiting').length
  const running = runs.filter((r) => r.status === 'running').length
  const done = runs.filter((r) => r.status !== 'running')
  const successRate = done.length ? Math.round((done.filter((r) => r.status === 'succeeded').length / done.length) * 100) : null
  const sbRunning = sandboxes.filter((s) => s.state === 'running').length
  const { paused, speed } = world.sim

  return (
    <header className="h-12 shrink-0 border-b border-ink-800 bg-ink-900 flex items-center px-3 gap-4">
      <div className="flex items-center gap-2 pr-2">
        <img src="/factory.svg" className="size-6 rounded-md" alt="" />
        <span className="font-semibold tracking-tight text-[14px]">Factory</span>
        <span className="text-ink-500 text-xs">/ acme-platform</span>
      </div>
      <div className="flex items-center gap-1 text-xs">
        <Stat label="agents" value={`${working}/${agents.length}`} hint="working" color={working ? '#22d3ee' : undefined} />
        <Stat label="runs" value={running} hint="active" />
        <Stat label="queue" value={queued} hint="pending" color={queued > 5 ? '#fbbf24' : undefined} />
        <Stat label="sandboxes" value={`${sbRunning}/${sandboxes.length}`} hint="up" />
        <Stat label="success" value={successRate === null ? '–' : `${successRate}%`} hint={`${done.length} runs`} color={successRate !== null && successRate < 70 ? '#f87171' : undefined} />
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-ink-400 mr-1">simulation</span>
        <Button variant={paused ? 'primary' : 'default'} onClick={() => api.sim.set({ paused: !paused })} title={paused ? 'Resume' : 'Pause'}>
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <div className="flex rounded-md border border-ink-600 overflow-hidden">
          {([1, 2, 4] as const).map((s) => (
            <button
              key={s}
              onClick={() => api.sim.set({ speed: s })}
              className={cx('h-7 px-2 text-xs font-mono', speed === s ? 'bg-cyan-500/20 text-cyan-200' : 'bg-ink-800 text-ink-300 hover:bg-ink-700')}
            >
              {s}×
            </button>
          ))}
        </div>
        <Button variant="ghost" onClick={() => api.sim.reset()} title="Reset to seed data">
          <RotateCcw size={13} />
          Reset
        </Button>
      </div>
    </header>
  )
}

function Stat({ label, value, hint, color }: { label: string; value: string | number; hint: string; color?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-md px-2 py-1 hover:bg-ink-850">
      <span className="text-ink-400">{label}</span>
      <span className="font-semibold tabular-nums text-[13px]" style={{ color }}>{value}</span>
      <span className="text-ink-500 text-[10px]">{hint}</span>
    </div>
  )
}
