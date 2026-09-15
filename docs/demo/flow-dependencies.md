# Demonstrating flow dependencies in the browser (KAT-3366)

A task waits for every existing prerequisite task within its own flow; unrelated flows progress independently. Each manual enqueue and each trigger firing mints a flow id, shown as a badge in Queue and Runs (hover or keyboard-focus for the full id) and as selectable text in the task inspector. The checked-in API suite `npm run test:flows` covers the scheduling rules deterministically; this page records the browser walkthrough.

## Base fixture

1. Run `npm run dev -- --host 127.0.0.1 --port 5184 --strictPort` and open the app.
2. Pause the simulation from the top bar.
3. Remove the seeded handoff edges (Planner → Coder, Coder → Reviewer) and the `depends-on` edge Reviewer → QA so trigger tasks can be counted directly.
4. Remove the extra `runs-in` edge Coder → mac-studio so Coder only uses builder-a; Planner keeps mac-studio.
5. Disable the seeded triggers (Nightly sweep, GitHub PR opened) in their inspectors.
6. Create a manual trigger and connect it to both Planner and Coder with `triggers` edges.
7. Draw a `depends-on` edge Planner → Coder (use the agent→agent edge toggle).
8. Give Planner and Coder concurrency 1 in their inspectors.

## Overlap sequence (AC2, AC3, AC7, AC8)

1. Fire the manual trigger twice while paused. Two firings, two flows: Queue shows both tasks per agent with distinct flow badges.
2. Resume. Planner/F1 starts on mac-studio; Coder/F1 waits with `waiting on “<planner task title>” (task tk-…)` in the Waiting-on column; Planner/F2 waits with `no free sandbox`.
3. When Planner/F1 succeeds (≈13s of simulated time), Coder/F1 starts on builder-a while Planner/F2 runs on mac-studio. Both flows visible in Runs with badges.
4. Open a task inspector: the full flow id is selectable text; hover/focus a Queue or Runs badge for the full id.
5. Enqueue a manual task on Coder while Planner is busy: it has a fresh flow and starts on the next eligible pass, because no Planner task exists in its flow.

## Failure sequence (AC5, AC7)

1. Repeat the base fixture in a fresh browser session (or reset).
2. In Planner's inspector set maximum attempts to 1 and Timeout (s) to 5 — below the simulated run duration of 7–18s.
3. Fire the trigger once and resume.
4. Planner's task times out and fails on its first attempt. Coder's pending task is cancelled on the next scheduling pass; Events contains one task event naming the coder task's title, task id, and flow id, and the planner task's title, id, and actual terminal state. The row is truncated; hover it (or focus it with the keyboard) to read the complete message.
5. Keep the Coder task inspector open to see its terminal `cancelled` status after it leaves the Queue.

## Evidence

- Browser screenshots and recording: `uat-evidence/` (added during the Build acceptance run).
- Deterministic API scenarios for retry, multiple matches, propagation, and admission constraints: `tests/flows.test.ts` via `npm run test:flows`.
