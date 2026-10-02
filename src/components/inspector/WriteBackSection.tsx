import { api } from '../../api/client'
import type { IntakeRecord, IssueWrite, LinearCatalog, WriteStatus } from '../../domain/types'
import { useWallNow } from '../../useWallNow'
import { Badge, Section, fmtAgo } from '../ui'
import { useLoaded } from './useLoaded'

const STATUS_COLOR: Record<WriteStatus['state'], string> = { pending: '#94a3b8', landed: '#34d399', failed: '#f87171' }

function writeLabel(write: IssueWrite, stateName: (id: string) => string): string {
  if (write.kind === 'move') return `Move to ${write.step} state (${stateName(write.stateId)})`
  return write.outcome === 'finished' ? 'Completion note' : 'Failure note'
}

const CATALOG_TTL_MS = 60_000
const NO_CATALOG = () => Promise.resolve<LinearCatalog>({ teams: [] })
let cached: { at: number; catalog: Promise<LinearCatalog> } | null = null

/** One catalog request per minute is shared by every selection, and a failed one is not kept. */
function loadStateNames(): Promise<LinearCatalog> {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog
  const entry = { at: Date.now(), catalog: Promise.resolve(api.linear.catalog()) }
  entry.catalog.catch(() => { if (cached === entry) cached = null })
  cached = entry
  return entry.catalog
}

/** What Factory has written to the flow's Linear issue, in order, with each write's status. */
export function WriteBackSection({ record }: { record: IntakeRecord }) {
  const catalog = useLoaded(record.writes.some((w) => w.kind === 'move') ? loadStateNames : NO_CATALOG)
  const wallNow = useWallNow()
  const states = catalog.status === 'ready' ? catalog.value.teams.flatMap((t) => t.states) : []
  const stateName = (id: string) => states.find((s) => s.id === id)?.name ?? id

  return (
    <Section title="Linear write-back" right={<span className="font-mono text-[10px] text-ink-500">{record.phase}</span>}>
      {record.writes.length === 0
        ? <div className="rounded-md border border-ink-700 bg-ink-850 px-2.5 py-3 text-center text-[11px] text-ink-500">Phase {record.phase} · nothing written{record.phase === 'ended' ? '' : ' yet'}.</div>
        : <ol className="flex flex-col gap-1.5">
            {record.writes.map((write, i) => (
              <li key={i} className="flex flex-col gap-1 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-ink-200">{writeLabel(write, stateName)}</span>
                  <Badge color={STATUS_COLOR[write.status.state]} className="ml-auto">{write.status.state}</Badge>
                </div>
                {write.status.state === 'failed' && <div className="text-[11px] text-red-300 break-words">{write.status.error}</div>}
                {write.status.state !== 'pending' && (
                  <div className="text-[10px] text-ink-500">
                    {write.status.state === 'failed' ? `failed ${fmtAgo(wallNow, write.status.at)} · retries on the next poll` : `landed ${fmtAgo(wallNow, write.status.at)}`}
                  </div>
                )}
              </li>
            ))}
          </ol>}
    </Section>
  )
}
