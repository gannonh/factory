# Run execution through one runner interface

## Decision

The scheduler leases a sandbox and creates a `Run`. It then selects a runner by sandbox kind. `local` uses `ClaudeRunner`; Docker, VPS, and remote sandboxes use `SimulatedRunner` until those hosts gain real runners. Both runners send log, token, and completion events to the same server handler. `Runner.kill(runId)` lets the server stop a process when a run ends outside the runner, such as a sandbox stop or server shutdown.

`Run.execution` records the selected runner. A simulated run has numeric `progress` and `durationMs`. A local run stores `null` for both because the process has no known fraction complete or planned duration.

## Reason

The scheduler still owns admission, leases, task retries, and terminal run state. The runner owns execution. This keeps one completion path for status, counters, and dock events while preserving the simulation's existing behavior.

## Limits

This slice starts local processes and handles their natural exit. User cancel and timeout handling follow in KAT-3498. Real run output and handoff follow in KAT-3499.
