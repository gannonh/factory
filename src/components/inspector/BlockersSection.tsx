import { blockerDone, type IntakeRecord } from '../../domain/types'
import { Badge, IssueLink, Section } from '../ui'

const DONE = '#34d399'
const OPEN = '#fbbf24'

/** The issues that block the flow's Linear issue, each linked, with its state when Factory last read it. */
export function BlockersSection({ record }: { record: IntakeRecord }) {
  const open = record.blockers.filter((b) => !blockerDone(b)).length
  return (
    <Section title="Blocked by" right={<span className="font-mono text-[10px] text-ink-500">{open} of {record.blockers.length} unfinished</span>}>
      <ul className="flex flex-col gap-1.5">
        {record.blockers.map((blocker) => (
          <li key={blocker.id} className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 text-xs">
            <IssueLink issue={blocker} />
            <Badge color={blockerDone(blocker) ? DONE : OPEN} className="ml-auto">{blocker.state.name}</Badge>
          </li>
        ))}
      </ul>
      {record.phase !== 'taken' && <div className="text-[10px] text-ink-500">States as of the flow’s first run. Factory stops reading them once a run starts.</div>}
    </Section>
  )
}
