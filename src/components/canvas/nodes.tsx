import { Handle, Position, useConnection, type NodeProps, type Node } from '@xyflow/react'
import { Bot, Boxes, Clock, Hand, Webhook, Zap } from 'lucide-react'
import { AGENT_STATUS_COLOR, SANDBOX_STATE_COLOR, type Agent, type Group, type Sandbox, type Trigger, type TriggerKind } from '../../domain/types'
import { Dot, cx } from '../ui'
import { GROUP_HEADER } from './groups'

export type AgentNodeType = Node<{ agent: Agent; running: number; queued: number }, 'agent'>
export type SandboxNodeType = Node<{ sandbox: Sandbox; holders: string[] }, 'sandbox'>
export type TriggerNodeType = Node<{ trigger: Trigger; nextIn: number | null }, 'trigger'>
export type GroupNodeType = Node<{ group: Group }, 'group'>
export type FactoryNode = AgentNodeType | SandboxNodeType | TriggerNodeType | GroupNodeType

const shell = 'relative rounded-xl border bg-ink-850 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)] w-[220px] transition-colors'

/** While a connection is being dragged, the whole node accepts the drop instead of only the 9px handle. */
function DropTarget() {
  const connecting = useConnection((c) => c.inProgress)
  if (!connecting) return null
  return <Handle type="target" position={Position.Left} id="drop" className="drop-handle" />
}

export function AgentNode({ data, selected }: NodeProps<AgentNodeType>) {
  const { agent, running, queued } = data
  const color = AGENT_STATUS_COLOR[agent.status]
  return (
    <div className={cx(shell, selected ? 'border-cyan-400/70' : 'border-ink-600 hover:border-ink-500')} style={{ boxShadow: agent.status === 'working' ? `0 0 0 1px ${color}55, 0 0 24px -6px ${color}88` : undefined }}>
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />
      <DropTarget />
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="size-6 rounded-md bg-violet-500/15 text-violet-300 flex items-center justify-center"><Bot size={14} /></span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate leading-4">{agent.name}</div>
          <div className="text-[10px] text-ink-400 truncate">{agent.role}</div>
        </div>
        <Dot color={color} pulse={agent.status === 'working'} />
      </div>
      <div className="px-3 pb-2.5 pt-2 flex items-center gap-2 text-[10px] text-ink-400">
        <span className="font-mono text-ink-300 truncate">{agent.model.replace('claude-', '')}</span>
        <span className="flex-1" />
        <span title="running / concurrency" className="font-mono tabular-nums" style={{ color: running ? '#22d3ee' : undefined }}>{running}/{agent.concurrency}</span>
        {queued > 0 && <span className="rounded bg-amber-400/15 text-amber-300 px-1 font-mono tabular-nums">+{queued}</span>}
      </div>
      {running > 0 && <div className="h-0.5 mx-3 mb-2 rounded-full bg-ink-700 overflow-hidden"><div className="h-full w-full shimmer" /></div>}
    </div>
  )
}

export function SandboxNode({ data, selected }: NodeProps<SandboxNodeType>) {
  const { sandbox, holders } = data
  const color = SANDBOX_STATE_COLOR[sandbox.state]
  const timed = sandbox.state !== 'running' && sandbox.state !== 'stopped' && sandbox.state !== 'error'
  return (
    <div className={cx(shell, selected ? 'border-cyan-400/70' : 'border-ink-600 hover:border-ink-500')}>
      <Handle type="target" position={Position.Top} id="in" />
      <DropTarget />
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="size-6 rounded-md bg-cyan-500/15 text-cyan-300 flex items-center justify-center"><Boxes size={14} /></span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate leading-4 font-mono text-[11.5px]">{sandbox.name}</div>
          <div className="text-[10px] text-ink-400 truncate">{sandbox.kind} · {sandbox.host}</div>
        </div>
        <span className="text-[10px] font-medium" style={{ color }}>{sandbox.state}</span>
      </div>
      <div className="px-3 pb-2.5 pt-2 flex flex-col gap-1">
        {timed ? (
          <div className="h-1 rounded-full bg-ink-700 overflow-hidden"><div className="h-full rounded-full transition-[width]" style={{ width: `${sandbox.progress * 100}%`, background: color }} /></div>
        ) : (
          <div className="flex gap-1">
            {(['cpu', 'mem', 'disk'] as const).map((k) => (
              <div key={k} className="flex-1 h-1 rounded-full bg-ink-700 overflow-hidden" title={`${k} ${Math.round(sandbox.metrics[k])}%`}>
                <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${sandbox.metrics[k]}%`, background: k === 'cpu' ? '#22d3ee' : k === 'mem' ? '#a78bfa' : '#fbbf24' }} />
              </div>
            ))}
          </div>
        )}
        <div className="text-[10px] text-ink-400 truncate">
          <span className="font-mono tabular-nums">leases {sandbox.leases.length}/{sandbox.capacity}</span>
          {holders.length > 0 && <span className="text-cyan-300"> · {holders.join(', ')}</span>}
        </div>
      </div>
    </div>
  )
}

const TRIGGER_ICON: Record<TriggerKind, typeof Clock> = { cron: Clock, webhook: Webhook, manual: Hand, event: Zap }

export function TriggerNode({ data, selected }: NodeProps<TriggerNodeType>) {
  const { trigger, nextIn } = data
  const Icon = TRIGGER_ICON[trigger.kind]
  return (
    <div className={cx(shell, 'w-[200px]', selected ? 'border-cyan-400/70' : 'border-ink-600 hover:border-ink-500', !trigger.enabled && 'opacity-60')}>
      <Handle type="source" position={Position.Right} id="out" />
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="size-6 rounded-md bg-emerald-500/15 text-emerald-300 flex items-center justify-center"><Icon size={14} /></span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate leading-4">{trigger.name}</div>
          <div className="text-[10px] text-ink-400 truncate">
            {trigger.kind}
            {trigger.enabled ? (nextIn !== null ? ` · next in ${Math.max(0, Math.ceil(nextIn / 1000))}s` : '') : ' · disabled'}
          </div>
        </div>
        <span className="text-[10px] font-mono text-ink-400 tabular-nums">×{trigger.fired}</span>
      </div>
    </div>
  )
}

export function GroupNode({ data, selected }: NodeProps<GroupNodeType>) {
  return (
    <div
      className={cx('h-full w-full rounded-xl border bg-cyan-400/[0.04]', selected ? 'border-cyan-400/50' : 'border-ink-600')}
    >
      <div
        className="group-drag-handle flex items-center px-3 text-[11px] font-semibold text-ink-200 truncate pointer-events-auto"
        style={{ height: GROUP_HEADER }}
      >
        {data.group.name}
      </div>
      <div className="absolute inset-0 pointer-events-none" style={{ top: GROUP_HEADER }} />
    </div>
  )
}

export const nodeTypes = { agent: AgentNode, sandbox: SandboxNode, trigger: TriggerNode, group: GroupNode }
