import type { IntakeRecord } from '../../domain/types'

/** Why the listed blocker states may be stale, or null while Factory still reads them on each poll. */
export function blockerStatesNote(record: Pick<IntakeRecord, 'phase' | 'cancel'>): string | null {
  if (record.phase === 'taken' && record.cancel === null) return null
  return 'States as Factory last read them. Factory stops reading them once the flow starts or is cancelled.'
}
