You are the orchestrator for the Factory project. This chat lives in the main checkout at /Volumes/EVO/dev/factory and is long-lived. You plan, keep main fast-forwarded, spawn one isolated worktree session per PR, and receive each worker's report when its PR is up or merged. Do not do long implementation work in this chat.

## What Factory is

An orchestration-graph control plane for a software factory: agents, sandboxes, triggers and task pipelines on a React Flow canvas, with a simulated backend that keeps running while you watch. The brief is in init.md. The current phase is UI first with mock APIs, no database, so the interface can be refined before connecting real local, VPS and remote hosts.

## State as of 2026-09-13

- PR #1 (https://github.com/gannonh/factory/pull/1) squash-merged to main as 917a81a. It contains the whole prototype, the README with the MVP feature list, the MIT license, and docs/screenshot.png.
- main checkout is at 917a81a. init.md has an uncommitted local edit there; leave it unless told otherwise.
- Stale worktrees still listed by `git worktree list`: .claude/worktrees/factory-management-ui-0ed522 (branch claude/factory-orchestration-ui-a934ca, merged, remote branch still exists), /private/tmp/factory-simulation-64b4 and ~/.codex/worktrees/64b4/factory (both detached at the first commit). Prune when convenient.
- Review bots: Codex and CodeRabbit comment on PRs. The desktop app's Auto-fix relays their findings to the worker session. CodeRabbit was still running on PR #1 at merge time and may post findings against the closed PR.
- No CI workflow exists yet. Locally `tsc -b`, `oxlint` and `vite build` pass.

## Stack and layout

Vite 8, React 19, TypeScript 6, @xyflow/react 12, zustand, Tailwind 4, @dagrejs/dagre, lucide-react. `npm run dev` serves http://localhost:5173. `.claude/launch.json` has a "factory" config for the in-app browser.

- src/domain/types.ts is the whole domain: branded ids, discriminated unions, SANDBOX_TRANSITIONS (lifecycle state machine), EDGE_RULES (which node kinds each edge kind may join, plus colour and dash), status colour tables.
- src/domain/seed.ts is the seed world and tool catalog.
- src/api/mockServer.ts owns state, the 400ms tick loop, triggers, scheduler, retries, handoff fan-out, and localStorage persistence (throttled 1s).
- src/api/client.ts is the only surface the UI calls. Replacing this object with HTTP plus a websocket is the entire backend swap.
- src/store.ts holds the world snapshot plus UI state (view, selection, dock).
- src/components/canvas (Canvas, nodes, FactoryEdge, layout, ContextMenu), inspector (Agent, Sandbox, Trigger, Edge), agents (roster), sandboxes (pool cards, create form), dock (Queue, Runs, Logs, Events).

## Design decisions already made

- Edge kinds: triggers (trigger→agent, green solid), handoff (agent→agent, violet solid), depends-on (agent→agent, amber dashed), runs-in (agent→sandbox, cyan dotted). Validation and rendering both read EDGE_RULES.
- Agent→agent connections take their kind from a toolbar toggle (handoff or depends-on); the edge inspector can change it later. Changing kind is rejected if it would duplicate an existing edge.
- While a connection drag is in progress every node renders a full-size invisible drop handle, so dropping anywhere on a node connects. Edges pin sourceHandle "out" and targetHandle "in".
- Selection: React Flow's local selected flags are the source; one guarded effect in Canvas.tsx mirrors them into the store, and a second effect pushes external selections (event clicks) back in. A two-way sync through onSelectionChange caused an infinite render loop; do not reintroduce it.
- Scheduler: per-agent concurrency; a sandbox hosts up to its `capacity` concurrent runs, the scheduler picks the least-loaded running sandbox attached by a runs-in edge with `leases.length < capacity` (edge insertion order breaks ties), and tasks wait with a `blockedOn` reason when no attached sandbox has a free slot. A `depends-on` edge makes the target agent's task wait on every existing task of the source agents within the same flow: any failed or cancelled upstream task cancels it (emitting a task event naming both tasks, their ids, and the flow), any queued, waiting or running upstream task keeps it waiting with a `waiting on` reason naming those tasks, and all succeeded or no match lets it proceed to the normal admission checks. Each manual enqueue and each trigger firing mints a flow id; handoff tasks inherit the producing task's flow. Failed runs retry after fixed or exponential backoff via task.retryAt. Deleting a node finishes its runs before removal. `npm test` exercises this through the public API.
- Persistence: agents, sandboxes, triggers, edges, sim settings, `now`, tasks, runs and events in localStorage under `factory.world.v3` (key bumped so older saves are discarded). Each save keeps every running run, the newest 200 completed runs, the tasks they reference, all pending tasks and every task sharing a pending task's flow, plus the newest 400 events. A running run restored at load is replayed through `finishRun` as `interrupted by reload`, so its task retries per policy or fails. Logs stay session-only.

## Gotchas for workers

- React Flow handles listen to mouse events, not pointer events. The in-app browser's drag does not create connections; verify connections with dispatched MouseEvents from the JS tool, or by driving the mock server directly.
- A node spawned near the right edge can sit under the inspector panel.
- HMR of mockServer.ts rebuilds the server from the saved v3 world and replays any in-flight run as `interrupted by reload`; reload the page after editing it.
- The simulation is verified without a browser by `npm test` running the vitest suites (`tests/flows.test.ts`, `tests/capacity.test.ts`): manual-mode servers with an injected rng, driven through the public api object. For ad hoc inspection write a temporary vitest case and import src/api/mockServer.ts directly, then delete it.

## Open product decisions

- Should a handoff pass the upstream run's output as the downstream prompt, or a structured artifact? (Resolved: structured RunOutput with artifacts, KAT-3365.)
- Should depends-on block on the upstream agent being idle (current) or on a specific upstream task finishing? (Resolved: it waits on every existing upstream task within the same flow, KAT-3366.)
- One lease per sandbox (current) or N concurrent leases? (Resolved: sandboxes host up to their capacity, KAT-3367.)

## Candidate next PRs

1. GitHub Actions workflow running npm ci, tsc -b, oxlint, vite build, so PRs have a real gate.
2. Address any CodeRabbit findings that land on PR #1.
3. Real backend adapter behind src/api/client.ts, starting with a local host.
4. Undo, copy and paste, node grouping on the canvas.

## How to dispatch

For each PR: spawn a worktree session with a self-contained brief (files, data shape, success criteria, verification surface), let it open a ready PR against main, and have it report back with the PR URL, the merge commit, and any open decisions. Squash-merge. Keep this chat's context as the single record of plan and state.