# Demonstrating sandbox capacity in the browser (KAT-3367)

A sandbox hosts up to its `capacity` concurrent runs. The scheduler picks the least-loaded running sandbox attached by a `runs-in` edge; the Sandboxes card, the canvas sandbox node and the `leased` KPI show leases against capacity; the sandbox inspector edits capacity; stopping, restarting, rebuilding or destroying a sandbox fails every run it leases. The checked-in API suite `npm test` covers the scheduling rules deterministically; this page records the browser walkthrough.

## Base fixture

1. Run `npm run dev` and open the app.
2. Click Reset in the top bar so the seeded world loads, or use a fresh browser profile. The world persists edits to `localStorage` under `factory.world.v3`, so a second run would otherwise start with the previous run's changes (builder-a capacity 3, edges removed, triggers disabled) and checkpoint 1 would be unreachable.
3. Pause the simulation from the top bar.
4. Disable the seeded triggers (Nightly sweep, GitHub PR opened) in their inspectors.
5. Remove the seeded handoff edges Planner → Coder and Coder → Reviewer.
6. Remove the `runs-in` edge Coder → mac-studio so Coder is attached only to builder-a.
7. Set Coder concurrency to 3 in its inspector.

builder-a is seeded with capacity 2. HMR of `src/api/mockServer.ts` re-seeds the world, so reload the page after editing it.

## Capacity sequence (AC3, AC5, AC6)

1. With the simulation paused, compose three manual Coder tasks.
2. Resume just long enough for the first two runs to start on builder-a, then pause again. Runs last a random 7–18s of simulated time; if the simulation keeps running, a finishing run frees a slot and the waiting third task starts before the `2/2` states can be captured.
3. With the simulation paused, capture checkpoints 1 and 2: the Sandboxes card and the canvas node read `leases 2/2` and the card lists both holders by agent name and run title, while the third task waits with `no free sandbox` in Queue.
4. In builder-a's sandbox inspector raise Capacity to 3, then resume. The third task starts on the next scheduling pass (checkpoint 3).
5. Click Stop on builder-a: all three runs fail with reason `sandbox stop`, their tasks show `retry 2/3 …` (the existing retry text reports the upcoming attempt), and the card reads `leases 0/3` (checkpoint 4).

## Checkpoints

1. The builder-a card at `2/2` with both holders listed.
2. Queue showing the waiting task's `no free sandbox` reason.
3. The sandbox inspector after raising capacity, with three leases on builder-a.
4. Events after Stop showing three `sandbox stop` failures.

## Evidence

- Browser screenshots from the Build acceptance run (2026-09-15) are kept locally under the runner's `uat-evidence/` directory (`uat-evidence/` is gitignored; not committed), plus a recording if the browser recorder was available; if unavailable, that limitation is recorded in the run's `evidence.md`.
- Deterministic API scenarios for capacity, least-loaded selection, lifecycle failure and the v3 storage key: `tests/capacity.test.ts` via `npm test`.

## Verification

1. `npm ci`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `npm run dev`
