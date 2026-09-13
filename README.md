# Factory

An orchestration-graph control plane for a software factory: agents, sandboxes, triggers and task pipelines, with a simulated backend that keeps running while you watch.

This is the UI-first prototype. Every API call goes to an in-browser mock server (`src/api/mockServer.ts`) that runs a simulation loop and persists the graph to `localStorage`. There is no database and no network.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. `npm run build` type-checks and produces a production bundle. `npm run lint` runs oxlint.

## MVP features

Canvas (React Flow v12)

- Three node types: agent, sandbox, trigger.
- Four edge kinds, validated by node type and drawn distinctly: triggers (green solid), handoff (violet solid), depends-on (amber dashed), runs-in (cyan dotted).
- Edges animate while their upstream agent is working, a trigger has just fired, or a sandbox is leased.
- Node positions persist through the mock API and survive reloads.
- Auto-layout (dagre, left to right, sandboxes below the agents that use them), fit view, marquee select, right-click spawn, minimap, keyboard delete.
- Dragging a connection onto any part of a node connects it. A toolbar toggle picks handoff or depends-on for agent-to-agent edges. The edge inspector switches kinds after the fact.

Agents

- Roster with fleet KPIs: utilization, throughput, failure rate, average run time, tokens.
- Inspector: name, role, model, temperature, concurrency, timeout, retry policy, tools editor, system prompt, live workload with per-run progress, pause and resume.
- Task composer: title, prompt, priority. Tasks land in the queue and run when a sandbox is free.

Sandboxes

- Pool of cards with live CPU, memory, disk, a CPU sparkline, lease holder and lease age.
- Lifecycle state machine: provisioning, running, stopping, stopped, rebuilding, destroying, error. Only legal actions are enabled. Provisioning and rebuilding animate with step text.
- Create new sandboxes (local, docker, vps, remote) and watch them come up.

Runs, logs, events

- Resizable bottom dock with Queue (with cancel and blocked-on reason), Runs (history, progress, attempts, tokens, duration), Logs (level filter, text filter, selected-agent filter, follow-tail that releases when you scroll up), and Events (click to jump to the node, edge, or run).

Simulation

- Cron and webhook triggers fire on an interval and enqueue tasks on connected agents.
- The scheduler respects concurrency, depends-on edges, and sandbox leases. Runs emit logs, succeed or fail, retry per policy, and hand off downstream.
- Pause, 1x/2x/4x speed, and reset to seed data from the top bar.

## Layout of the code

- `src/domain/types.ts` is the whole domain: branded ids, node and edge types, the sandbox transition table, the edge rule table, and the status colour tables.
- `src/domain/seed.ts` is the seed world.
- `src/api/mockServer.ts` owns state, the tick loop, the scheduler, and persistence.
- `src/api/client.ts` is the API surface the UI calls. Replacing this object with HTTP plus a websocket is the whole backend swap.
- `src/store.ts` holds the world snapshot plus UI state (view, selection, dock).
- `src/components/canvas` is the React Flow graph, `inspector` the right panel, `agents` and `sandboxes` the list views, `dock` the bottom panel.

## Not in the MVP yet

- Real backends: connecting to local, VPS and remote hosts, real agent processes, real logs.
- Auth, teams, multiple projects.
- Undo, copy and paste, node grouping.
- Persisted run history beyond the current session.

## License

MIT. See [LICENSE](LICENSE).
