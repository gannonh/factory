import { X } from 'lucide-react'
import { useStore } from '../../store'
import { AgentInspector } from './AgentInspector'
import { EdgeInspector } from './EdgeInspector'
import { SandboxInspector } from './SandboxInspector'
import { TriggerInspector } from './TriggerInspector'

export function Inspector() {
  const selection = useStore((s) => s.selection)
  const world = useStore((s) => s.world)
  const select = useStore((s) => s.select)
  if (!selection) return null
  let body: React.ReactNode = null
  let title = ''
  if (selection.kind === 'agent') {
    const a = world.agents[selection.id]
    if (!a) return null
    title = 'Agent'
    body = <AgentInspector agent={a} />
  } else if (selection.kind === 'sandbox') {
    const s = world.sandboxes[selection.id]
    if (!s) return null
    title = 'Sandbox'
    body = <SandboxInspector sandbox={s} />
  } else if (selection.kind === 'trigger') {
    const t = world.triggers[selection.id]
    if (!t) return null
    title = 'Trigger'
    body = <TriggerInspector trigger={t} />
  } else {
    const e = world.edges[selection.id]
    if (!e) return null
    title = 'Edge'
    body = <EdgeInspector edge={e} />
  }
  return (
    <aside className="w-[340px] shrink-0 border-l border-ink-800 bg-ink-900 flex flex-col min-h-0">
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-ink-800">
        <span className="text-[11px] uppercase tracking-wider text-ink-400 font-semibold">{title}</span>
        <button onClick={() => select(null)} className="text-ink-400 hover:text-ink-100"><X size={14} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-5">{body}</div>
    </aside>
  )
}
