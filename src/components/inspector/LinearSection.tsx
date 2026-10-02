import { useCallback, useState } from 'react'
import { api } from '../../api/client'
import { recommendedStates, type IntakePreview, type LinearSettings, type LinearTeam, type Trigger } from '../../domain/types'
import { Button, Field, IssueLink, Section, Select } from '../ui'
import { loadCatalog, useLoaded } from './useLoaded'

const PREVIEW_REFRESH_MS = 5000

function Preview({ settings }: { settings: LinearSettings }) {
  const { team, project, pickupState } = settings
  const load = useCallback(() => api.linear.preview({ team, project, pickupState }), [team, project, pickupState])
  const preview = useLoaded<IntakePreview>(load, PREVIEW_REFRESH_MS)
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

type LifecycleKey = 'startedState' | 'finishedState' | 'failedState'
const LIFECYCLE: Array<{ key: LifecycleKey; label: string }> = [
  { key: 'startedState', label: 'Started state' },
  { key: 'finishedState', label: 'Finished state' },
  { key: 'failedState', label: 'Failed state' },
]

/** A newly chosen team's settings: every project and the recommended lifecycle. */
function teamSettings(team: LinearTeam, pickupState: string): LinearSettings {
  const { startedState, finishedState, failedState } = recommendedStates(team.states)
  return { team: team.id, project: null, pickupState, startedState, finishedState, failedState }
}

export function LinearSection({ trigger, update }: { trigger: Trigger; update: (patch: { linear: LinearSettings }) => Promise<unknown> }) {
  const catalog = useLoaded(loadCatalog)
  const [teamAwaitingState, setTeamAwaitingState] = useState<string | null>(null)
  const { linear } = trigger
  const teamId = teamAwaitingState ?? linear?.team ?? ''
  const current = teamAwaitingState ? null : linear

  let body
  if (catalog.status === 'loading') body = <div className="text-[11px] text-ink-400">Loading teams…</div>
  else if (catalog.status === 'error') body = <div className="text-[11px] text-red-300 break-words">{catalog.message}</div>
  else {
    const teams = catalog.value.teams
    const team = teams.find((t) => t.id === teamId)
    const states = [...(team?.states ?? [])].sort((a, b) => a.position - b.position)
    const recommended = team ? recommendedStates(team.states) : null
    const pickup = current?.pickupState ?? ''

    const save = (settings: LinearSettings) => {
      setTeamAwaitingState(null)
      void update({ linear: settings }).catch(() => {})
    }
    const chooseTeam = (id: string) => {
      if (id === linear?.team) { setTeamAwaitingState(null); return }
      const next = teams.find((t) => t.id === id)
      const state = next ? recommendedStates(next.states).pickupState : null
      if (!next || state === null) { setTeamAwaitingState(id); return }
      save(teamSettings(next, state))
    }
    const chooseState = (state: string) => {
      if (current) save({ ...current, pickupState: state })
      else if (team) save(teamSettings(team, state))
    }
    const reset = current && recommended && {
      ...current,
      pickupState: recommended.pickupState ?? current.pickupState,
      startedState: recommended.startedState,
      finishedState: recommended.finishedState,
      failedState: recommended.failedState,
    }
    const resettable = reset && current && (['pickupState', ...LIFECYCLE.map((l) => l.key)] as const).some((key) => reset[key] !== current[key])

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
            value={current?.project ?? ''}
            disabled={!current}
            onChange={(e) => { if (current) save({ ...current, project: e.target.value || null }) }}
          >
            <option value="">All projects</option>
            {current?.project && !team?.projects.some((p) => p.id === current.project) && <option value={current.project}>{current.project}</option>}
            {(team?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Pickup state" hint={current && pickup === recommended?.pickupState ? 'recommended' : undefined}>
          <Select value={pickup} disabled={!team} onChange={(e) => chooseState(e.target.value)}>
            {pickup === '' && <option value="" disabled>{team && recommended?.pickupState === null ? 'No Todo-type state; choose one' : 'Choose a state'}</option>}
            {pickup !== '' && !states.some((s) => s.id === pickup) && <option value={pickup}>{pickup}</option>}
            {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {LIFECYCLE.map(({ key, label }) => {
          const value = current?.[key] ?? null
          return (
            <Field key={key} label={label} hint={current && recommended && value === recommended[key] ? 'recommended' : undefined}>
              <Select value={value ?? ''} disabled={!current} onChange={(e) => { if (current) save({ ...current, [key]: e.target.value || null }) }}>
                <option value="">Leave unchanged</option>
                {value !== null && !states.some((s) => s.id === value) && <option value={value}>{value}</option>}
                {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          )
        })}
        <div className="text-[10px] text-ink-500">Factory moves the issue when its flow starts and ends, then posts one note.</div>
        {reset && resettable && (
          <Button size="xs" className="self-start" onClick={() => save(reset)}>Reset to recommended</Button>
        )}
      </>
    )
  }

  return (
    <>
      <Section title="Linear">{body}</Section>
      {current && !trigger.enabled && (
        <Section title="Preview">
          <Preview settings={current} />
          <div className="text-[10px] text-ink-500">Enabling takes these issues and starts their tasks.</div>
        </Section>
      )}
    </>
  )
}
