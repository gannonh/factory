import { LOG_LEVEL_COLOR, type Run } from '../../domain/types'
import { useStore } from '../../store'
import { Badge, Dot, Section, fmtDuration, fmtTime } from '../ui'
import { ArtifactList, TaskInputSection } from './TaskInputSection'

const STATUS_COLOR = { running: '#22d3ee', succeeded: '#34d399', failed: '#f87171' } as const

export function RunInspector({ run }: { run: Run }) {
  const world = useStore((state) => state.world)
  const agent = world.agents[run.agentId]
  const sandbox = world.sandboxes[run.sandboxId]
  const input = world.tasks[run.taskId]?.input ?? null
  const logs = world.logs.filter((line) => line.runId === run.id)
  const elapsedMs = (run.endedAt ?? world.now) - run.startedAt

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-semibold leading-snug break-words">{run.title}</div>
        <div className="flex items-center justify-between gap-2">
          <Badge color={STATUS_COLOR[run.status]}><Dot color={STATUS_COLOR[run.status]} pulse={run.status === 'running'} />{run.status}</Badge>
          <span className="font-mono text-[10px] text-ink-500">{run.id}</span>
        </div>
      </div>

      <Section title="Details">
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-xs">
          <dt className="text-ink-400">Agent</dt>
          <dd>{agent?.name ?? `Deleted agent (${run.agentId})`}</dd>
          <dt className="text-ink-400">Sandbox</dt>
          <dd>{sandbox?.name ?? `Deleted sandbox (${run.sandboxId})`}</dd>
          <dt className="text-ink-400">Attempt</dt>
          <dd className="font-mono tabular-nums">{run.attempt}</dd>
          <dt className="text-ink-400">Started</dt>
          <dd className="font-mono tabular-nums">{fmtTime(run.startedAt)}</dd>
          <dt className="text-ink-400">Duration</dt>
          <dd className="font-mono tabular-nums">{fmtDuration(elapsedMs)}</dd>
          <dt className="text-ink-400">Tokens</dt>
          <dd className="font-mono tabular-nums">{run.tokens.toLocaleString()}</dd>
        </dl>
      </Section>

      {run.status === 'failed' && run.error && (
        <Section title="Failure reason">
          <div className="rounded-md border border-red-400/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-200 break-words">{run.error}</div>
        </Section>
      )}

      {input && <TaskInputSection input={input} />}

      {run.status === 'succeeded' && run.output && (
        <Section title="Output">
          <p className="text-xs leading-relaxed text-ink-200">{run.output.summary}</p>
          <ArtifactList artifacts={run.output.artifacts} />
        </Section>
      )}

      <Section title="Logs" right={<span className="font-mono text-[10px] text-ink-500">{logs.length} lines</span>}>
        {logs.length === 0
          ? <div className="rounded-md border border-ink-700 bg-ink-850 px-2.5 py-4 text-center text-[11px] text-ink-500">logs are kept for the current session</div>
          : <div className="flex flex-col gap-0.5 font-mono text-[10px] leading-4">
              {logs.map((line) => (
                <div key={line.id} className="grid grid-cols-[58px_38px_1fr] gap-1.5 rounded px-1 py-0.5 hover:bg-ink-850">
                  <span className="text-ink-500 tabular-nums">{fmtTime(line.ts)}</span>
                  <span className="uppercase" style={{ color: LOG_LEVEL_COLOR[line.level] }}>{line.level}</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words text-ink-200">{line.msg}</span>
                </div>
              ))}
            </div>}
      </Section>
    </>
  )
}
