import type { Agent, AgentId, Edge, EdgeId, Sandbox, SandboxId, Trigger, TriggerId, World } from './types'

const a = (id: string) => id as AgentId
const s = (id: string) => id as SandboxId
const t = (id: string) => id as TriggerId
const e = (id: string) => id as EdgeId

function agent(p: Partial<Agent> & Pick<Agent, 'id' | 'name' | 'role' | 'position'>): Agent {
  return {
    model: 'claude-sonnet-5',
    temperature: 0.2,
    concurrency: 1,
    timeoutMs: 120_000,
    retry: { maxAttempts: 3, backoffMs: 2000, backoff: 'exponential' },
    tools: ['read_file', 'write_file', 'bash'],
    systemPrompt: `You are ${p.name}, the ${p.role} for this team. Work in the assigned sandbox and hand off when done.`,
    status: 'idle',
    completed: 0,
    failed: 0,
    ...p,
  }
}

function sandbox(p: Partial<Sandbox> & Pick<Sandbox, 'id' | 'name' | 'kind' | 'host' | 'position'>): Sandbox {
  return {
    image: 'ghcr.io/factory/dev:node22',
    state: 'running',
    stateSince: 0,
    progress: 1,
    metrics: { cpu: 5, mem: 22, disk: 31 },
    history: [],
    leases: [],
    capacity: 1,
    restartPending: false,
    ...p,
  }
}

export function seedWorld(now: number): World {
  const agents: Agent[] = [
    agent({ id: a('ag-planner'), name: 'Planner', role: 'tech lead', model: 'claude-opus-5', position: { x: 320, y: 60 }, tools: ['read_file', 'search', 'linear'] }),
    agent({ id: a('ag-coder'), name: 'Coder', role: 'implementer', concurrency: 2, position: { x: 320, y: 260 } }),
    agent({ id: a('ag-reviewer'), name: 'Reviewer', role: 'code reviewer', model: 'claude-fable-5-1', temperature: 0, position: { x: 640, y: 260 }, tools: ['read_file', 'git_diff', 'gh'] }),
    agent({ id: a('ag-qa'), name: 'QA', role: 'test engineer', model: 'claude-haiku-4-5-20251001', position: { x: 640, y: 60 }, tools: ['bash', 'playwright'] }),
  ]
  const sandboxes: Sandbox[] = [
    sandbox({ id: s('sb-local-1'), name: 'mac-studio', kind: 'local', host: 'localhost', capacity: 1, position: { x: 320, y: 470 } }),
    sandbox({ id: s('sb-docker-1'), name: 'builder-a', kind: 'docker', host: 'docker.internal', capacity: 2, position: { x: 640, y: 470 } }),
    sandbox({ id: s('sb-vps-1'), name: 'hetzner-cx32', kind: 'vps', host: '65.21.14.7', image: 'ubuntu-24.04', capacity: 4, position: { x: 960, y: 470 }, state: 'stopped', progress: 0 }),
  ]
  const triggers: Trigger[] = [
    { id: t('tr-cron'), name: 'Nightly sweep', kind: 'cron', intervalMs: 18_000, enabled: true, lastFiredAt: null, fired: 0, template: 'Sweep open issues and plan the next batch', position: { x: 40, y: 60 } },
    { id: t('tr-webhook'), name: 'GitHub PR opened', kind: 'webhook', intervalMs: 26_000, enabled: true, lastFiredAt: null, fired: 0, template: 'Review the newly opened pull request', position: { x: 40, y: 260 } },
  ]
  const edges: Edge[] = [
    { id: e('ed-1'), kind: 'triggers', source: t('tr-cron'), target: a('ag-planner') },
    { id: e('ed-2'), kind: 'handoff', source: a('ag-planner'), target: a('ag-coder') },
    { id: e('ed-3'), kind: 'handoff', source: a('ag-coder'), target: a('ag-reviewer') },
    { id: e('ed-4'), kind: 'depends-on', source: a('ag-reviewer'), target: a('ag-qa') },
    { id: e('ed-5'), kind: 'triggers', source: t('tr-webhook'), target: a('ag-reviewer') },
    { id: e('ed-6'), kind: 'runs-in', source: a('ag-coder'), target: s('sb-local-1') },
    { id: e('ed-7'), kind: 'runs-in', source: a('ag-coder'), target: s('sb-docker-1') },
    { id: e('ed-8'), kind: 'runs-in', source: a('ag-reviewer'), target: s('sb-docker-1') },
    { id: e('ed-9'), kind: 'runs-in', source: a('ag-planner'), target: s('sb-local-1') },
    { id: e('ed-10'), kind: 'runs-in', source: a('ag-qa'), target: s('sb-vps-1') },
  ]
  const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x])) as Record<string, T>
  return {
    now,
    agents: byId(agents),
    sandboxes: byId(sandboxes.map((sb) => ({ ...sb, stateSince: now }))),
    triggers: byId(triggers),
    edges: byId(edges),
    tasks: {},
    runs: {},
    logs: [],
    events: [],
    sim: { paused: false, speed: 1 },
  }
}

export const TOOL_CATALOG = [
  'read_file', 'write_file', 'bash', 'search', 'git_diff', 'gh', 'linear', 'playwright', 'browser', 'sql', 'slack', 'http',
]
