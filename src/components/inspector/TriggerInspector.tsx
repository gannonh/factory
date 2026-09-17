import { Zap } from 'lucide-react'
import { api } from '../../api/client'
import type { Trigger, TriggerKind } from '../../domain/types'
import { history, useStore } from '../../store'
import { Button, Field, Input, Section, Select, Textarea, fmtAgo } from '../ui'

export function TriggerInspector({ trigger }: { trigger: Trigger }) {
  const world = useStore((s) => s.world)
  const update = (patch: Partial<Omit<Trigger, 'id' | 'position'>>) => history.updateTrigger(trigger.id, patch)
  const targets = Object.values(world.edges).filter((e) => e.kind === 'triggers' && e.source === trigger.id).map((e) => world.agents[e.target as keyof typeof world.agents]?.name).filter(Boolean)
  const periodic = trigger.kind !== 'manual'
  return (
    <>
      <div className="flex items-center gap-2">
        <Input value={trigger.name} onChange={(e) => update({ name: e.target.value })} className="font-semibold text-sm" />
        <Button variant="primary" onClick={() => api.triggers.fire(trigger.id)} title="Fire now"><Zap size={12} />Fire</Button>
      </div>
      <Section title="Status">
        <div className="text-[11px] text-ink-300 flex flex-col gap-1">
          <div>fired <span className="font-mono text-ink-100">{trigger.fired}×</span>{trigger.lastFiredAt !== null && <span className="text-ink-400"> · last {fmtAgo(world.now, trigger.lastFiredAt)}</span>}</div>
          <div>targets {targets.length ? <span className="text-ink-100">{targets.join(', ')}</span> : <span className="text-amber-300">none (draw a triggers edge to an agent)</span>}</div>
        </div>
      </Section>
      <Section title="Config">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={trigger.enabled} onChange={(e) => update({ enabled: e.target.checked })} className="accent-cyan-400" />enabled</label>
        <Field label="Kind">
          <Select value={trigger.kind} onChange={(e) => update({ kind: e.target.value as TriggerKind })}>
            <option value="cron">cron</option><option value="webhook">webhook</option><option value="event">event</option><option value="manual">manual</option>
          </Select>
        </Field>
        {periodic && (
          <Field label="Interval (s)" hint="simulated"><Input type="number" min={3} value={Math.round(trigger.intervalMs / 1000)} onChange={(e) => update({ intervalMs: Math.max(3, Number(e.target.value) || 3) * 1000 })} /></Field>
        )}
        <Field label="Task template"><Textarea rows={3} value={trigger.template} onChange={(e) => update({ template: e.target.value })} /></Field>
      </Section>
    </>
  )
}
