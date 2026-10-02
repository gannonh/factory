# Linear changes cancel the flow, and a cancel in Factory writes back

## Decision

Each poll of a Linear trigger also reads the current state of every issue whose flow is still open and was taken by that trigger. One batched `issues` query filtered by id covers them. An issue missing from the answer has been deleted or archived. If the query fails, the poll records its error on the trigger and nothing is taken or cancelled.

Each intake record keeps the trigger's pickup and started states from when it took the issue, so editing the trigger later does not cancel flows it already took. A record saved before this decision has none and reads the trigger's current states.

A pure function, `flowAction` in `server/writeBack.ts`, decides from the issue's state and whether its flow is open. An open flow whose issue sits in its record's pickup or started state is left alone. A canceled-type state or a missing issue cancels the flow with the reason "canceled in Linear". Any other state cancels it with "moved to <state> in Linear". A flow that has ended is never touched.

The intake record stores why its flow was cancelled in `cancel`. The first cause wins. A cancel from Linear cancels every queued or waiting task in the flow and ends every running run as `cancelled`, which kills a local process through the runner's kill path. A cancelled run does not retry. When the flow ends, the record queues one note that gives the reason, and no move. Any move that has not landed is marked `dropped` and is never sent.

Cancelling a task of an issue's flow in Factory cancels the whole flow the same way and stores the cancelled task's title. When the flow ends, the stored cause decides the writes even if another task failed: a move to the failed state, then a note naming that task. A flow that ends cancelled for another reason, such as a cancelled prerequisite, names its first cancelled task.

A run still running in a saved world whose flow was cancelled restores as cancelled rather than failed, so a restart does not retry it.

`ensureState` moves an issue only out of its record's pickup and started states. An issue found anywhere else was moved by a person, so the move is marked `dropped`. A move dropped while it is in flight stays dropped whatever its answer.

## Reason

ADR 0008 makes Linear the record of where an issue is. A person who cancels or moves an issue has decided where it goes, so Factory stops its work and leaves the state alone. A note is still useful: it tells that person what Factory had done and that it stopped.

Reading states on the existing poll keeps one cadence with Linear and needs no webhooks. One query for all open issues keeps the cost to one request per trigger per poll.

A retried or late move could otherwise land after a person's move and undo it. Reading the state before moving was already part of `ensureState`, so checking it against the trigger's states costs nothing extra.

Storing the cause on the record keeps the note's text stable across a restart. The note's comment id is saved before it is sent, as in ADR 0007, so a restart between the cancel and the note posts it once.

## Limits

A disabled trigger does not poll, so its open flows do not react to Linear until it is enabled again. A run that is already collecting its git artifacts when the cancel arrives finishes as succeeded, but hands nothing on. A cancelled issue keeps its intake record, so returning it to the pickup state does not start a new flow. If Linear refuses a comment on a deleted issue, the note retries like any failed write.

## When to reopen

Reopen this decision when an issue's return to the pickup state must start a new round, or when Factory must react to edits of an issue's title or description.
