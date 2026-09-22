import { seedWorld } from '../src/domain/seed'
import {
  EDGE_RULES,
  SANDBOX_TIMED,
  SANDBOX_TRANSITIONS,
  attachedEdges,
  edgeKindFor,
  nodeKindOf,
  nodeRef,
  nodeSubject,
  type Agent,
  type AgentId,
  type Edge,
  type EdgeId,
  type EdgeKind,
  type FactoryEvent,
  type FlowId,
  type GraphFragment,
  type Group,
  type GroupId,
  type LogLevel,
  type NodeId,
  type NodeKind,
  type NodeRef,
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
} from '../src/domain/types'

const TICK_MS = 400
const MAX_LOGS = 2000
const MAX_EVENTS = 400
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 }
const ID_PREFIX: Record<NodeKind, string> = { agent: 'ag', sandbox: 'sb', trigger: 'tr' }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const isCapacity = (v: number) => Number.isInteger(v) && v >= 1

/** What may join two nodes, or null when either endpoint is gone. */
function connectable(world: World, source: NodeId, target: NodeId): { from: NodeKind; to: NodeKind; kinds: EdgeKind[] } | null {
  const from = nodeKindOf(world, source)
  const to = nodeKindOf(world, target)
  return from && to ? { from, to, kinds: edgeKindFor(from, to) } : null
}

/** Whether an edge with these endpoints and kind already exists, ignoring `exceptId`. */
function edgeExists(world: World, source: NodeId, target: NodeId, kind: EdgeKind, exceptId?: EdgeId): boolean {
  return Object.values(world.edges).some((e) => e.id !== exceptId && e.source === source && e.target === target && e.kind === kind)
}

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
  private rng: () => number
  private seq = 0
  private rev = 0

  /**
   * `manual` stops the automatic interval; tests then advance simulated time with
   * `advance(ms)`. `rng` makes run outcomes, durations, and metric noise repeatable.
   * A new server always starts from the seed. Nothing is read from disk.
   */
  constructor(options: { manual?: boolean; rng?: () => number } = {}) {
    this.rng = options.rng ?? Math.random
    this.world = seedWorld(Date.now())
    this.rev = 1
    if (!options.manual) this.start()
  }

  /** Monotonic count of publishes. The initial seed is revision 1. */
  revision() {
    return this.rev
  }

  /** Advance simulated time by `ms` and run one full tick. For manual mode. */
  advance(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('ms must be a finite, non-negative number')
    if (this.world.sim.paused) return
    this.tick(ms)
  }

  private rand(lo: number, hi: number) {
    return lo + this.rng() * (hi - lo)
  }

  private pick<T>(xs: T[]) {
    return xs[Math.floor(this.rng() * xs.length)]
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
    this.timer = setInterval(() => this.tick(TICK_MS * this.world.sim.speed), TICK_MS)
    // unref where available so a test process is not kept alive by the singleton
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  private publish() {
    this.rev += 1
    this.world = { ...this.world }
    for (const fn of this.listeners) fn(this.world)
  }

  // ---- writes -------------------------------------------------------------

  private uid(prefix: string) {
    return `${prefix}-${Date.now().toString(36)}${(this.seq++).toString(36)}`
  }

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
    const line = { id: ++this.seq, ts: this.world.now, level, runId: ref.runId ?? null, agentId: ref.agentId ?? null, msg }
    const logs = this.world.logs.length >= MAX_LOGS ? this.world.logs.slice(-MAX_LOGS + 1) : this.world.logs.slice()
    logs.push(line)
    this.world.logs = logs
  }

  private event(kind: FactoryEvent['kind'], subject: Subject, msg: string) {
    const ev = { id: ++this.seq, ts: this.world.now, kind, subject, msg }
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
      const id = this.uid('ag') as AgentId
      const agent: Agent = {
        id, name: `Agent ${n}`, role: 'generalist', model: 'claude-sonnet-5', temperature: 0.3, concurrency: 1,
        timeoutMs: 120_000, retry: { maxAttempts: 2, backoffMs: 1000, backoff: 'fixed' }, tools: ['read_file', 'bash'],
        systemPrompt: 'You are a helpful engineering agent.', status: 'idle', position, completed: 0, failed: 0,
        groupId: null,
      }
      w.agents = { ...w.agents, [id]: agent }
      this.event('graph', { kind: 'agent', id }, `Agent ${agent.name} created`)
      this.publish()
      return id
    }
    if (kind === 'sandbox') {
      const n = Object.keys(w.sandboxes).length + 1
      const id = this.uid('sb') as SandboxId
      const sb: Sandbox = {
        id, name: `sandbox-${n}`, kind: 'docker', host: 'docker.internal', image: 'ghcr.io/factory/dev:node22',
        state: 'provisioning', stateSince: w.now, progress: 0, metrics: { cpu: 0, mem: 0, disk: 4 }, history: [],
        leases: [], capacity: 1, restartPending: false, position, groupId: null,
      }
      w.sandboxes = { ...w.sandboxes, [id]: sb }
      this.event('sandbox', { kind: 'sandbox', id }, `Provisioning ${sb.name}`)
      this.log('info', `provisioning ${sb.name} on ${sb.host}`)
      this.publish()
      return id
    }
    const n = Object.keys(w.triggers).length + 1
    const id = this.uid('tr') as TriggerId
    const tr: Trigger = {
      id, name: `Trigger ${n}`, kind: 'manual', intervalMs: 30_000, enabled: true, lastFiredAt: w.now, fired: 0,
      template: 'Do the thing', position, groupId: null,
    }
    w.triggers = { ...w.triggers, [id]: tr }
    this.event('graph', { kind: 'trigger', id }, `Trigger ${tr.name} created`)
    this.publish()
    return id
  }

  deleteNodes(ids: NodeId[]) {
    const w = this.world
    if (ids.length === 0) return
    const firstId = ids[0]
    const subject = nodeSubject(nodeKindOf(w, firstId) ?? 'agent', firstId)
    const gone = new Set<string>(ids)
    for (const r of Object.values(w.runs)) {
      if (r.status !== 'running') continue
      if (gone.has(r.agentId)) this.finishRun(r, { status: 'failed', reason: 'agent deleted', retryable: false })
      else if (gone.has(r.sandboxId)) this.finishRun(r, { status: 'failed', reason: 'sandbox deleted' })
    }
    for (const t of Object.values(w.tasks)) if (gone.has(t.agentId) && (t.status === 'queued' || t.status === 'waiting')) this.patchTask(t.id, { status: 'cancelled', blockedOn: null })
    const attached = new Set<string>(attachedEdges(w, ids).map((e) => e.id))
    w.agents = Object.fromEntries(Object.entries(w.agents).filter(([id]) => !gone.has(id))) as World['agents']
    w.triggers = Object.fromEntries(Object.entries(w.triggers).filter(([id]) => !gone.has(id))) as World['triggers']
    for (const id of ids) if (w.sandboxes[id as SandboxId]) this.removeSandbox(id as SandboxId)
    w.edges = Object.fromEntries(Object.entries(w.edges).filter(([id]) => !attached.has(id))) as World['edges']
    this.event('graph', subject, `Deleted ${ids.length} node${ids.length === 1 ? '' : 's'}`)
    this.publish()
  }

  /** Write a node record into its bucket. The caller owns normalization; paste and restore differ only there. */
  private putNode(ref: NodeRef): Subject {
    const w = this.world
    if (ref.kind === 'agent') w.agents = { ...w.agents, [ref.node.id]: ref.node }
    else if (ref.kind === 'sandbox') w.sandboxes = { ...w.sandboxes, [ref.node.id]: ref.node }
    else w.triggers = { ...w.triggers, [ref.node.id]: ref.node }
    return nodeSubject(ref.kind, ref.node.id)
  }

  /** Write an edge under the same validity and duplicate rules as `connect`. False when the graph rejected it. */
  private putEdge(edge: Edge): boolean {
    const w = this.world
    if (w.edges[edge.id]) return false
    if (!connectable(w, edge.source, edge.target)?.kinds.includes(edge.kind)) return false
    if (edgeExists(w, edge.source, edge.target, edge.kind)) return false
    w.edges = { ...w.edges, [edge.id]: edge }
    return true
  }

  /** Put node records back under their original ids with the reload normalization; ids already present are skipped. */
  restoreNodes(nodes: NodeRef[]) {
    const w = this.world
    const restored = nodes
      .filter((ref) => !nodeKindOf(w, ref.node.id))
      .map((ref) => this.putNode(restoredNode(ref, w.now)))
    if (restored.length === 0) return
    this.event('graph', restored[0], restored.length === 1 ? `Restored ${this.nameOf(restored[0].id)}` : `Restored ${restored.length} nodes`)
    this.publish()
  }

  /** Put edges back under their original ids, in order, under the same validity and duplicate rules as `connect`. */
  restoreEdges(edges: Edge[]) {
    const restored = edges.filter((edge) => this.putEdge(edge))
    if (restored.length > 0) this.publish()
  }

  /** Copy a fragment into the graph under new ids, each node moved by `offset`. Only edges with both endpoints in the fragment are recreated. */
  paste(fragment: GraphFragment, offset: Position): GraphFragment {
    const w = this.world
    const newIds = new Map<string, NodeId>()
    const nodes: NodeRef[] = []
    for (const ref of fragment.nodes) {
      const copy = pastedNode(ref, this.uid(ID_PREFIX[ref.kind]), offset, w.now)
      newIds.set(ref.node.id, copy.node.id)
      nodes.push(copy)
      this.putNode(copy)
      if (copy.kind === 'sandbox') this.log('info', `provisioning ${copy.node.name} (${copy.node.kind}) on ${copy.node.host}`)
    }
    if (nodes.length === 0) return { nodes: [], edges: [] }
    const edges = fragment.edges.flatMap(({ kind, source: from, target: to }) => {
      const source = newIds.get(from)
      const target = newIds.get(to)
      if (!source || !target) return []
      const edge: Edge = { id: this.uid('ed') as EdgeId, kind, source, target }
      return this.putEdge(edge) ? [edge] : []
    })
    this.event('graph', nodeSubject(nodes[0].kind, nodes[0].node.id), `Pasted ${nodes.length} node${nodes.length === 1 ? '' : 's'}`)
    this.publish()
    return { nodes, edges }
  }

  connect(source: NodeId, target: NodeId, preferred: EdgeKind | null): { ok: true; id: EdgeId } | { ok: false; reason: string } {
    const w = this.world
    const join = connectable(w, source, target)
    if (!join) return { ok: false, reason: 'unknown node' }
    if (join.kinds.length === 0) return { ok: false, reason: `${join.from} → ${join.to} is not a valid connection` }
    const kind = preferred && join.kinds.includes(preferred) ? preferred : join.kinds[0]
    if (edgeExists(w, source, target, kind)) return { ok: false, reason: 'edge already exists' }
    const id = this.uid('ed') as EdgeId
    w.edges = { ...w.edges, [id]: { id, kind, source, target } }
    this.event('graph', { kind: 'edge', id }, `Connected ${this.nameOf(source)} → ${this.nameOf(target)} (${EDGE_RULES[kind].label})`)
    this.publish()
    return { ok: true, id }
  }

  setEdgeKind(id: EdgeId, kind: EdgeKind) {
    const e = this.world.edges[id]
    if (!e) return
    const join = connectable(this.world, e.source, e.target)
    if (!join || !join.kinds.includes(kind)) return
    if (edgeExists(this.world, e.source, e.target, kind, id)) return
    this.world.edges = { ...this.world.edges, [id]: { ...e, kind } }
    this.publish()
  }

  removeEdges(ids: EdgeId[]) {
    const gone = new Set(ids)
    this.world.edges = Object.fromEntries(Object.entries(this.world.edges).filter(([id]) => !gone.has(id as EdgeId))) as World['edges']
    this.publish()
  }

  private setGroupId(id: NodeId, groupId: GroupId | null) {
    const kind = nodeKindOf(this.world, id)
    if (kind === 'agent') this.patchAgent(id as AgentId, { groupId })
    else if (kind === 'sandbox') this.patchSandbox(id as SandboxId, { groupId })
    else if (kind === 'trigger') this.patchTrigger(id as TriggerId, { groupId })
  }

  private memberIds(groupId: GroupId): NodeId[] {
    const ids: NodeId[] = []
    for (const a of Object.values(this.world.agents)) if (a.groupId === groupId) ids.push(a.id)
    for (const s of Object.values(this.world.sandboxes)) if (s.groupId === groupId) ids.push(s.id)
    for (const t of Object.values(this.world.triggers)) if (t.groupId === groupId) ids.push(t.id)
    return ids
  }

  group(ids: NodeId[]): GroupId | null {
    const refs = [...new Set(ids)].map((id) => nodeRef(this.world, id)).filter((ref) => ref !== null)
    if (refs.length < 2 || refs.some((ref) => ref.node.groupId !== null)) return null
    const id = this.uid('gr') as GroupId
    const group: Group = { id, name: this.nextGroupName() }
    this.world.groups = { ...this.world.groups, [id]: group }
    for (const ref of refs) this.setGroupId(ref.node.id, id)
    this.event('graph', { kind: 'group', id }, `Grouped ${refs.length} nodes`)
    this.publish()
    return id
  }

  ungroup(id: GroupId) {
    const group = this.world.groups[id]
    if (!group) return
    for (const memberId of this.memberIds(id)) this.setGroupId(memberId, null)
    this.world.groups = Object.fromEntries(Object.entries(this.world.groups).filter(([gid]) => gid !== id)) as World['groups']
    this.event('graph', { kind: 'group', id }, `Ungrouped ${group.name}`)
    this.publish()
  }

  restoreGroup(group: Group, memberIds: NodeId[]) {
    if (this.world.groups[group.id]) return
    this.world.groups = { ...this.world.groups, [group.id]: group }
    for (const id of memberIds) {
      const ref = nodeRef(this.world, id)
      if (!ref || ref.node.groupId !== null) continue
      this.setGroupId(id, group.id)
    }
    this.publish()
  }

  updateGroup(id: GroupId, patch: { name: string }) {
    const cur = this.world.groups[id]
    if (!cur) return
    this.world.groups = { ...this.world.groups, [id]: { ...cur, ...patch } }
    this.publish()
  }

  updateAgent(id: AgentId, patch: Partial<Omit<Agent, 'id' | 'status' | 'position' | 'groupId'>>) {
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
    const flowId = this.uid('fl') as FlowId
    const id = this.uid('tk') as TaskId
    const task: Task = { id, flowId, agentId, title: input.title, prompt: input.prompt, priority: input.priority, status: 'queued', origin, input: null, createdAt: this.world.now, attempts: 0, retryAt: null, blockedOn: null }
    this.world.tasks = { ...this.world.tasks, [id]: task }
    this.event('task', { kind: 'task', id }, `Queued “${task.title}” for ${this.nameOf(agentId)}`)
    this.publish()
    return id
  }

  cancelTask(id: TaskId) {
    const t = this.world.tasks[id]
    if (!t || (t.status !== 'queued' && t.status !== 'waiting')) return
    this.patchTask(id, { status: 'cancelled', blockedOn: null })
    this.event('task', { kind: 'task', id }, `Cancelled “${t.title}”`)
    this.publish()
  }

  sandboxAction(id: SandboxId, action: SandboxAction) {
    const sb = this.world.sandboxes[id]
    if (!sb) return
    const next = SANDBOX_TRANSITIONS[sb.state][action]
    if (!next) return
    for (const lease of [...sb.leases]) {
      const run = this.world.runs[lease.runId]
      if (run && run.status === 'running') this.finishRun(run, { status: 'failed', reason: `sandbox ${action}` })
    }
    this.patchSandbox(id, { state: next, stateSince: this.world.now, progress: 0, leases: [], restartPending: action === 'restart' })
    this.event('sandbox', { kind: 'sandbox', id }, `${sb.name}: ${action} → ${next}`)
    this.log('info', `${sb.name} ${action} requested (${sb.state} → ${next})`)
    this.publish()
  }

  createSandbox(input: { name: string; kind: SandboxKind; host: string; image: string; capacity?: number }, position?: Position): SandboxId {
    const id = this.uid('sb') as SandboxId
    const capacity = input.capacity !== undefined && isCapacity(input.capacity) ? input.capacity : 1
    const sb: Sandbox = {
      id, ...input, capacity, state: 'provisioning', stateSince: this.world.now, progress: 0,
      metrics: { cpu: 0, mem: 0, disk: 4 }, history: [], leases: [], restartPending: false,
      position: position ?? this.nextFreePosition(), groupId: null,
    }
    this.world.sandboxes = { ...this.world.sandboxes, [id]: sb }
    this.event('sandbox', { kind: 'sandbox', id }, `Provisioning ${sb.name}`)
    this.log('info', `provisioning ${sb.name} (${sb.kind}) on ${sb.host}`)
    this.publish()
    return id
  }

  updateSandbox(id: SandboxId, patch: { capacity: number }) {
    if (!isCapacity(patch.capacity)) return
    if (!this.world.sandboxes[id]) return
    this.patchSandbox(id, { capacity: patch.capacity })
    this.publish()
  }

  updateTrigger(id: TriggerId, patch: Partial<Omit<Trigger, 'id' | 'position' | 'groupId'>>) {
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
    this.world = seedWorld(Date.now())
    this.publish()
  }

  // ---- simulation ---------------------------------------------------------

  private tick(dt: number) {
    const w = this.world
    if (w.sim.paused) return
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
      const busy = sb.leases.length > 0
      const off = sb.state === 'stopped' || sb.state === 'destroying'
      const target = off ? { cpu: 0, mem: 0, disk: sb.metrics.disk } : busy
        ? { cpu: this.rand(55, 95), mem: this.rand(45, 80), disk: sb.metrics.disk + this.rand(0, 0.15) }
        : sb.state === 'running' ? { cpu: this.rand(2, 12), mem: this.rand(18, 30), disk: sb.metrics.disk }
        : { cpu: this.rand(20, 60), mem: this.rand(20, 50), disk: sb.metrics.disk + this.rand(0, 0.4) }
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
    const attached = new Set<string>(attachedEdges(w, [id]).map((e) => e.id))
    w.sandboxes = Object.fromEntries(Object.entries(w.sandboxes).filter(([k]) => k !== id)) as World['sandboxes']
    w.edges = Object.fromEntries(Object.entries(w.edges).filter(([edgeId]) => !attached.has(edgeId))) as World['edges']
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
    const flowId = this.uid('fl') as FlowId
    for (const e of targets) {
      this.enqueueTaskSilently(e.target as AgentId, { title: tr.template, prompt: `${tr.template}\n\nTriggered by ${tr.name}.`, priority: tr.kind === 'webhook' ? 'high' : 'normal', origin: { kind: 'trigger', id }, input: null }, flowId)
    }
  }

  private enqueueTaskSilently(agentId: AgentId, fields: Pick<Task, 'title' | 'prompt' | 'priority' | 'origin' | 'input'>, flowId: FlowId) {
    if (!this.world.agents[agentId]) return
    const id = this.uid('tk') as TaskId
    const task: Task = { id, flowId, agentId, ...fields, status: 'queued', createdAt: this.world.now, attempts: 0, retryAt: null, blockedOn: null }
    this.world.tasks = { ...this.world.tasks, [id]: task }
    this.event('task', { kind: 'task', id }, `Queued “${task.title}” for ${this.nameOf(agentId)}`)
  }

  private tickRuns(dt: number) {
    for (const run of Object.values(this.world.runs)) {
      if (run.status !== 'running') continue
      const agent = this.world.agents[run.agentId]
      if (!agent) continue
      const progress = clamp(run.progress + dt / run.durationMs, 0, 1)
      this.patchRun(run.id, { progress, tokens: run.tokens + Math.round(this.rand(80, 600) * (dt / 1000)) })
      if (this.rng() < 0.28) {
        const [level, msg] = this.pick(RUN_LOG_LINES)
        if (level !== 'error') this.log(level, msg, { runId: run.id, agentId: run.agentId })
      }
      if (this.world.now - run.startedAt > agent.timeoutMs) {
        this.log('error', `run exceeded timeout of ${Math.round(agent.timeoutMs / 1000)}s`, { runId: run.id, agentId: run.agentId })
        this.finishRun(run, { status: 'failed', reason: 'timeout' })
        continue
      }
      if (progress >= 1) {
        const ok = this.rng() < 0.85
        if (!ok) this.log('error', this.pick(RUN_LOG_LINES.filter(([l]) => l === 'error'))[1], { runId: run.id, agentId: run.agentId })
        this.finishRun(run, ok ? { status: 'succeeded', agent } : { status: 'failed', reason: 'task error' })
      }
    }
  }

  private finishRun(run: Run, completion: RunCompletion) {
    const w = this.world
    const agent = w.agents[run.agentId]
    const task = w.tasks[run.taskId]
    const output = completion.status === 'succeeded' ? createRunOutput(run, completion.agent) : null
    this.patchRun(run.id, {
      status: completion.status,
      endedAt: w.now,
      progress: completion.status === 'succeeded' ? 1 : run.progress,
      output,
      error: completion.status === 'failed' ? completion.reason : null,
    })
    const sb = w.sandboxes[run.sandboxId]
    if (sb && sb.leases.some((l) => l.runId === run.id)) {
      this.patchSandbox(sb.id, { leases: sb.leases.filter((l) => l.runId !== run.id) })
    }
    if (output) {
      if (agent) this.patchAgent(agent.id, { completed: agent.completed + 1 })
      if (task) this.patchTask(task.id, { status: 'succeeded' })
      this.log('info', `run finished: ${run.title}`, { runId: run.id, agentId: run.agentId })
      this.event('run', { kind: 'run', id: run.id }, `${this.nameOf(run.agentId)} finished “${run.title}”`)
      const prompt = [output.summary, ...output.artifacts.map((a) => `${a.kind}: ${a.label}${a.url ? ` (${a.url})` : ''}`)].join('\n')
      for (const e of Object.values(w.edges)) {
        if (e.kind === 'handoff' && e.source === run.agentId) {
          this.enqueueTaskSilently(e.target as AgentId, {
            title: `${run.title} → ${this.nameOf(e.target)}`, prompt, priority: task?.priority ?? 'normal',
            origin: { kind: 'handoff', from: run.agentId, runId: run.id }, input: { ...output, runId: run.id },
          }, task?.flowId ?? (this.uid('fl') as FlowId))
        }
      }
    } else if (completion.status === 'failed' && task && agent) {
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

  /**
   * Phase 1 resolves dependency outcomes for every pending task from task
   * records (never agent or run status), so terminal prerequisite failures
   * cannot hide behind paused, full, or retrying agents. Phase 2 runs the
   * existing admission checks (priority, concurrency, pause, retry deadline,
   * sandbox capacity) for tasks whose dependencies allow them to proceed.
   */
  private schedule() {
    const w = this.world
    const edges = Object.values(w.edges)
    const dependsSources = new Map<AgentId, Set<AgentId>>()
    for (const e of edges) {
      if (e.kind !== 'depends-on') continue
      const set = dependsSources.get(e.target as AgentId) ?? new Set<AgentId>()
      set.add(e.source as AgentId)
      dependsSources.set(e.target as AgentId, set)
    }
    const depBlocked = new Set<TaskId>()
    // one index per pass: dependency matching scans flow/agent buckets instead of
    // rescanning all tasks per pending task. Statuses are read fresh from w.tasks
    // below, so cancellations made earlier in this pass stay visible.
    const tasksByFlowAgent = new Map<FlowId, Map<AgentId, Task[]>>()
    for (const t of Object.values(w.tasks)) {
      const byAgent = tasksByFlowAgent.get(t.flowId) ?? new Map<AgentId, Task[]>()
      const bucket = byAgent.get(t.agentId) ?? []
      bucket.push(t)
      byAgent.set(t.agentId, bucket)
      tasksByFlowAgent.set(t.flowId, byAgent)
    }
    const pending = Object.values(w.tasks).filter((t) => t.status === 'queued' || t.status === 'waiting')
    for (const task of pending) {
      const sources = dependsSources.get(task.agentId)
      if (!sources) {
        // the agent lost its depends-on edges: a stale waiting-on reason must not survive the pass
        if (task.blockedOn?.startsWith('waiting on')) this.patchTask(task.id, { blockedOn: null })
        continue
      }
      const byAgent = tasksByFlowAgent.get(task.flowId)
      const matches = (byAgent ? [...sources].flatMap((a) => byAgent.get(a) ?? []) : [])
        .filter((t) => t.id !== task.id)
        .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      const terminal = matches.map((m) => w.tasks[m.id]).find((m) => m.status === 'failed' || m.status === 'cancelled')
      if (terminal) {
        // re-read the record: an earlier cancellation or start this pass must not be overwritten
        const cur = w.tasks[task.id]
        if (!cur || (cur.status !== 'queued' && cur.status !== 'waiting')) continue
        this.patchTask(task.id, { status: 'cancelled', retryAt: null, blockedOn: null })
        this.event('task', { kind: 'task', id: task.id },
          `Cancelled “${task.title}” (task ${task.id}, flow ${task.flowId}): prerequisite “${terminal.title}” (task ${terminal.id}) ${terminal.status}`)
        continue
      }
      const active = matches.map((m) => w.tasks[m.id]).filter((m) => m.status === 'queued' || m.status === 'waiting' || m.status === 'running')
      if (active.length > 0) {
        const names = active.map((m) => `“${m.title}” (task ${m.id})`).join(', ')
        this.patchTask(task.id, { status: 'waiting', blockedOn: `waiting on ${names}` })
        depBlocked.add(task.id)
      } else if (task.blockedOn?.startsWith('waiting on')) {
        // dependencies cleared: drop the stale reason so admission reasons show through
        this.patchTask(task.id, { blockedOn: null })
      }
      // all matches succeeded, or no matches exist: eligible for admission
    }
    for (const agent of Object.values(w.agents)) {
      if (agent.status === 'paused') continue
      let free = agent.concurrency - this.runningCount(agent.id)
      const pending = Object.values(w.tasks)
        .filter((t) => t.agentId === agent.id && (t.status === 'queued' || t.status === 'waiting'))
        .sort((x, y) => PRIORITY_RANK[x.priority] - PRIORITY_RANK[y.priority] || x.createdAt - y.createdAt)
      for (const task of pending) {
        if (free <= 0) break
        if (depBlocked.has(task.id)) continue
        if (task.retryAt !== null && task.retryAt > w.now) continue
        // least-loaded attached sandbox with room; the reduce keeps edge insertion
        // order on ties, so an idle Coder still picks mac-studio before builder-a
        const attached = edges.filter((e) => e.kind === 'runs-in' && e.source === agent.id)
        const candidates = attached
          .map((e) => w.sandboxes[e.target as SandboxId])
          .filter((x): x is Sandbox => !!x && x.state === 'running' && x.leases.length < x.capacity)
        const sandbox = candidates.length === 0 ? undefined : candidates.reduce((best, x) => (x.leases.length < best.leases.length ? x : best))
        if (!sandbox) {
          this.patchTask(task.id, { status: 'waiting', blockedOn: attached.length > 0 ? 'no free sandbox' : 'no sandbox attached' })
          continue
        }
        this.startRun(agent, task, sandbox)
        free -= 1
      }
    }
  }

  private startRun(agent: Agent, task: Task, sandbox: Sandbox) {
    const id = this.uid('run') as RunId
    const run: Run = {
      id, taskId: task.id, agentId: agent.id, sandboxId: sandbox.id, title: task.title, attempt: task.attempts + 1,
      status: 'running', progress: 0, durationMs: this.rand(7000, 18000), startedAt: this.world.now, endedAt: null, tokens: 0,
      output: null, error: null,
    }
    this.world.runs = { ...this.world.runs, [id]: run }
    this.patchTask(task.id, { status: 'running', attempts: task.attempts + 1, retryAt: null, blockedOn: null })
    this.patchSandbox(sandbox.id, { leases: [...sandbox.leases, { agentId: agent.id, runId: id, since: this.world.now }] })
    this.patchAgent(agent.id, { status: 'working' })
    this.log('info', `run started on ${sandbox.name} (attempt ${run.attempt}): ${task.title}`, { runId: id, agentId: agent.id })
    if (task.input) {
      const n = task.input.artifacts.length
      const upstream = task.origin.kind === 'handoff' ? this.nameOf(task.origin.from) : 'upstream'
      this.log('info', `input: ${n} artifact${n === 1 ? '' : 's'} from ${upstream} run ${task.input.runId.slice(-6)}`, { runId: id, agentId: agent.id })
    }
    this.event('run', { kind: 'run', id }, `${agent.name} started “${task.title}” on ${sandbox.name}`)
  }

  private nameOf(id: string): string {
    const w = this.world
    return w.agents[id as AgentId]?.name ?? w.sandboxes[id as SandboxId]?.name ?? w.triggers[id as TriggerId]?.name ?? w.groups[id as GroupId]?.name ?? id
  }

  private nextFreePosition(): Position {
    const n = Object.keys(this.world.sandboxes).length
    return { x: 320 + (n % 4) * 320, y: 680 }
  }

  private nextGroupName(): string {
    const used = new Set(Object.values(this.world.groups).map((g) => g.name))
    let n = 1
    while (used.has(`Group ${n}`)) n++
    return `Group ${n}`
  }
}

/**
 * Normalization for a node record coming back from undo: runtime
 * state (live status, leases, metric history, trigger schedule) starts fresh,
 * everything else returns as captured.
 */
function restoredAgent(a: Agent): Agent {
  return { ...a, status: a.status === 'paused' ? 'paused' : 'idle', groupId: a.groupId ?? null }
}

function restoredSandbox(s: Sandbox, now: number): Sandbox {
  return { ...s, capacity: isCapacity(s.capacity) ? s.capacity : 1, leases: [], history: [], stateSince: now, groupId: s.groupId ?? null }
}

function restoredTrigger(t: Trigger): Trigger {
  return { ...t, lastFiredAt: null, groupId: t.groupId ?? null }
}

/** A stored record readied for the live world again: the reload normalization, under its own id. */
function restoredNode(ref: NodeRef, now: number): NodeRef {
  switch (ref.kind) {
    case 'agent': return { kind: 'agent', node: restoredAgent(ref.node) }
    case 'sandbox': return { kind: 'sandbox', node: restoredSandbox(ref.node, now) }
    case 'trigger': return { kind: 'trigger', node: restoredTrigger(ref.node) }
  }
}

/** Configuration only, under a new id. Runtime state starts as a new node's, except that a paused agent stays paused. */
function pastedNode(ref: NodeRef, id: string, offset: Position, now: number): NodeRef {
  const position = { x: ref.node.position.x + offset.x, y: ref.node.position.y + offset.y }
  switch (ref.kind) {
    case 'agent': {
      const { name, role, model, temperature, concurrency, timeoutMs, retry, tools, systemPrompt, status } = ref.node
      return {
        kind: 'agent',
        node: {
          id: id as AgentId, name, role, model, temperature, concurrency, timeoutMs, retry: { ...retry }, tools: [...tools], systemPrompt,
          status: status === 'paused' ? 'paused' : 'idle', position, completed: 0, failed: 0, groupId: null,
        },
      }
    }
    case 'sandbox': {
      const { name, kind, host, image, capacity } = ref.node
      return {
        kind: 'sandbox',
        node: {
          id: id as SandboxId, name, kind, host, image, capacity: isCapacity(capacity) ? capacity : 1, state: 'provisioning', stateSince: now, progress: 0,
          metrics: { cpu: 0, mem: 0, disk: 4 }, history: [], leases: [], restartPending: false, position, groupId: null,
        },
      }
    }
    case 'trigger': {
      const { name, kind, intervalMs, enabled, template } = ref.node
      return { kind: 'trigger', node: { id: id as TriggerId, name, kind, intervalMs, enabled, template, lastFiredAt: null, fired: 0, position, groupId: null } }
    }
  }
}
