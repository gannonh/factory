# Use wall time for local runs

## Decision

Local runs store `startedAt` and `endedAt` from `Date.now()`. Their displayed elapsed time reads the wall clock. Simulated runs keep using `world.now`, which pause and speed control. The server continues publishing while a local run is active even if the simulation is paused.

The top bar says that simulation controls do not stop a local process. The Runs tab and agent inspector show an indeterminate state for local runs.

## Reason

A process continues running when the simulation pauses or changes speed. Using simulated time for its duration would freeze or distort the displayed value. Scheduler admission still follows simulated time, so pausing stops new admissions without suspending an active process.

## Limits

KAT-3498 will use wall time for local timeout and lease age. This slice uses wall time for run duration only.
