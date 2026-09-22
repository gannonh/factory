/**
 * Shared fixture for the API-level vitest suites: a manual-mode MockServer
 * driven through the in-process API. The default fixture isolates the seeded
 * graph by disabling the periodic triggers and removing the seeded handoff
 * edges so tests build their own graphs; pass `isolate: false` to keep the
 * seed intact. The injected rng (0.5) makes every run last 12.5s of simulated
 * time and succeed. `sim.advance` is the in-process clock and is not a network
 * command.
 */
import { createApi, type InProcessApi } from '../server/api'
import { MockServer } from '../server/simulation'
import type { AgentId, FactoryEvent, SandboxId, Task, TaskId, World } from '../src/domain/types'

export const RNG = () => 0.5
export const sb = (id: string) => id as SandboxId

export type Fixture = {
  server: MockServer
  api: InProcessApi
  world: () => World
  agent: (name: string) => AgentId
  task: (id: TaskId) => Task
  firstTask: (agentId: AgentId) => Task
  events: () => FactoryEvent[]
  runs: () => World['runs']
}

export function makeFixture(options: { isolate?: boolean } = {}): Fixture {
  const server = new MockServer({ manual: true, rng: RNG })
  const api = createApi(server)
  let latest = server.snapshot()
  api.subscribe((w) => { latest = w })
  const world = (): World => latest
  const agent = (name: string): AgentId => {
    const found = Object.values(latest.agents).find((a) => a.name === name)
    if (!found) throw new Error(`no agent named ${name}`)
    return found.id
  }
  const task = (id: TaskId): Task => {
    const t = latest.tasks[id]
    if (!t) throw new Error(`no task ${id}`)
    return t
  }
  const firstTask = (agentId: AgentId): Task => {
    const t = Object.values(latest.tasks).find((x) => x.agentId === agentId)
    if (!t) throw new Error(`no task for agent ${agentId}`)
    return t
  }
  if (options.isolate ?? true) {
    for (const tr of Object.values(latest.triggers)) api.triggers.update(tr.id, { enabled: false })
    api.graph.removeEdges(Object.values(latest.edges).filter((e) => e.kind === 'handoff').map((e) => e.id))
  }
  return {
    server,
    api,
    world,
    agent,
    task,
    firstTask,
    events: () => latest.events,
    runs: () => latest.runs,
  }
}
