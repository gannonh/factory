import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { recommendedPickupState, type IntakePreview, type LinearSettings, type LinearTeam, type Trigger } from '../../domain/types'
import { Button, Field, IssueLink, Section, Select } from '../ui'

type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

function useLoaded<T>(load: () => T | PromiseLike<T>): Loaded<T> {
  const [result, setResult] = useState<{ load: typeof load; state: Loaded<T> } | null>(null)
  useEffect(() => {
    let current = true
    Promise.resolve(load()).then(
      (value) => { if (current) setResult({ load, state: { status: 'ready', value } }) },
      (error: unknown) => { if (current) setResult({ load, state: { status: 'error', message: error instanceof Error ? error.message : 'Linear request failed' } }) },
    )
    return () => { current = false }
  }, [load])
  return result?.load === load ? result.state : { status: 'loading' }
}

const loadCatalog = () => api.linear.catalog()

function Preview({ settings }: { settings: LinearSettings }) {
  const { team, project, pickupState } = settings
  const load = useCallback(() => api.linear.preview({ team, project, pickupState }), [team, project, pickupState])
  const preview = useLoaded<IntakePreview>(load)
  if (preview.status === 'loading') return <div className="text-[11px] text-ink-400">Checking Linear…</div>
  if (preview.status === 'error') return <div className="text-[11px] text-red-300 break-words">{preview.message}</div>
  const { count, issues } = preview.value
  return (
    <div className="flex flex-col gap-1.5 text-[11px]">
      <div className="text-ink-200">{count} {count === 1 ? 'issue matches' : 'issues match'}</div>
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((issue) => (
            <li key={issue.identifier} className="flex gap-2 min-w-0">
              <IssueLink issue={issue} />
              <span className="truncate text-ink-300" title={issue.title}>{issue.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function LinearSection({ trigger, update }: { trigger: Trigger; update: (patch: { linear: LinearSettings }) => Promise<unknown> }) {
  const catalog = useLoaded(loadCatalog)
  const [draftTeam, setDraftTeam] = useState<string | null>(null)
  const { linear } = trigger
  const teamId = draftTeam ?? linear?.team ?? ''

  let body
  if (catalog.status === 'loading') body = <div className="text-[11px] text-ink-400">Loading teams…</div>
  else if (catalog.status === 'error') body = <div className="text-[11px] text-red-300 break-words">{catalog.message}</div>
  else {
    const teams = catalog.value.teams
    const team: LinearTeam | undefined = teams.find((t) => t.id === teamId)
    const states = [...(team?.states ?? [])].sort((a, b) => a.position - b.position)
    const recommended = team ? recommendedPickupState(team.states) : null
    const pickup = draftTeam ? '' : linear?.pickupState ?? ''

    const chooseTeam = (id: string) => {
      if (id === linear?.team) { setDraftTeam(null); return }
      const next = teams.find((t) => t.id === id)
      const state = next ? recommendedPickupState(next.states) : null
      if (state === null) { setDraftTeam(id); return }
      setDraftTeam(null)
      void update({ linear: { team: id, project: null, pickupState: state } }).catch(() => {})
    }
    const chooseState = (state: string) => {
      setDraftTeam(null)
      void update({ linear: { team: teamId, project: draftTeam ? null : linear?.project ?? null, pickupState: state } }).catch(() => {})
    }

    body = (
      <>
        <Field label="Team">
          <Select value={teamId} onChange={(e) => chooseTeam(e.target.value)}>
            {teamId === '' && <option value="" disabled>Choose a team</option>}
            {teamId !== '' && !team && <option value={teamId}>{teamId}</option>}
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.key})</option>)}
          </Select>
        </Field>
        <Field label="Project">
          <Select
            value={draftTeam ? '' : linear?.project ?? ''}
            disabled={!linear || draftTeam !== null}
            onChange={(e) => { if (linear) void update({ linear: { ...linear, project: e.target.value || null } }).catch(() => {}) }}
          >
            <option value="">All projects</option>
            {linear?.project && !team?.projects.some((p) => p.id === linear.project) && <option value={linear.project}>{linear.project}</option>}
            {(team?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Pickup state" hint={linear && !draftTeam && pickup === recommended ? 'recommended' : undefined}>
          <Select value={pickup} disabled={!team} onChange={(e) => chooseState(e.target.value)}>
            {pickup === '' && <option value="" disabled>{team && recommended === null ? 'No Todo-type state; choose one' : 'Choose a state'}</option>}
            {pickup !== '' && !states.some((s) => s.id === pickup) && <option value={pickup}>{pickup}</option>}
            {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {linear && !draftTeam && recommended !== null && pickup !== recommended && (
          <Button size="xs" className="self-start" onClick={() => chooseState(recommended)}>Reset to recommended</Button>
        )}
      </>
    )
  }

  return (
    <>
      <Section title="Linear">{body}</Section>
      {linear && !draftTeam && !trigger.enabled && (
        <Section title="Preview">
          <Preview settings={linear} />
          <div className="text-[10px] text-ink-500">Enabling takes these issues and starts their tasks.</div>
        </Section>
      )}
    </>
  )
}
