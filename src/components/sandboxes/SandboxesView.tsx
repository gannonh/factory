import { Plus } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import type { SandboxKind } from '../../domain/types'
import { useStore } from '../../store'
import { Button, Field, Input, Kpi, Select } from '../ui'
import { SandboxCard } from './SandboxCard'

export function SandboxesView() {
  const world = useStore((s) => s.world)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const [creating, setCreating] = useState(false)
  const sandboxes = Object.values(world.sandboxes)
  const running = sandboxes.filter((s) => s.state === 'running')
  const totalLeases = running.reduce((a, s) => a + s.leases.length, 0)
  const totalCapacity = running.reduce((a, s) => a + s.capacity, 0)
  const avgCpu = running.length ? running.reduce((a, s) => a + s.metrics.cpu, 0) / running.length : 0
  return (
    <div className="absolute inset-0 overflow-y-auto p-4 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold">Sandboxes</h2>
        <span className="text-xs text-ink-400">local · docker · VPS · remote hosts agents lease for runs</span>
        <span className="flex-1" />
        <Button variant="primary" onClick={() => setCreating((c) => !c)}><Plus size={13} />New sandbox</Button>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Kpi label="pool" value={sandboxes.length} sub={`${running.length} running`} />
        <Kpi label="leased" value={`${totalLeases}/${totalCapacity}`} sub="leases / capacity" color={totalLeases ? '#22d3ee' : undefined} />
        <Kpi label="avg cpu" value={`${Math.round(avgCpu)}%`} sub="running hosts" />
        <Kpi label="provisioning" value={sandboxes.filter((s) => s.state === 'provisioning' || s.state === 'rebuilding').length} sub="in flight" color="#38bdf8" />
      </div>
      {creating && <CreateForm onDone={() => setCreating(false)} />}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {sandboxes.map((sb) => (
          <SandboxCard key={sb.id} sandbox={sb} selected={selection?.id === sb.id} onClick={() => select({ kind: 'sandbox', id: sb.id })} />
        ))}
      </div>
      {sandboxes.length === 0 && <div className="text-sm text-ink-500">No sandboxes. Create one to give agents somewhere to run.</div>}
    </div>
  )
}

const HOST_HINT: Record<SandboxKind, string> = { local: 'localhost', docker: 'docker.internal', vps: '203.0.113.10', remote: 'build-07.corp' }

function CreateForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SandboxKind>('docker')
  const [host, setHost] = useState(HOST_HINT.docker)
  const [image, setImage] = useState('ghcr.io/factory/dev:node22')
  const [capacity, setCapacity] = useState('1')
  const submit = () => {
    if (!name.trim()) return
    api.sandboxes.create({ name: name.trim(), kind, host: host.trim() || HOST_HINT[kind], image: image.trim(), capacity: Number(capacity) || 1 })
    onDone()
  }
  return (
    <div className="rounded-xl border border-cyan-400/30 bg-ink-850 p-3 grid grid-cols-[1fr_120px_1fr_1fr_90px_auto] gap-2 items-end">
      <Field label="Name"><Input autoFocus placeholder="builder-b" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} /></Field>
      <Field label="Kind">
        <Select value={kind} onChange={(e) => { const k = e.target.value as SandboxKind; setKind(k); setHost(HOST_HINT[k]) }}>
          <option value="local">local</option><option value="docker">docker</option><option value="vps">vps</option><option value="remote">remote</option>
        </Select>
      </Field>
      <Field label="Host"><Input value={host} onChange={(e) => setHost(e.target.value)} /></Field>
      <Field label="Image"><Input value={image} onChange={(e) => setImage(e.target.value)} /></Field>
      <Field label="Capacity"><Input type="number" min={1} step={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} /></Field>
      <div className="flex gap-1.5">
        <Button variant="primary" onClick={submit} disabled={!name.trim()}>Provision</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  )
}
