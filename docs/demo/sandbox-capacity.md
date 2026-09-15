# Demonstrating sandbox capacity in the browser (KAT-3367)

A sandbox hosts up to its `capacity` concurrent runs. The scheduler picks the least-loaded running sandbox attached by a `runs-in` edge; the Sandboxes card, the canvas sandbox node and the `leased` KPI show leases against capacity; the sandbox inspector edits capacity; stopping, restarting, rebuilding or destroying a sandbox fails every run it leases. The checked-in API suite `npm test` covers the scheduling rules deterministically; this page records the browser walkthrough.

## Base fixture

1. Run `npm run dev` and open the app.
2. Pause the simulation from the top bar.
3. Disable the seeded triggers (Nightly sweep, GitHub PR opened) in their inspectors.
4. Remove the seeded handoff edges Planner → Coder and Coder → Reviewer.
5. Remove the `runs-in` edge Coder → mac-studio so Coder is attached only to builder-a.
6. Set Coder concurrency to 3 in its inspector.

builder-a is seeded with capacity 2. HMR of `src/api/mockServer.ts` re-seeds the world, so reload the page after editing it.

## Capacity sequence (AC3, AC5, AC6)

1. With the simulation paused, compose three manual Coder tasks.
2. Resume. Two runs start on builder-a while the third waits with `no free sandbox` in Queue.
3. The Sandboxes card and the canvas node read `leases 2/2`; the card lists both holders by agent name and run title.
4. In builder-a's sandbox inspector raise Capacity to 3. The third task starts on the next scheduling pass.
5. Click Stop on builder-a: all three runs fail with reason `sandbox stop`, their tasks show `retry 2/3 …` (the existing retry text reports the upcoming attempt), and the card reads `leases 0/3`.

## Checkpoints

1. The builder-a card at `2/2` with both holders listed.
2. Queue showing the waiting task's `no free sandbox` reason.
3. The sandbox inspector after raising capacity, with three leases on builder-a.
4. Events after Stop showing three `sandbox stop` failures.

## Evidence

- Browser screenshots and recording from the Build acceptance run (2026-09-15) are kept locally under the runner's `uat-evidence/` directory (`uat-evidence/` is gitignored; not committed). The recording is attempted with the available browser recorder; if no recorder is available, that limitation is recorded in the run's `evidence.md`.
- Deterministic API scenarios for capacity, least-loaded selection, lifecycle failure and the v2 storage key: `tests/capacity.test.ts` via `npm test`.

## Verification

1. `npm ci`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `npm run dev`
