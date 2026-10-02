# Write back to Linear from each intake record

## Decision

Factory moves a taken issue through Linear and posts one note when its flow ends. A Linear trigger stores a started, a finished and a failed state. Each is a Linear state id or null, and null leaves the issue alone. Choosing a team fills the recommended states: the first `started` state for started, the first `started` state named like review for finished, and nothing for failed.

Each intake record holds a phase and an ordered write queue. The phase is `taken`, `started` or `ended`. Every publish derives it from the tasks in the record's flow. The first task with an attempt moves the record to `started` and queues a move to the started state. When every task in the flow is terminal, the record moves to `ended`. A failed task makes the outcome failed. A cancelled task with no failure ends the flow with no terminal write. Otherwise the outcome is finished. A finished or failed outcome queues a move to that outcome's state, then one attach write per pull request the flow's local runs produced (ADR 0009), then a note. A task waiting on a retry is not terminal, so a retry keeps the flow open.

A write reads the trigger's states when it becomes due. The note's body and comment id are fixed then and saved with the record. The body lists each task in flow order with its agent, its latest run id, and its summary and artifacts or its failure reason. A signature line names Factory, every run listed and every agent.

The server drains each issue's queue, one drain per issue. Moves go in order, so a failed move holds back the moves after it, but a note or an attach is independent and goes out whatever happened to the moves. `server/linear.ts` makes each write converge. `ensureState` reads the issue's state and moves it only when it differs. `ensureComment` looks for a comment with the saved id and creates it under that id only when it is missing. `ensureAttachment` looks for an attachment with the pull request's URL and creates it only when it is missing. A landed write records its time. A failed write records its time and error and retries once a poll interval has passed. A landed note drops its text from the record, since only a pending or failed note is sent again. Writes never change task state, and they run whether or not the trigger is enabled.

Records saved before this decision load as `ended` with no writes.

## Reason

Deriving the phase from task state needs no hooks in the run lifecycle. Every path that ends a task already publishes: run completion, retries, cancels, scheduler cancellations and restarts. One pass after each change sees all of them.

The server can stop between a write reaching Linear and its record reaching disk. Linear accepts a client-chosen UUID as a new comment's id. Saving the id before sending and checking for it before creating means a repeated write finds the first comment instead of posting a second. A move checks the current state first for the same reason. The ordered queue keeps the note after the move it reports.

Retrying on the poll interval reuses the cadence intake already keeps with Linear, so a failing Linear sees at most one write attempt per issue per interval.

Defaulting old records to `ended` keeps an upgrade from posting notes for flows that finished before write-back existed.

## Limits

Cancelling in Factory writes nothing yet. Factory does not react to changes made in Linear. A write retries until it lands, with no limit. Each record keeps its note body, so the intake map grows faster than one small record per issue. Retries wait while the simulation is paused, because the poll cadence runs on the tick.

## When to reopen

Reopen this decision when cancel or rework must write to Linear, when Factory must react to Linear-side changes, or when a write needs a retry limit.
