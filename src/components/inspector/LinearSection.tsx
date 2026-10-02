import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { recommendedPickupState, type IntakePreview, type LinearSettings, type Trigger } from '../../domain/types'
import { Button, Field, IssueLink, Section, Select } from '../ui'

type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

/** Loads on mount and when `load` changes, then again every `refreshMs` while mounted, keeping the shown value until the next one arrives. */
function useLoaded<T>(load: () => T | PromiseLike<T>, refreshMs?: number): Loaded<T> {
  const [result, setResult] = useState<{ load: typeof load; state: Loaded<T> } | null>(null)
  useEffect(() => {
    let current = true
    const run = () => Promise.resolve(load()).then(
      (value) => { if (current) setResult({ load, state: { status: 'ready', value } }) },
      (error: unknown) => { if (current) setResult({ load, state: { status: 'error', message: error instanceof Error ? error.message : 'Linear request failed' } }) },
    )
    void run()
    const timer = refreshMs === undefined ? undefined : setInterval(() => void run(), refreshMs)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [load, refreshMs])
  return result?.load === load ? result.state : { status: 'loading' }
}

const loadCatalog = () => api.linear.catalog()
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

export function LinearSection({ trigger, update }: { trigger: Trigger; update: (patch: { linear: LinearSettings }) => Promise<unknown> }) {
  const catalog = useLoaded(loadCatalog)
  const [teamAwaitingState, setTeamAwaitingState] = useState<string | null>(null)
  const { linear } = trigger
  const teamId = teamAwaitingState ?? linear?.team ?? ''

  let body
  if (catalog.status === 'loading') body = <div className="text-[11px] text-ink-400">Loading teams…</div>
  else if (catalog.status === 'error') body = <div className="text-[11px] text-red-300 break-words">{catalog.message}</div>
  else {
    const teams = catalog.value.teams
    const team = teams.find((t) => t.id === teamId)
    const states = [...(team?.states ?? [])].sort((a, b) => a.position - b.position)
    const recommended = team ? recommendedPickupState(team.states) : null
    const pickup = teamAwaitingState ? '' : linear?.pickupState ?? ''

    const chooseTeam = (id: string) => {
      if (id === linear?.team) { setTeamAwaitingState(null); return }
      const next = teams.find((t) => t.id === id)
      const state = next ? recommendedPickupState(next.states) : null
      if (state === null) { setTeamAwaitingState(id); return }
      setTeamAwaitingState(null)
      void update({ linear: { team: id, project: null, pickupState: state } }).catch(() => {})
    }
    const chooseState = (state: string) => {
      setTeamAwaitingState(null)
      void update({ linear: { team: teamId, project: teamAwaitingState ? null : linear?.project ?? null, pickupState: state } }).catch(() => {})
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
            value={teamAwaitingState ? '' : linear?.project ?? ''}
            disabled={!linear || teamAwaitingState !== null}
            onChange={(e) => { if (linear) void update({ linear: { ...linear, project: e.target.value || null } }).catch(() => {}) }}
          >
            <option value="">All projects</option>
            {linear?.project && !team?.projects.some((p) => p.id === linear.project) && <option value={linear.project}>{linear.project}</option>}
            {(team?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Pickup state" hint={linear && !teamAwaitingState && pickup === recommended ? 'recommended' : undefined}>
          <Select value={pickup} disabled={!team} onChange={(e) => chooseState(e.target.value)}>
            {pickup === '' && <option value="" disabled>{team && recommended === null ? 'No Todo-type state; choose one' : 'Choose a state'}</option>}
            {pickup !== '' && !states.some((s) => s.id === pickup) && <option value={pickup}>{pickup}</option>}
            {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {linear && !teamAwaitingState && recommended !== null && pickup !== recommended && (
          <Button size="xs" className="self-start" onClick={() => chooseState(recommended)}>Reset to recommended</Button>
        )}
      </>
    )
  }

  return (
    <>
      <Section title="Linear">{body}</Section>
      {linear && !teamAwaitingState && !trigger.enabled && (
        <Section title="Preview">
          <Preview settings={linear} />
          <div className="text-[10px] text-ink-500">Enabling takes these issues and starts their tasks.</div>
        </Section>
      )}
    </>
  )
}
