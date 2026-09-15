import { ExternalLink } from 'lucide-react'
import type { Artifact, TaskInput } from '../../domain/types'
import { useStore } from '../../store'
import { Section } from '../ui'

export function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {artifacts.map((artifact, index) => {
        const content = (
          <>
            <span className="text-[10px] uppercase tracking-wider text-ink-400">{artifact.kind}</span>
            <span className="min-w-0 flex-1 truncate">{artifact.label}</span>
            {artifact.url && <ExternalLink size={11} className="shrink-0 text-cyan-300" />}
          </>
        )
        return artifact.url
          ? <a key={`${artifact.kind}-${index}`} href={artifact.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 text-xs hover:border-cyan-400/40">{content}</a>
          : <div key={`${artifact.kind}-${index}`} className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 text-xs">{content}</div>
      })}
    </div>
  )
}

export function TaskInputSection({ input }: { input: TaskInput }) {
  const world = useStore((state) => state.world)
  const select = useStore((state) => state.select)
  const run = world.runs[input.runId]
  const shortId = input.runId.slice(-6)
  return (
    <Section title="Input">
      <p className="text-xs leading-relaxed text-ink-200">{input.summary}</p>
      <ArtifactList artifacts={input.artifacts} />
      {run
        ? <button onClick={() => select({ kind: 'run', id: run.id })} className="self-start text-[11px] text-cyan-300 hover:underline">from {world.agents[run.agentId]?.name ?? `Deleted agent (${run.agentId})`} run {shortId}</button>
        : <span className="text-[11px] text-ink-500">from run {shortId} (no longer retained)</span>}
    </Section>
  )
}
