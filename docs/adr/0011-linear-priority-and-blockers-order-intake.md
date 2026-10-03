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

The pickup query also reads each issue's blockers, and so does the states query that each poll already sends for open flows (ADR 0010). In Linear, "A blocks B" is a relation of type `blocks` stored on A, so B's blockers are the `issue` of each of B's inverse relations of type `blocks`. Each blocker carries its identifier, its URL and its current state's name and type. The intake record keeps them in `blockers`.

A blocker is done when its state type is `completed` or `canceled`. While any blocker is not done, the scheduler holds the issue's task as `waiting` with the reason "blocked by ENG-1 (In Review)", naming each unfinished blocker and its state. The task has no attempts, so write-back queues no started move and the issue stays in the pickup state. The task inspector lists each blocker with a link and its state.

While an issue's flow has not started and is not cancelled, each poll replaces the record's blockers with what the states query read and copies the issue's priority onto the queued task. The states query covers every open record wherever its issue sits, so an issue a person moved to the trigger's started state, or one an edited filter no longer matches, still follows its blockers. A newly taken issue gets its blockers and priority from the pickup query. On the first poll after the last blocker is done, the task returns to the queue and starts when the agent has a free slot.

A blocker can belong to any team. Factory reads it to decide whether the issue waits, but takes only issues that match the trigger's own filter.

A record saved before this decision loads with no blockers.

## Reason

The team already orders work in Linear with priority and blocking relations. Reading them keeps one source of truth. A second ordering in Factory would drift from it.

In Review still blocks. Factory moves an issue to In Review when it opens the pull request, but the code is not on the default branch until the pull request merges and Linear moves the issue to Done. A dependent issue that started at that point would cut its worktree from a default branch without the blocker's code. A setting to start on In Review earns its place only once Factory can stack one branch on another.

Blockers and priority come from the open-flow states query that already runs each poll, so the cost is still one pickup query and one states query per trigger per poll.

## Limits

Blockers refresh only while the flow has not started. A blocker added after the first run starts does not stop the flow, and the inspector then shows the states from the last read. A disabled trigger does not poll, so its waiting issues keep their last known blockers until it is enabled again. Linear cannot filter an issue's inverse relations by type, so Factory reads the first 100 relations of any type and picks the `blocks` ones. When an issue has more, each poll logs a warning naming the issue, and blockers beyond the first 100 relations are not read. A blocker cycle, where A blocks B and B blocks A, holds both issues until a person breaks the cycle in Linear. A blocked issue whose trigger is deleted is no longer polled, so it keeps waiting until an operator cancels its task. Within one priority, issues start in the order Factory took them, and estimates and cycles play no part. The canvas draws no edges for relations.

## When to reopen

Reopen this decision when Factory can stack an issue's branch on its blocker's branch, when a team needs a blocker to release its dependents earlier than Done, or when ordering must use estimates, cycles or a manual rank.
