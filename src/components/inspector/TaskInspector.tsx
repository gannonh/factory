import { TASK_STATUS_COLOR, taskOriginLabel, type Task } from '../../domain/types'
import { useStore } from '../../store'
import { Badge, Dot, Section, fmtDuration } from '../ui'
import { TaskInputSection } from './TaskInputSection'

const RUN_STATUS_COLOR = { running: '#22d3ee', succeeded: '#34d399', failed: '#f87171' } as const

export function TaskInspector({ task }: { task: Task }) {
  const world = useStore((state) => state.world)
  const select = useStore((state) => state.select)
  const agent = world.agents[task.agentId]
  const runs = Object.values(world.runs).filter((run) => run.taskId === task.id).sort((a, b) => a.startedAt - b.startedAt)

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-semibold leading-snug break-words">{task.title}</div>
        <div className="flex items-center justify-between gap-2">
          <Badge color={TASK_STATUS_COLOR[task.status]}><Dot color={TASK_STATUS_COLOR[task.status]} pulse={task.status === 'running'} />{task.status}</Badge>
          <span className="font-mono text-[10px] text-ink-500">{task.id}</span>
        </div>
      </div>

      <Section title="Details">
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-xs">
          <dt className="text-ink-400">Agent</dt>
          <dd>{agent?.name ?? `Deleted agent (${task.agentId})`}</dd>
          <dt className="text-ink-400">Priority</dt>
          <dd>{task.priority}</dd>
          <dt className="text-ink-400">Origin</dt>
          <dd>{taskOriginLabel(world, task.origin)}</dd>
          {task.blockedOn && (
            <>
              <dt className="text-ink-400">Waiting on</dt>
              <dd className="text-amber-300/90">{task.blockedOn}</dd>
            </>
          )}
          <dt className="text-ink-400">Attempts</dt>
          <dd className="font-mono tabular-nums">{task.attempts}</dd>
        </dl>
      </Section>

      <Section title="Prompt">
        <div className="rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-ink-200">{task.prompt}</div>
      </Section>

      {task.input && <TaskInputSection input={task.input} />}

      <Section title="Runs" right={<span className="font-mono text-[10px] text-ink-500">{runs.length}</span>}>
        {runs.length === 0
          ? <div className="rounded-md border border-ink-700 bg-ink-850 px-2.5 py-4 text-center text-[11px] text-ink-500">No runs yet.</div>
          : <div className="flex flex-col gap-1.5">
              {runs.map((run) => (
                <button key={run.id} onClick={() => select({ kind: 'run', id: run.id })} className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 text-xs text-left hover:border-cyan-400/40">
                  <Badge color={RUN_STATUS_COLOR[run.status]}><Dot color={RUN_STATUS_COLOR[run.status]} pulse={run.status === 'running'} />{run.status}</Badge>
                  <span className="text-ink-400">attempt {run.attempt}</span>
                  <span className="ml-auto font-mono tabular-nums text-ink-300">{fmtDuration((run.endedAt ?? world.now) - run.startedAt)}</span>
                </button>
              ))}
            </div>}
      </Section>
    </>
  )
}
