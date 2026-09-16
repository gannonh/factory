import { Hammer, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { api } from '../../api/client'
import { SANDBOX_STATE_COLOR, SANDBOX_TRANSITIONS, type Sandbox, type SandboxAction } from '../../domain/types'
import { useStore } from '../../store'
import { Badge, Button, Meter, Sparkline, cx, fmtAgo, fmtDuration } from '../ui'

const ACTIONS: Array<{ action: SandboxAction; label: string; icon: typeof Play; variant: 'default' | 'primary' | 'danger' }> = [
  { action: 'start', label: 'Start', icon: Play, variant: 'primary' },
  { action: 'stop', label: 'Stop', icon: Square, variant: 'default' },
  { action: 'restart', label: 'Restart', icon: RotateCw, variant: 'default' },
  { action: 'rebuild', label: 'Rebuild', icon: Hammer, variant: 'default' },
  { action: 'destroy', label: 'Destroy', icon: Trash2, variant: 'danger' },
]

const TIMED_LABEL: Partial<Record<Sandbox['state'], string>> = {
  provisioning: 'Provisioning',
  stopping: 'Stopping',
  rebuilding: 'Rebuilding image',
  destroying: 'Destroying',
}

export function SandboxCard({ sandbox, expanded, onClick, selected }: { sandbox: Sandbox; expanded?: boolean; onClick?: () => void; selected?: boolean }) {
  const world = useStore((s) => s.world)
  const color = SANDBOX_STATE_COLOR[sandbox.state]
  const allowed = SANDBOX_TRANSITIONS[sandbox.state]
  const timed = TIMED_LABEL[sandbox.state]
  const leases = sandbox.leases
  const cpuHistory = sandbox.history.map((m) => m.cpu)
  return (
    <div
      onClick={onClick}
      className={cx('rounded-xl border bg-ink-850 flex flex-col gap-3 p-3', onClick && 'cursor-pointer', selected ? 'border-cyan-400/60' : 'border-ink-700', onClick && !selected && 'hover:border-ink-500')}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono font-semibold text-[13px] truncate">{sandbox.name}</div>
          <div className="text-[11px] text-ink-400 truncate">{sandbox.kind} · {sandbox.host}</div>
          {expanded && <div className="text-[11px] text-ink-500 font-mono truncate mt-0.5">{sandbox.image}</div>}
        </div>
        <Badge color={color}>
          <span className={cx('size-1.5 rounded-full', timed && 'animate-pulse')} style={{ background: color }} />
          {sandbox.state}
        </Badge>
      </div>

      {timed ? (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[11px]"><span style={{ color }}>{timed}…</span><span className="font-mono tabular-nums text-ink-300">{Math.round(sandbox.progress * 100)}%</span></div>
          <div className="h-1.5 rounded-full bg-ink-700 overflow-hidden"><div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${sandbox.progress * 100}%`, background: color }} /></div>
          <div className="text-[10px] text-ink-500 font-mono">{provisionStep(sandbox)}</div>
        </div>
      ) : (
        <div className="flex gap-3 items-end">
          <div className="flex-1 flex flex-col gap-1">
            <Meter label="cpu" value={sandbox.metrics.cpu} color="#22d3ee" />
            <Meter label="mem" value={sandbox.metrics.mem} color="#a78bfa" />
            <Meter label="disk" value={sandbox.metrics.disk} color="#fbbf24" />
          </div>
          <div className="text-right">
            <Sparkline values={cpuHistory} color="#22d3ee" width={expanded ? 110 : 80} height={34} />
            <div className="text-[9px] text-ink-500">cpu 20s</div>
          </div>
        </div>
      )}

      <div className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[11px] flex flex-col gap-1">
        <div className="font-mono tabular-nums text-ink-400">leases {leases.length}/{sandbox.capacity}</div>
        {leases.length > 0 ? (
          leases.map((lease) => (
            <div key={lease.runId} className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-cyan-400 pulse-working" />
              <span className="text-cyan-200 font-medium">{world.agents[lease.agentId]?.name}</span>
              <span className="text-ink-400 truncate flex-1">{world.runs[lease.runId]?.title ?? ''}</span>
              <span className="text-ink-500 font-mono tabular-nums">{fmtDuration(world.now - lease.since)}</span>
            </div>
          ))
        ) : (
          <span className="text-ink-500">no lease holder · {sandbox.state} {fmtAgo(world.now, sandbox.stateSince)}</span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
        {ACTIONS.filter((a) => expanded || a.action in allowed).map(({ action, label, icon: Icon, variant }) => (
          <Button key={action} size="xs" variant={variant} disabled={!(action in allowed)} onClick={() => api.sandboxes.act(sandbox.id, action)}>
            <Icon size={11} />{label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function provisionStep(sb: Sandbox) {
  const p = sb.progress
  if (sb.state === 'provisioning') return p < 0.25 ? `allocating ${sb.kind} host` : p < 0.5 ? `pulling ${sb.image}` : p < 0.8 ? 'booting container' : 'running health checks'
  if (sb.state === 'rebuilding') return p < 0.4 ? 'tearing down' : p < 0.8 ? 'building image layers' : 'starting'
  if (sb.state === 'stopping') return 'draining processes'
  return 'releasing resources'
}
