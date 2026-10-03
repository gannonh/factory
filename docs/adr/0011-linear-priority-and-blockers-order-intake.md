# Linear priority and blockers order intake

## Decision

A taken issue's task gets its priority from the issue's priority in Linear. `LINEAR_PRIORITY` in `server/linear.ts` is the mapping:

| Linear priority | Number | Task priority |
| --- | --- | --- |
| Urgent | 1 | `high` |
| High | 2 | `high` |
| Medium | 3 | `normal` |
| No priority | 0 | `normal` |
| Low | 4 | `low` |

A number outside the table maps to `normal`. The scheduler already runs higher priority first and older tasks first within one priority, so waiting issues start in the order the team set in Linear.

The pickup query also reads each issue's blockers. In Linear, "A blocks B" is a relation of type `blocks` stored on A, so B's blockers are the `issue` of each of B's inverse relations of type `blocks`. Each blocker carries its identifier, its URL and its current state's name and type. The intake record keeps them in `blockers`.

A blocker is done when its state type is `completed` or `canceled`. While any blocker is not done, the scheduler holds the issue's task as `waiting` with the reason "blocked by ENG-1 (In Review)", naming each unfinished blocker and its state. The task has no attempts, so write-back queues no started move and the issue stays in the pickup state. The task inspector lists each blocker with a link and its state.

A blocked issue stays in the pickup state, so each poll returns it again. While its flow has not started, the poll replaces the record's blockers with what it read and copies the issue's priority onto the queued task. No extra request is needed. On the first poll after the last blocker is done, the task returns to the queue and starts when the agent has a free slot.

A blocker can belong to any team. Factory reads it to decide whether the issue waits, but takes only issues that match the trigger's own filter.

A record saved before this decision loads with no blockers.

## Reason

The team already orders work in Linear with priority and blocking relations. Reading them keeps one source of truth. A second ordering in Factory would drift from it.

In Review still blocks. Factory moves an issue to In Review when it opens the pull request, but the code is not on the default branch until the pull request merges and Linear moves the issue to Done. A dependent issue that started at that point would cut its worktree from a default branch without the blocker's code. A setting to start on In Review earns its place only once Factory can stack one branch on another.

Refreshing only on the pickup poll keeps the cost at one request per trigger per poll. A blocked issue is in the pickup state by definition, so the poll already returns it.

## Limits

Blockers refresh only while the flow has not started. A blocker added after the first run starts does not stop the flow, and the inspector then shows the states from the last read. A disabled trigger does not poll, so its waiting issues keep their last known blockers until it is enabled again. Factory reads the first 50 relations of each issue. Within one priority, issues start in the order Factory took them, and estimates and cycles play no part. The canvas draws no edges for relations.

## When to reopen

Reopen this decision when Factory can stack an issue's branch on its blocker's branch, when a team needs a blocker to release its dependents earlier than Done, or when ordering must use estimates, cycles or a manual rank.
