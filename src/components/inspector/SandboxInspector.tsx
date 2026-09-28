import { useState } from 'react'
import type { Sandbox } from '../../domain/types'
import { history } from '../../store'
import { Field, Input, Section } from '../ui'
import { SandboxCard } from '../sandboxes/SandboxCard'

export function SandboxInspector({ sandbox }: { sandbox: Sandbox }) {
  const [editing, setEditing] = useState<{ id: Sandbox['id']; draft: string } | null>(null)
  const [rootEditing, setRootEditing] = useState<{ id: Sandbox['id']; draft: string } | null>(null)
  const draft = editing?.id === sandbox.id ? editing.draft : String(sandbox.capacity)
  const setDraft = (value: string) => setEditing({ id: sandbox.id, draft: value })
  const commit = () => {
    history.updateSandbox(sandbox.id, { capacity: Number(draft) })
    setEditing(null)
  }
  return (
    <>
      <SandboxCard sandbox={sandbox} expanded />
      <Section title="Config">
        {sandbox.kind === 'local' && <Field label="Root directory" hint="absolute path on the server">
          <Input
            value={rootEditing?.id === sandbox.id ? rootEditing.draft : sandbox.host}
            onChange={(e) => setRootEditing({ id: sandbox.id, draft: e.target.value })}
            onBlur={() => { if (rootEditing?.id === sandbox.id && rootEditing.draft.startsWith('/')) history.updateSandbox(sandbox.id, { host: rootEditing.draft }); setRootEditing(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
        </Field>}
        <Field label="Capacity" hint="max leases">
          <Input
            type="number"
            min={1}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
          />
        </Field>
      </Section>
    </>
  )
}
