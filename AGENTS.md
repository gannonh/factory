# Factory

Factory is a control plane for a software factory: agents, sandboxes, triggers and task pipelines on a React Flow canvas. A Node process owns the world, runs the scheduler and the simulation, and saves the world to disk. The page is a client of that process. `README.md` describes the product and the features that exist today.

Global agent instructions define the work lifecycle, Linear rules and verification. This file holds only what is specific to this repository.

## Planning sources

- Linear team Kata-sh, project [Factory](https://linear.app/kata-sh/project/factory-ad3c9a38d7c1). The project page holds the roadmap and product decisions. Each gate is a milestone, and each epic lists its slices in delivery order.
- Factory is a standalone product with its own vocabulary and architecture. Plan it from this repository and its Linear project.
- Kata Symphony (`~/dev/kata-symphony`, `apps/symphony`) is the functional reference for lifecycle defaults: stages, human gates, retries, and review, CI and merge handling. Read it for behavior. Do not copy its code, terms or module structure. ADR 0008 records which parts of its model Factory adopts.
- Live checks against real Linear use the [Factory UAT](https://linear.app/kata-sh/project/factory-uat-b7104fa5f8c4) project and open PRs in the private scratch repository `gannonh/factory-uat`. Never point a live check at real Kata-sh work or at `gannonh/factory`.

## Commands

| Command | Does |
| --- | --- |
| `npm ci` | Install from the lockfile |
| `npm run dev` | Start the Factory server on `127.0.0.1:8787` and Vite on `127.0.0.1:5173` (`scripts/dev.mjs`) |
| `npm test` | Run the vitest suites |
| `npx tsc -b` | Typecheck the client, server and tests |
| `npm run lint` | Run oxlint |
| `npm run build` | Typecheck and build the client into `dist/` |

CI runs `npm ci`, `npm test`, `npx tsc -b`, `npm run lint` and `vite build` on every pull request and every push to `main`.

The server reads these environment variables:

- `FACTORY_PORT` sets the server port. `FACTORY_ORIGIN` sets the one page origin it accepts.
- `FACTORY_DATA_DIR` sets where `world.json` and run logs live. The default is `.factory/` in the repository root.
- `FACTORY_LOCAL_ROOT` sets the seeded local sandbox's root directory. The default is the current directory.
- `VITE_FACTORY_SERVER` points the page at a server directly instead of through the Vite proxy.
- `LINEAR_API_KEY` is the Linear personal API key for intake. It stays in the server process and never enters the world.
- `FACTORY_LINEAR_URL` sets the Linear GraphQL endpoint. The default is `https://api.linear.app/graphql`. Point it at `scripts/fake-linear.ts` for local trials.

Run `with-env npm run dev` when a change needs secrets such as `LINEAR_API_KEY`.

## Layout

- `src/domain/types.ts` is the whole domain, shared by the server and the page. It holds the branded ids, the discriminated unions, `SANDBOX_TRANSITIONS` and `EDGE_RULES`. Validation and rendering both read `EDGE_RULES`.
- `server/simulation.ts` (`MockServer`) owns the world, the tick loop, triggers, the scheduler, retries and handoff fan-out.
- `server/linear.ts` is the only code that speaks Linear's GraphQL API. `MockServer` polls enabled Linear triggers and takes issues into flows (ADR 0006), then writes each flow's progress back to its issue (ADR 0007). `server/writeBack.ts` derives the write-back phase and note from a flow's tasks, and decides when a change in Linear cancels a flow (ADR 0010). `scripts/fake-linear.ts` is a fake Linear server for tests and local trials.
- `server/runners.ts` runs `local` sandboxes with Claude Code headless and delivers their pull requests (ADR 0009). Other sandbox kinds use the simulated runner. See ADRs 0003 to 0005.
- `server/http.ts` serves `POST /command` and the `/world` websocket on `127.0.0.1`. `server/commands.ts` maps command names to `MockServer` methods, and `server/parse.ts` validates their arguments.
- `server/worldFile.ts` and `server/records.ts` save and parse the world. `server/runLogs.ts` stores real run logs.
- `server/api.ts` is the in-process API that tests use. `sim.advance` exists only there.
- `src/api/client.ts` is the promise API the page calls. `src/store.ts` holds the latest snapshot and UI state. `src/history.ts` is one tab's undo stack.
- `src/components/` holds `canvas`, `inspector`, `agents`, `sandboxes` and `dock`.
- `docs/adr/` holds architecture decisions, numbered in order. `docs/demo/` holds demo scripts for shipped features.

## Constraints that bite

- **The world file parses strictly and has no migrations.** A new persisted field must parse as optional with a default. Otherwise every existing `world.json` is renamed to `world.json.corrupt` and the server starts from the seed (ADR 0002).
- **Secrets never enter the world.** Every tab receives the whole world over the websocket, and the server saves it to disk. Keep keys and raw third-party payloads on the server.
- **A command needs five matching edits:** the `MockServer` method, its entry and parser in `server/commands.ts`, `server/api.ts`, the `Api` type in `src/api/types.ts`, and `src/api/client.ts`.
- **Real runs cost money.** A `local` sandbox spawns `claude` in `<root>/.factory-runs/<runId>`. The seed disables the cron trigger that reaches the local sandbox, so launching the app never starts a paid run. Keep it that way.
- **Selection sync is one-way on purpose.** React Flow's selected flags are the source. One guarded effect in `Canvas.tsx` mirrors them into the store, and another pushes external selections back. A two-way sync through `onSelectionChange` caused an infinite render loop.
- **The server does not reload on file changes.** Restart `npm run dev` after editing `server/`. The world survives the restart.

## Tests

- `tests/fixture.ts` builds a manual-mode `MockServer` with an injected rng and drives it through `server/api.ts`. Advance time with `sim.advance`.
- `tests/linear-intake.test.ts` starts `scripts/fake-linear.ts` on a free port and injects a wall clock. Await in-flight polls with `sim.settled`.
- `tests/local-runner.test.ts` puts a fake `claude` script on PATH. `tests/real-output.test.ts` does the same for `gh`. Follow that pattern for any external CLI or API, and inject a fake rather than calling a live service.
- `tests/server.test.ts` boots the HTTP server on a free port.

## Browser verification

Read `.agents/skills/verify-factory/SKILL.md` before you drive the UI. It launches an isolated server, drives the page with `agent-browser`, records evidence, and posts it to the PR. Its `features/` directory maps each feature to a recipe. Project skills live in `.agents/skills/`. `.claude/skills` is a symlink to that directory, so edit skills only under `.agents/skills/`.

Automated drags do not create React Flow connections, because the handles listen to mouse events rather than pointer events. A node spawned near the right edge can sit under the inspector panel.

## Docs

`docs/domain.md` defines the domain vocabulary, `docs/domain.html` diagrams how work nests, and `docs/pipeline.html` diagrams the pipeline an issue moves through. Use those terms in code, tickets and ADRs. When a term changes or a planned term gets built, update those files in the same PR.

When a change alters behavior that `README.md` or an ADR describes, update that document in the same PR.
