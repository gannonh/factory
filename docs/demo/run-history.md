# Demonstrating run history across a reload (KAT-3368)

Tasks, runs and events persist to `localStorage` under `factory.world.v3`, so a page reload restores the Runs tab, the Queue and the Events tab to the state they were in. Logs stay session-only. Each save keeps every `running` run, the newest 200 completed (`succeeded` or `failed`) runs by `startedAt`, the tasks those runs reference, every `queued`/`waiting`/`running` task, and every task sharing a flow with a kept pending task, so dependency evaluation after reload sees the same prerequisites. A run that was in progress at reload time is recorded as `failed` with `interrupted by reload` and its task follows the normal failed-attempt rule: retry while attempts remain, otherwise fail. The checked-in API suite `npm test` covers this deterministically; this page records the browser walkthrough.

## Save timing

Saves are throttled: the mock server writes at most once per second, one second after the first change since the last write. A reload inside that window loses the last change (up to one second of simulated activity). That is accepted for the simulation; let a second pass after a checkpoint before reloading so the state is on disk.

## Base fixture

1. Run `npm run dev` and open the app.
2. Click Reset in the top bar so the seeded world loads, or use a fresh browser profile. The world persists edits to `localStorage` under `factory.world.v3`, so an older save is discarded on the key bump but the current one is not.
3. Pause the simulation from the top bar.
4. Disable the seeded triggers (Nightly sweep, GitHub PR opened) in their inspectors.
5. Remove the seeded handoff edges Planner → Coder and Coder → Reviewer.

## Completed history (AC2, AC5)

1. With the simulation paused, queue a manual Coder task and resume. Coder is attached to mac-studio and builder-a; the run lasts 7–18s of simulated time.
2. When the run succeeds, pause again. In Runs, note its status, attempt, tokens, started time and duration, and its Flow badge; open the run and note the output summary and artifacts.
3. Reload the page. Runs still lists the run with the same status, attempt, tokens and duration, the same Flow badge, and the panel still shows the output summary and artifacts. Started and ended times read the same as before, because `World.now` comes back from the save.
4. A failed run keeps its failure reason across the reload, for example after stopping a sandbox mid-run (`sandbox stop`).
5. Open the run's Logs: there are none, because logs are not persisted, and the panel reads `logs are kept for the current session` (AC9).

## Interrupted run (AC3)

1. Queue a Coder task and resume. While the run shows the cyan pulse and `running`, reload the page.
2. After reload the run is `failed` with reason `interrupted by reload`, its duration is frozen and non-negative, and no sandbox shows a lease for it.
3. Queue shows the task waiting with `retry 2/3 in 2s` (the upcoming attempt against Coder's max of 3). Resume: once the deadline passes the task runs again as attempt 2.
4. To see the exhausted case, set Coder's Retry max attempts to 1 in the agent inspector, start a run, and reload mid-run: the task ends `failed`, Coder's failed counter increments, its status turns red, and one run event records the interruption.

## Queue (AC4)

1. Create a manual trigger wired to Planner and fire it with the Planner → Coder handoff in place, and Coder's `runs-in` edges removed so it has no sandbox. Planner succeeds and Coder's handoff task waits with `no sandbox attached`.
2. Reload. Queue still shows the task with the same flow id, priority, origin (`handoff from Planner`) and blockedOn, and its input section still shows the upstream output.
3. Attach Coder to a running sandbox and resume: the restored task starts, proving handoff and dependency behaviour continue from the restored state.
4. A task waiting on a retry deadline keeps its `retryAt`: reload during backoff, and it stays waiting until the same deadline passes, then starts.

## Reset (AC7)

Click Reset in the top bar: Runs, Queue and Events empty and the saved history is removed from `localStorage`.

## Evidence

- Deterministic API scenarios for AC1 and AC3–AC8: `tests/persistence.test.ts` via `npm test`, including a reload driven by a second `MockServer` on the same injected storage and a fresh-module id-reseed check.
- The storage seam and key bump are exercised by `tests/capacity.test.ts`.
- Browser screenshots from the Build acceptance run are kept locally under the runner's `uat-evidence/` directory (`uat-evidence/` is gitignored; not committed).

## Verification

1. `npm ci`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `npm run dev`
