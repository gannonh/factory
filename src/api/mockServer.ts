import { seedWorld } from '../domain/seed'
import {
  EDGE_RULES,
  SANDBOX_TIMED,
  SANDBOX_TRANSITIONS,
  edgeKindFor,
  nodeKindOf,
  type Agent,
  type AgentId,
  type EdgeId,
  type EdgeKind,
  type FactoryEvent,
  type LogLevel,
  type NodeId,
  type NodeKind,
  type Position,
  type Priority,
  type Run,
  type RunId,
  type RunOutput,
  type Sandbox,
  type SandboxAction,
  type SandboxId,
  type SandboxKind,
  type Subject,
  type Task,
  type TaskId,
  type Trigger,
  type TriggerId,
  type World,
} from '../domain/types'

const STORAGE_KEY = 'factory.world.v1'
const TICK_MS = 400
const MAX_LOGS = 2000
const MAX_EVENTS = 400
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 }

let seq = 0
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

const RUN_LOG_LINES: Array<[LogLevel, string]> = [
  ['debug', 'tool call read_file src/index.ts'],
  ['debug', 'tool call bash: npm test -- --filter=unit'],
  ['info', 'planning step complete, 3 sub-steps'],
  ['info', 'wrote 42 lines to src/components/Form.tsx'],
  ['info', 'tests passed (18/18)'],
  ['debug', 'context window 38% used'],
  ['warn', 'retrying tool call after transient error (ECONNRESET)'],
  ['warn', 'lint reported 2 warnings, continuing'],
  ['info', 'opened draft PR #412'],
  ['debug', 'cache hit for prompt prefix'],
  ['info', 'handoff payload prepared'],
  ['error', 'tool call failed: permission denied on /etc/hosts'],
]

type RunCompletion =
  | { status: 'succeeded'; agent: Pick<Agent, 'role' | 'tools'> }
  | { status: 'failed'; reason: string; retryable?: boolean }

function createRunOutput(run: Pick<Run, 'id' | 'title'>, agent: Pick<Agent, 'role' | 'tools'>): RunOutput {
  const summary = `The ${agent.role} completed "${run.title}".`
  if (!agent.tools.includes('gh') && !agent.tools.includes('git_diff')) {
    return { summary, artifacts: [{ kind: 'note', label: `Completion note for ${run.title}`, url: null }] }
  }

  const branch = `run/${run.id.slice(-6)}`
  const pullRequest = Number.parseInt(run.id.slice(-6), 36) % 10_000 + 1
  const repository = 'https://github.com/factory-demo/factory'
  return {
    summary,
    artifacts: [
      { kind: 'branch', label: branch, url: `${repository}/tree/${encodeURIComponent(branch)}` },
      { kind: 'pr', label: `Pull request #${pullRequest}`, url: `${repository}/pull/${pullRequest}` },
    ],
  }
}

type Listener = (world: World) => void

export class MockServer {
  private world: World
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.world = load() ?? seedWorld(Date.now())
    this.start()
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.world)
    return () => this.listeners.delete(fn)
  }

  snapshot(): World {
    return this.world
  }

  private start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  private publish() {
    this.world = { ...this.world }
    for (const fn of this.listeners) fn(this.world)
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      save(this.world)
    }, 1000)
  }

  // ---- writes -------------------------------------------------------------

  private patchAgent(id: AgentId, patch: Partial<Agent>) {
    const cur = this.world.agents[id]
    if (!cur) return
    this.world.agents = { ...this.world.agents, [id]: { ...cur, ...patch } }
  }
  private patchSandbox(id: SandboxId, patch: Partial<Sandbox>) {
    const cur = this.world.sandboxes[id]
    if (!cur) return
    this.world.sandboxes = { ...this.world.sandboxes, [id]: { ...cur, ...patch } }
  }
  private patchTrigger(id: TriggerId, patch: Partial<Trigger>) {
    const cur = this.world.triggers[id]
    if (!cur) return
    this.world.triggers = { ...this.world.triggers, [id]: { ...cur, ...patch } }
  }
  private patchTask(id: TaskId, patch: Partial<Task>) {
    const cur = this.world.tasks[id]
    if (!cur) return
    this.world.tasks = { ...this.world.tasks, [id]: { ...cur, ...patch } }
  }
  private patchRun(id: RunId, patch: Partial<Run>) {
    const cur = this.world.runs[id]
    if (!cur) return
    this.world.runs = { ...this.world.runs, [id]: { ...cur, ...patch } }
  }

  private log(level: LogLevel, msg: string, ref: { runId?: RunId; agentId?: AgentId } = {}) {
    const line = { id: ++seq, ts: this.world.now, level, runId: ref.runId ?? null, agentId: ref.agentId ?? null, msg }
    const logs = this.world.logs.length >= MAX_LOGS ? this.world.logs.slice(-MAX_LOGS + 1) : this.world.logs.slice()
    logs.push(line)
    this.world.logs = logs
  }

  private event(kind: FactoryEvent['kind'], subject: Subject, msg: string) {
    const ev = { id: ++seq, ts: this.world.now, kind, subject, msg }
    const events = this.world.events.length >= MAX_EVENTS ? this.world.events.slice(-MAX_EVENTS + 1) : this.world.events.slice()
    events.push(ev)
    this.world.events = events
  }

  // ---- public API ---------------------------------------------------------

  updatePositions(moves: Array<{ id: NodeId; position: Position }>) {
    for (const { id, position } of moves) {
      const kind = nodeKindOf(this.world, id)
      if (kind === 'agent') this.patchAgent(id as AgentId, { position })
      else if (kind === 'sandbox') this.patchSandbox(id as SandboxId, { position })
      else if (kind === 'trigger') this.patchTrigger(id as TriggerId, { position })
    }
    this.publish()
  }

  createNode(kind: NodeKind, position: Position): NodeId {
    const w = this.world
    if (kind === 'agent') {
      const n = Object.keys(w.agents).length + 1
      const id = uid('ag') as AgentId
      const agent: Agent = {
        id, name: `Agent ${n}`, role: 'generalist', model: 'claude-sonnet-5', temperature: 0.3, concurrency: 1,
        timeoutMs: 120_000, retry: { maxAttempts: 2, backoffMs: 1000, backoff: 'fixed' }, tools: ['read_file', 'bash'],
        systemPrompt: 'You are a helpful engineering agent.', status: 'idle', position, completed: 0, failed: 0,
      }
      w.agents = { ...w.agents, [id]: agent }
      this.event('graph', { kind: 'agent', id }, `Agent ${agent.name} created`)
      this.publish()
      return id
    }
    if (kind === 'sandbox') {
      const n = Object.keys(w.sandboxes).length + 1
      const id = uid('sb') as SandboxId
      const sb: Sandbox = {
        id, name: `sandbox-${n}`, kind: 'docker', host: 'docker.internal', image: 'ghcr.io/factory/dev:node22',
        state: 'provisioning', stateSince: w.now, progress: 0, metrics: { cpu: 0, mem: 0, disk: 4 }, history: [],
        lease: null, restartPending: false, position,
      }
      w.sandboxes = { ...w.sandboxes, [id]: sb }
      this.event('sandbox', { kind: 'sandbox', id }, `Provisioning ${sb.name}`)
      this.log('info', `provisioning ${sb.name} on ${sb.host}`)
      this.publish()
      return id
    }
    const n = Object.keys(w.triggers).length + 1
    const id = uid('tr') as TriggerId
    const tr: Trigger = {
      id, name: `Trigger ${n}`, kind: 'manual', intervalMs: 30_000, enabled: true, lastFiredAt: w.now, fired: 0,
      template: 'Do the thing', position,
    }
    w.triggers = { ...w.triggers, [id]: tr }
    this.event('graph', { kind: 'trigger', id }, `Trigger ${tr.name} created`)
    this.publish()
    return id
  }

  deleteNodes(ids: NodeId[]) {
    const w = this.world
    const gone = new Set<string>(ids)
    for (const r of Object.values(w.runs)) {
      if (r.status !== 'running') continue
      if (gone.has(r.agentId)) this.finishRun(r, { status: 'failed', reason: 'agent deleted', retryable: false })
      else if (gone.has(r.sandboxId)) this.finishRun(r, { status: 'failed', reason: 'sandbox deleted' })
    }
    for (const t of Object.values(w.tasks)) if (gone.has(t.agentId) && (t.status === 'queued' || t.status === 'waiting')) this.patchTask(t.id, { status: 'cancelled', blockedOn: null })
    w.agents = Object.fromEntries(Object.entries(w.agents).filter(([id]) => !gone.has(id))) as World['agents']
    w.triggers = Object.fromEntries(Object.entries(w.triggers).filter(([id]) => !gone.has(id))) as World['triggers']
    for (const id of ids) if (w.sandboxes[id as SandboxId]) this.removeSandbox(id as SandboxId)
    w.edges = Object.fromEntries(Object.entries(w.edges).filter(([, e]) => !gone.has(e.source) && !gone.has(e.target))) as World['edges']
    this.event('graph', { kind: 'agent', id: ids[0] as AgentId }, `Deleted ${ids.length} node${ids.length === 1 ? '' : 's'}`)
    this.publish()
  }

  connect(source: NodeId, target: NodeId, preferred: EdgeKind | null): { ok: true; id: EdgeId } | { ok: false; reason: string } {
    const w = this.world
    const from = nodeKindOf(w, source)
    const to = nodeKindOf(w, target)
    if (!from || !to) return { ok: false, reason: 'unknown node' }
    const kinds = edgeKindFor(from, to)
    if (kinds.length === 0) return { ok: false, reason: `${from} → ${to} is not a valid connection` }
    const kind = preferred && kinds.includes(preferred) ? preferred : kinds[0]
    if (Object.values(w.edges).some((e) => e.source === source && e.target === target && e.kind === kind)) {
      return { ok: false, reason: 'edge already exists' }
    }
    const id = uid('ed') as EdgeId
    w.edges = { ...w.edges, [id]: { id, kind, source, target } }
    this.event('graph', { kind: 'edge', id }, `Connected ${this.nameOf(source)} → ${this.nameOf(target)} (${EDGE_RULES[kind].label})`)
    this.publish()
    return { ok: true, id }
  }

  setEdgeKind(id: EdgeId, kind: EdgeKind) {
    const e = this.world.edges[id]
    if (!e) return
    const from = nodeKindOf(this.world, e.source)
    const to = nodeKindOf(this.world, e.target)
    if (!from || !to || !edgeKindFor(from, to).includes(kind)) return
    if (Object.values(this.world.edges).some((o) => o.id !== id && o.source === e.source && o.target === e.target && o.kind === kind)) return
    this.world.edges = { ...this.world.edges, [id]: { ...e, kind } }
    this.publish()
  }

  removeEdges(ids: EdgeId[]) {
    const gone = new Set(ids)
    this.world.edges = Object.fromEntries(Object.entries(this.world.edges).filter(([id]) => !gone.has(id as EdgeId))) as World['edges']
    this.publish()
  }

  updateAgent(id: AgentId, patch: Partial<Omit<Agent, 'id' | 'status' | 'position'>>) {
    this.patchAgent(id, patch)
    this.publish()
  }

  setAgentPaused(id: AgentId, paused: boolean) {
    const ag = this.world.agents[id]
    if (!ag) return
    this.patchAgent(id, { status: paused ? 'paused' : this.runningCount(id) > 0 ? 'working' : 'idle' })
    this.event('agent', { kind: 'agent', id }, `${ag.name} ${paused ? 'paused' : 'resumed'}`)
    this.publish()
  }

  enqueueTask(agentId: AgentId, input: { title: string; prompt: string; priority: Priority }, origin: Task['origin'] = { kind: 'manual' }): TaskId {
    const id = uid('tk') as TaskId
    const task: Task = { id, agentId, title: input.title, prompt: input.prompt, priority: input.priority, status: 'queued', origin, createdAt: this.world.now, attempts: 0, retryAt: null, blockedOn: null }
    this.world.tasks = { ...this.world.tasks, [id]: task }
    this.event('task', { kind: 'agent', id: agentId }, `Queued “${task.title}” for ${this.nameOf(agentId)}`)
    this.publish()
    return id
  }

  cancelTask(id: TaskId) {
    const t = this.world.tasks[id]
    if (!t || (t.status !== 'queued' && t.status !== 'waiting')) return
    this.patchTask(id, { status: 'cancelled', blockedOn: null })
    this.event('task', { kind: 'agent', id: t.agentId }, `Cancelled “${t.title}”`)
    this.publish()
  }

  sandboxAction(id: SandboxId, action: SandboxAction) {
    const sb = this.world.sandboxes[id]
    if (!sb) return
    const next = SANDBOX_TRANSITIONS[sb.state][action]
    if (!next) return
    if (sb.lease) {
      const run = this.world.runs[sb.lease.runId]
      if (run && run.status === 'running') this.finishRun(run, { status: 'failed', reason: `sandbox ${action}` })
    }
    this.patchSandbox(id, { state: next, stateSince: this.world.now, progress: 0, lease: null, restartPending: action === 'restart' })
    this.event('sandbox', { kind: 'sandbox', id }, `${sb.name}: ${action} → ${next}`)
    this.log('info', `${sb.name} ${action} requested (${sb.state} → ${next})`)
    this.publish()
  }

  createSandbox(input: { name: string; kind: SandboxKind; host: string; image: string }, position?: Position): SandboxId {
    const id = uid('sb') as SandboxId
    const sb: Sandbox = {
      id, ...input, state: 'provisioning', stateSince: this.world.now, progress: 0, metrics: { cpu: 0, mem: 0, disk: 4 },
      history: [], lease: null, restartPending: false, position: position ?? this.nextFreePosition(),
    }
    this.world.sandboxes = { ...this.world.sandboxes, [id]: sb }
    this.event('sandbox', { kind: 'sandbox', id }, `Provisioning ${sb.name}`)
    this.log('info', `provisioning ${sb.name} (${sb.kind}) on ${sb.host}`)
    this.publish()
    return id
  }

  updateTrigger(id: TriggerId, patch: Partial<Omit<Trigger, 'id' | 'position'>>) {
    this.patchTrigger(id, patch)
    this.publish()
  }

  fireTrigger(id: TriggerId) {
    this.fire(id)
    this.publish()
  }

  setSim(patch: Partial<World['sim']>) {
    this.world.sim = { ...this.world.sim, ...patch }
    this.publish()
  }

  reset() {
    localStorage.removeItem(STORAGE_KEY)
    this.world = seedWorld(Date.now())
    this.publish()
  }

  // ---- simulation ---------------------------------------------------------

  private tick() {
    const w = this.world
    if (w.sim.paused) return
    const dt = TICK_MS * w.sim.speed
    w.now += dt
    this.tickSandboxes()
    this.tickTriggers()
    this.tickRuns(dt)
    this.schedule()
    this.publish()
  }

  private tickSandboxes() {
    for (const sb of Object.values(this.world.sandboxes)) {
      const timed = SANDBOX_TIMED[sb.state]
      let patch: Partial<Sandbox> = {}
      if (timed) {
        const progress = clamp((this.world.now - sb.stateSince) / timed.durationMs, 0, 1)
        patch.progress = progress
        if (progress >= 1) {
          if (sb.state === 'destroying') {
            this.removeSandbox(sb.id)
            this.event('sandbox', { kind: 'sandbox', id: sb.id }, `${sb.name} destroyed`)
            continue
          }
          let next = timed.next
          if (sb.state === 'stopping' && sb.restartPending) {
            next = 'provisioning'
            patch.restartPending = false
          }
          patch = { ...patch, state: next, stateSince: this.world.now, progress: next === 'running' ? 1 : 0 }
          this.event('sandbox', { kind: 'sandbox', id: sb.id }, `${sb.name} is ${next}`)
          this.log(next === 'running' ? 'info' : 'debug', `${sb.name} → ${next}`)
        }
      }
      const busy = sb.lease !== null
      const off = sb.state === 'stopped' || sb.state === 'destroying'
      const target = off ? { cpu: 0, mem: 0, disk: sb.metrics.disk } : busy
        ? { cpu: rand(55, 95), mem: rand(45, 80), disk: sb.metrics.disk + rand(0, 0.15) }
        : sb.state === 'running' ? { cpu: rand(2, 12), mem: rand(18, 30), disk: sb.metrics.disk }
        : { cpu: rand(20, 60), mem: rand(20, 50), disk: sb.metrics.disk + rand(0, 0.4) }
      const k = 0.35
      const metrics = {
        cpu: clamp(sb.metrics.cpu + (target.cpu - sb.metrics.cpu) * k, 0, 100),
        mem: clamp(sb.metrics.mem + (target.mem - sb.metrics.mem) * k, 0, 100),
        disk: clamp(target.disk, 0, 100),
      }
      const history = sb.history.length >= 40 ? sb.history.slice(-39) : sb.history.slice()
      history.push(metrics)
      this.patchSandbox(sb.id, { ...patch, metrics, history })
    }
  }

  private removeSandbox(id: SandboxId) {
    const w = this.world
    w.sandboxes = Object.fromEntries(Object.entries(w.sandboxes).filter(([k]) => k !== id)) as World['sandboxes']
    w.edges = Object.fromEntries(Object.entries(w.edges).filter(([, e]) => e.source !== id && e.target !== id)) as World['edges']
  }

  private tickTriggers() {
    for (const tr of Object.values(this.world.triggers)) {
      if (!tr.enabled || tr.kind === 'manual') continue
      if (tr.lastFiredAt === null) {
        this.patchTrigger(tr.id, { lastFiredAt: this.world.now - tr.intervalMs * 0.6 })
        continue
      }
      if (this.world.now - tr.lastFiredAt >= tr.intervalMs) this.fire(tr.id)
    }
  }

  private fire(id: TriggerId) {
    const tr = this.world.triggers[id]
    if (!tr) return
    this.patchTrigger(id, { lastFiredAt: this.world.now, fired: tr.fired + 1 })
    const targets = Object.values(this.world.edges).filter((e) => e.kind === 'triggers' && e.source === id)
    this.event('trigger', { kind: 'trigger', id }, `${tr.name} fired (${tr.kind})`)
    for (const e of targets) {
      this.enqueueTaskSilently(e.target as AgentId, { title: tr.template, prompt: `${tr.template}\n\nTriggered by ${tr.name}.`, priority: tr.kind === 'webhook' ? 'high' : 'normal' }, { kind: 'trigger', id })
    }
  }

  private enqueueTaskSilently(agentId: AgentId, input: { title: string; prompt: string; priority: Priority }, origin: Task['origin']) {
    if (!this.world.agents[agentId]) return
    const id = uid('tk') as TaskId
    const task: Task = { id, agentId, ...input, status: 'queued', origin, createdAt: this.world.now, attempts: 0, retryAt: null, blockedOn: null }
    this.world.tasks = { ...this.world.tasks, [id]: task }
    this.event('task', { kind: 'agent', id: agentId }, `Queued “${task.title}” for ${this.nameOf(agentId)}`)
  }

  private tickRuns(dt: number) {
    for (const run of Object.values(this.world.runs)) {
      if (run.status !== 'running') continue
      const agent = this.world.agents[run.agentId]
      if (!agent) continue
      const progress = clamp(run.progress + dt / run.durationMs, 0, 1)
      this.patchRun(run.id, { progress, tokens: run.tokens + Math.round(rand(80, 600) * (dt / 1000)) })
      if (Math.random() < 0.28) {
        const [level, msg] = pick(RUN_LOG_LINES)
        if (level !== 'error') this.log(level, msg, { runId: run.id, agentId: run.agentId })
      }
      if (this.world.now - run.startedAt > agent.timeoutMs) {
        this.log('error', `run exceeded timeout of ${Math.round(agent.timeoutMs / 1000)}s`, { runId: run.id, agentId: run.agentId })
        this.finishRun(run, { status: 'failed', reason: 'timeout' })
        continue
      }
      if (progress >= 1) {
        const ok = Math.random() < 0.85
        if (!ok) this.log('error', pick(RUN_LOG_LINES.filter(([l]) => l === 'error'))[1], { runId: run.id, agentId: run.agentId })
        this.finishRun(run, ok ? { status: 'succeeded', agent } : { status: 'failed', reason: 'task error' })
      }
    }
  }

  private finishRun(run: Run, completion: RunCompletion) {
    const w = this.world
    const agent = w.agents[run.agentId]
    const task = w.tasks[run.taskId]
    this.patchRun(run.id, {
      status: completion.status,
      endedAt: w.now,
      progress: completion.status === 'succeeded' ? 1 : run.progress,
      output: completion.status === 'succeeded' ? createRunOutput(run, completion.agent) : null,
      error: completion.status === 'failed' ? completion.reason : null,
    })
    const sb = w.sandboxes[run.sandboxId]
    if (sb && sb.lease?.runId === run.id) this.patchSandbox(sb.id, { lease: null })
    if (completion.status === 'succeeded') {
      if (agent) this.patchAgent(agent.id, { completed: agent.completed + 1 })
      if (task) this.patchTask(task.id, { status: 'succeeded' })
      this.log('info', `run finished: ${run.title}`, { runId: run.id, agentId: run.agentId })
      this.event('run', { kind: 'run', id: run.id }, `${this.nameOf(run.agentId)} finished “${run.title}”`)
      for (const e of Object.values(w.edges)) {
        if (e.kind === 'handoff' && e.source === run.agentId) {
          this.enqueueTaskSilently(e.target as AgentId, { title: `${run.title} → ${this.nameOf(e.target)}`, prompt: `Continue from ${this.nameOf(run.agentId)}: ${run.title}`, priority: task?.priority ?? 'normal' }, { kind: 'handoff', from: run.agentId })
        }
      }
    } else if (task && agent) {
      const canRetry = (completion.retryable ?? true) && task.attempts < agent.retry.maxAttempts
      if (canRetry) {
        const delay = agent.retry.backoff === 'exponential' ? agent.retry.backoffMs * 2 ** (task.attempts - 1) : agent.retry.backoffMs
        this.patchTask(task.id, { status: 'waiting', retryAt: w.now + delay, blockedOn: `retry ${task.attempts + 1}/${agent.retry.maxAttempts} in ${Math.round(delay / 1000)}s` })
        this.log('warn', `run failed (${completion.reason}); retrying attempt ${task.attempts + 1}/${agent.retry.maxAttempts} in ${Math.round(delay / 1000)}s`, { runId: run.id, agentId: run.agentId })
        this.event('run', { kind: 'run', id: run.id }, `${agent.name} failed “${run.title}” (${completion.reason}), retrying`)
      } else {
        this.patchTask(task.id, { status: 'failed', blockedOn: null })
        this.patchAgent(agent.id, { failed: agent.failed + 1, status: agent.status === 'paused' ? 'paused' : 'error' })
        this.log('error', `run failed permanently (${completion.reason}): ${run.title}`, { runId: run.id, agentId: run.agentId })
        this.event('run', { kind: 'run', id: run.id }, `${agent.name} gave up on “${run.title}” (${completion.reason})`)
      }
    }
    this.refreshAgentStatus(run.agentId)
  }

  private runningCount(agentId: AgentId) {
    return Object.values(this.world.runs).filter((r) => r.agentId === agentId && r.status === 'running').length
  }

  private refreshAgentStatus(agentId: AgentId) {
    const ag = this.world.agents[agentId]
    if (!ag || ag.status === 'paused') return
    const running = this.runningCount(agentId)
    if (running > 0 && ag.status !== 'working') this.patchAgent(agentId, { status: 'working' })
    if (running === 0 && ag.status === 'working') this.patchAgent(agentId, { status: 'idle' })
  }

  private schedule() {
    const w = this.world
    const edges = Object.values(w.edges)
    for (const agent of Object.values(w.agents)) {
      if (agent.status === 'paused') continue
      let free = agent.concurrency - this.runningCount(agent.id)
      const pending = Object.values(w.tasks)
        .filter((t) => t.agentId === agent.id && (t.status === 'queued' || t.status === 'waiting'))
        .sort((x, y) => PRIORITY_RANK[x.priority] - PRIORITY_RANK[y.priority] || x.createdAt - y.createdAt)
      for (const task of pending) {
        if (free <= 0) break
        if (task.retryAt !== null && task.retryAt > w.now) continue
        const upstream = edges.filter((e) => e.kind === 'depends-on' && e.target === agent.id).map((e) => w.agents[e.source as AgentId]).filter((u): u is Agent => !!u && u.status === 'working')
        if (upstream.length > 0) {
          this.patchTask(task.id, { status: 'waiting', blockedOn: `waiting on ${upstream.map((u) => u.name).join(', ')}` })
          continue
        }
        const sandbox = edges.filter((e) => e.kind === 'runs-in' && e.source === agent.id).map((e) => w.sandboxes[e.target as SandboxId]).find((sb) => sb && sb.state === 'running' && sb.lease === null)
        if (!sandbox) {
          const any = edges.some((e) => e.kind === 'runs-in' && e.source === agent.id)
          this.patchTask(task.id, { status: 'waiting', blockedOn: any ? 'no free sandbox' : 'no sandbox attached' })
          continue
        }
        this.startRun(agent, task, sandbox)
        free -= 1
      }
    }
  }

  private startRun(agent: Agent, task: Task, sandbox: Sandbox) {
    const id = uid('run') as RunId
    const run: Run = {
      id, taskId: task.id, agentId: agent.id, sandboxId: sandbox.id, title: task.title, attempt: task.attempts + 1,
      status: 'running', progress: 0, durationMs: rand(7000, 18000), startedAt: this.world.now, endedAt: null, tokens: 0,
      output: null, error: null,
    }
    this.world.runs = { ...this.world.runs, [id]: run }
    this.patchTask(task.id, { status: 'running', attempts: task.attempts + 1, retryAt: null, blockedOn: null })
    this.patchSandbox(sandbox.id, { lease: { agentId: agent.id, runId: id, since: this.world.now } })
    this.patchAgent(agent.id, { status: 'working' })
    this.log('info', `run started on ${sandbox.name} (attempt ${run.attempt}): ${task.title}`, { runId: id, agentId: agent.id })
    this.event('run', { kind: 'run', id }, `${agent.name} started “${task.title}” on ${sandbox.name}`)
  }

  private nameOf(id: string): string {
    const w = this.world
    return w.agents[id as AgentId]?.name ?? w.sandboxes[id as SandboxId]?.name ?? w.triggers[id as TriggerId]?.name ?? id
  }

  private nextFreePosition(): Position {
    const n = Object.keys(this.world.sandboxes).length
    return { x: 320 + (n % 4) * 320, y: 680 }
  }
}

type Persisted = Pick<World, 'agents' | 'sandboxes' | 'triggers' | 'edges' | 'sim'>

function save(w: World) {
  const data: Persisted = { agents: w.agents, sandboxes: w.sandboxes, triggers: w.triggers, edges: w.edges, sim: w.sim }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* storage unavailable: run in memory only */
  }
}

function load(): World | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Persisted
    if (!p.agents || !p.sandboxes || !p.triggers || !p.edges) return null
    const now = Date.now()
    const agents = Object.fromEntries(Object.entries(p.agents).map(([id, a]) => [id, { ...a, status: a.status === 'paused' ? 'paused' : 'idle' }])) as World['agents']
    const sandboxes = Object.fromEntries(Object.entries(p.sandboxes).map(([id, s]) => [id, { ...s, lease: null, history: [], stateSince: now }])) as World['sandboxes']
    const triggers = Object.fromEntries(Object.entries(p.triggers).map(([id, t]) => [id, { ...t, lastFiredAt: null }])) as World['triggers']
    return { ...seedWorld(now), agents, sandboxes, triggers, edges: p.edges, sim: p.sim ?? { paused: false, speed: 1 } }
  } catch {
    return null
  }
}

export const mockServer = new MockServer()
