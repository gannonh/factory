import type { Trigger, World } from '../domain/types'

export type IntakeStatus = {
  /** wall-clock ms of the latest finished poll */
  polledAt: number | null
  taken: number
  error: string | null
  /** why the trigger is not polling, or null while it is */
  idle: 'not configured' | 'disabled' | 'intake paused' | null
}

export function intakeStatus(world: World, trigger: Trigger): IntakeStatus {
  const poll = world.intakePolls[trigger.id]
  return {
    polledAt: poll?.at ?? null,
    taken: Object.values(world.intake).filter((record) => record.trigger === trigger.id).length,
    error: poll?.error?.message ?? null,
    idle: trigger.linear === null ? 'not configured' : !trigger.enabled ? 'disabled' : world.sim.paused ? 'intake paused' : null,
  }
}
