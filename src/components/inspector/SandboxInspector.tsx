import { useState } from 'react'
import { api } from '../../api/client'
import type { Sandbox } from '../../domain/types'
import { useStore } from '../../store'
import { Field, Input, Section } from '../ui'
import { SandboxCard } from '../sandboxes/SandboxCard'

export function SandboxInspector({ sandbox }: { sandbox: Sandbox }) {
  const [editing, setEditing] = useState<{ id: Sandbox['id']; draft: string } | null>(null)
  const draft = editing?.id === sandbox.id ? editing.draft : String(sandbox.capacity)
  const setDraft = (value: string) => setEditing({ id: sandbox.id, draft: value })
  const commit = () => {
    api.sandboxes.update(sandbox.id, { capacity: Number(draft) })
    setDraft(String(useStore.getState().world.sandboxes[sandbox.id]?.capacity ?? sandbox.capacity))
  }
  return (
    <>
      <SandboxCard sandbox={sandbox} expanded />
      <Section title="Config">
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
