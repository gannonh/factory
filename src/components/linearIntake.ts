import type { Trigger, World } from '../domain/types'

export type IntakeStatus = {
  polledAt: number | null
  taken: number
  /** Each open rework round of this trigger, such as "ENG-1 round 2". */
  rounds: string[]
  error: string | null
  idle: 'not configured' | 'disabled' | 'intake paused' | null
}

export function intakeStatus(world: World, trigger: Trigger): IntakeStatus {
  const poll = world.intakePolls[trigger.id]
  const records = Object.values(world.intake).filter((record) => record.trigger === trigger.id)
  return {
    polledAt: poll?.at ?? null,
    taken: records.length,
    rounds: records.filter((r) => r.round > 1 && r.phase !== 'ended').map((r) => `${r.issue.identifier} round ${r.round}`),
    error: poll?.error?.message ?? null,
    idle: trigger.linear === null ? 'not configured' : !trigger.enabled ? 'disabled' : world.sim.paused ? 'intake paused' : null,
  }
}
