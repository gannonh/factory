import { Pause, Play, Plus, Send, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import { TOOL_CATALOG } from '../../domain/seed'
import { AGENT_STATUS_COLOR, MODELS, TASK_STATUS_COLOR, type Agent, type ModelName, type Priority } from '../../domain/types'
import { history, useStore } from '../../store'
import { Badge, Button, Dot, Field, Input, Section, Select, Textarea, cx, fmtDuration } from '../ui'

export function AgentInspector({ agent }: { agent: Agent }) {
  const world = useStore((s) => s.world)
  const setDockTab = useStore((s) => s.setDockTab)
  const update = (patch: Partial<Omit<Agent, 'id' | 'status' | 'position'>>) => history.updateAgent(agent.id, patch)
  const runs = Object.values(world.runs).filter((r) => r.agentId === agent.id)
  const active = runs.filter((r) => r.status === 'running')
  const pending = Object.values(world.tasks).filter((t) => t.agentId === agent.id && (t.status === 'queued' || t.status === 'waiting'))
  const sandboxes = Object.values(world.edges).filter((e) => e.kind === 'runs-in' && e.source === agent.id).map((e) => world.sandboxes[e.target as keyof typeof world.sandboxes]).filter(Boolean)
  const paused = agent.status === 'paused'

  return (
    <>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <Input value={agent.name} onChange={(e) => update({ name: e.target.value })} className="font-semibold text-sm" />
          <Input value={agent.role} onChange={(e) => update({ role: e.target.value })} placeholder="role" />
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge color={AGENT_STATUS_COLOR[agent.status]}><Dot color={AGENT_STATUS_COLOR[agent.status]} pulse={agent.status === 'working'} />{agent.status}</Badge>
          <Button size="xs" variant={paused ? 'primary' : 'default'} onClick={() => api.agents.setPaused(agent.id, !paused)}>
            {paused ? <Play size={11} /> : <Pause size={11} />}{paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </div>

      <Section title="Live workload" right={<button className="text-[11px] text-cyan-300 hover:underline" onClick={() => setDockTab('runs')}>open runs</button>}>
        <div className="grid grid-cols-4 gap-2 text-center">
          <Stat label="active" value={`${active.length}/${agent.concurrency}`} color="#22d3ee" />
          <Stat label="queued" value={pending.length} color={pending.length ? '#fbbf24' : undefined} />
          <Stat label="done" value={agent.completed} color="#34d399" />
          <Stat label="failed" value={agent.failed} color={agent.failed ? '#f87171' : undefined} />
        </div>
        {active.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {active.map((r) => (
              <div key={r.id} className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5">
                <div className="flex justify-between text-[11px]"><span className="truncate">{r.title}</span><span className="text-ink-400 font-mono tabular-nums">{fmtDuration(world.now - r.startedAt)}</span></div>
                <div className="mt-1 h-1 rounded-full bg-ink-700 overflow-hidden"><div className="h-full bg-cyan-400 transition-[width]" style={{ width: `${r.progress * 100}%` }} /></div>
                <div className="text-[10px] text-ink-400 mt-1">on {world.sandboxes[r.sandboxId]?.name ?? '?'} · attempt {r.attempt} · {r.tokens.toLocaleString()} tok</div>
              </div>
            ))}
          </div>
        )}
        {pending.length > 0 && (
          <div className="flex flex-col gap-1">
            {pending.slice(0, 4).map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-[11px]">
                <Dot color={TASK_STATUS_COLOR[t.status]} />
                <span className="truncate flex-1">{t.title}</span>
                {t.blockedOn && <span className="text-amber-300/80 text-[10px] truncate max-w-[120px]">{t.blockedOn}</span>}
              </div>
            ))}
            {pending.length > 4 && <div className="text-[10px] text-ink-500">+{pending.length - 4} more</div>}
          </div>
        )}
        <div className="text-[11px] text-ink-400">
          runs in {sandboxes.length ? sandboxes.map((s) => s.name).join(', ') : <span className="text-amber-300">no sandbox attached (draw a runs-in edge)</span>}
        </div>
      </Section>

      <TaskComposer agent={agent} />

      <Section title="Model">
        <Field label="Model">
          <Select value={agent.model} onChange={(e) => update({ model: e.target.value as ModelName })}>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Temperature" hint={agent.temperature.toFixed(2)}>
          <input type="range" min={0} max={1} step={0.05} value={agent.temperature} onChange={(e) => update({ temperature: Number(e.target.value) })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Concurrency"><Input type="number" min={1} max={8} value={agent.concurrency} onChange={(e) => update({ concurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} /></Field>
          <Field label="Timeout (s)"><Input type="number" min={5} value={Math.round(agent.timeoutMs / 1000)} onChange={(e) => update({ timeoutMs: Math.max(5, Number(e.target.value) || 5) * 1000 })} /></Field>
        </div>
      </Section>

      <Section title="Retry policy">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Attempts"><Input type="number" min={1} max={10} value={agent.retry.maxAttempts} onChange={(e) => update({ retry: { ...agent.retry, maxAttempts: Math.max(1, Math.min(10, Number(e.target.value) || 1)) } })} /></Field>
          <Field label="Backoff ms"><Input type="number" min={0} step={500} value={agent.retry.backoffMs} onChange={(e) => update({ retry: { ...agent.retry, backoffMs: Math.max(0, Number(e.target.value) || 0) } })} /></Field>
          <Field label="Curve">
            <Select value={agent.retry.backoff} onChange={(e) => update({ retry: { ...agent.retry, backoff: e.target.value as Agent['retry']['backoff'] } })}>
              <option value="fixed">fixed</option><option value="exponential">exponential</option>
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="Tools">
        <ToolsEditor tools={agent.tools} onChange={(tools) => update({ tools })} />
      </Section>

      <Section title="System prompt" right={<span className="text-[10px] text-ink-500 font-mono">{agent.systemPrompt.length} chars</span>}>
        <Textarea rows={6} value={agent.systemPrompt} onChange={(e) => update({ systemPrompt: e.target.value })} />
      </Section>
    </>
  )
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850 py-1.5">
      <div className="text-sm font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-[10px] text-ink-400">{label}</div>
    </div>
  )
}

function ToolsEditor({ tools, onChange }: { tools: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = (name: string) => {
    const n = name.trim()
    if (!n || tools.includes(n)) return
    onChange([...tools, n])
    setDraft('')
  }
  const suggestions = TOOL_CATALOG.filter((t) => !tools.includes(t))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {tools.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-[11px] font-mono">
            {t}
            <button onClick={() => onChange(tools.filter((x) => x !== t))} aria-label={`Remove ${t}`} className="text-ink-400 hover:text-red-300"><X size={10} /></button>
          </span>
        ))}
        {tools.length === 0 && <span className="text-[11px] text-ink-500">no tools</span>}
      </div>
      <div className="flex gap-1.5">
        <Input list="tool-catalog" placeholder="add tool…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(draft) }} />
        <datalist id="tool-catalog">{suggestions.map((t) => <option key={t} value={t} />)}</datalist>
        <Button onClick={() => add(draft)} disabled={!draft.trim()}><Plus size={12} /></Button>
      </div>
    </div>
  )
}

function TaskComposer({ agent }: { agent: Agent }) {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const setDockTab = useStore((s) => s.setDockTab)
  const submit = () => {
    if (!title.trim()) return
    api.agents.enqueue(agent.id, { title: title.trim(), prompt: prompt.trim() || title.trim(), priority })
    setTitle('')
    setPrompt('')
    setDockTab('queue')
  }
  return (
    <Section title="Compose task">
      <Input placeholder="Task title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }} />
      <Textarea rows={3} placeholder="Prompt / instructions (optional)" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }} />
      <div className="flex items-center gap-1.5">
        {(['low', 'normal', 'high'] as Priority[]).map((p) => (
          <button key={p} onClick={() => setPriority(p)} className={cx('h-6 rounded-md px-2 text-[11px] border', priority === p ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-200' : 'border-ink-600 text-ink-300 hover:bg-ink-800')}>{p}</button>
        ))}
        <span className="flex-1" />
        <Button variant="primary" onClick={submit} disabled={!title.trim()} title="⌘↵"><Send size={12} />Queue</Button>
      </div>
    </Section>
  )
}
