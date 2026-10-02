# Linear state drives stages, and each stage runs a flow

## Decision

An issue's state in Linear decides which stage of the pipeline works on it. Factory does not keep its own record of where an issue is in the pipeline.

A stage is a Linear trigger on one state, joined to the agent that starts the stage's flow. When an issue enters a state that a trigger handles, Factory starts one round for it. A round is one flow: a task on the trigger's agent plus every task that its handoffs create. A depends-on edge orders tasks already in the flow and never adds one. When the round's flow ends, Factory moves the issue to the trigger's finished or failed state, which is how the issue reaches the next stage. A state that no trigger handles is a human gate. Factory takes no action on it, and a person releases the issue by moving it.

Every entry into a handled state starts a new round, including a return to a state the issue was in before. Rework is a return to an earlier state. A round owns its trigger's pickup state and started state. When the issue leaves both while the round is open, Factory cancels the round's flow. A round that fails with no retries left moves the issue to the failed state and stops. It does not start again until a person moves the issue.

Durable context between rounds lives on the issue and its pull request: Factory's signed notes, the operator's comments and the PR's review threads. A round's prompt is built from the issue and that context, so a round that crashes is replaced by a new round with the same inputs. Factory's world holds configuration, rounds, runs and logs for the operator to watch. It is not the authority on an issue's progress.

## Reason

People act on issues in Linear. They reject a pull request, cancel work, change priority and move issues between states, often days apart. If Factory kept a flow per issue that paused at each human gate, every one of those actions would need to be mapped back onto the paused flow, and Factory and Linear would hold two records of where the issue is. Reading the state instead leaves one record. Human gates, rework and cancel then need no extra machinery, and a restart needs no recovery beyond starting the round again.

Kata Symphony (`~/dev/kata-symphony`) runs this model: dispatch on tracker state, context in issue comments, a fresh agent after a failure. Factory adds what Symphony lacks: the pipeline is configured and watched on the canvas, and a stage can be a flow of several agents rather than one agent with one prompt.

Gate 3's slices fit the model. ADR 0007's write-back is the move from one stage to the next. Cancel is an issue leaving a round's state. Rework is a new round on re-entry.

## Limits

Each stage needs a state in the team's Linear workflow. A team without states such as Agent Review or Human Review gets fewer stages until it adds them.

A stage starts within one poll interval of the issue entering its state, so each stage adds up to 30 seconds of delay.

A source without states, such as a cron trigger or a task composed in Factory, runs one flow and has no stages.

Context passed through issue comments is visible to everyone who reads the issue, and every round reads it again.

## When to reopen

Reopen this decision when Factory gains a work backend without workflow states, when a stage must start faster than a poll allows, or when context between stages grows too large to carry on the issue.
