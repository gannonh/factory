# Domain vocabulary

This document defines the words Factory uses for its domain. Code, tickets, ADRs and agent prompts use these words with these meanings. When a term changes, change it here first.

`docs/domain.html` draws how the work terms nest, from issue lifecycle down to run, for one example issue. Open it in a browser. Update it in the same change as this file.

Each term is marked **built** when it exists in code today, or **planned** when an ADR or a ticket defines it and no code exists yet.

## The graph

- **Graph.** The agents, sandboxes and triggers on the canvas and the edges between them. The graph is configuration. It says what may happen, and nothing in it is a piece of work. **Built.**
- **Node.** An agent, a sandbox or a trigger. **Built.**
- **Agent.** A configured worker: name, role, model, system prompt, tools, concurrency, timeout, retry policy and delivery. It runs tasks. An agent is a definition, not a running process. **Built.**
- **Sandbox.** A place where runs execute, with a capacity of concurrent runs. A `local` sandbox runs a real agent process in a git worktree on the server's machine. Every other sandbox kind is simulated. **Built.**
- **Trigger.** A node that starts work on the agent it joins. A cron or webhook trigger fires on an interval in the simulation. A manual trigger fires on request. A Linear trigger polls Linear and takes issues. **Built.**
- **Edge.** A typed connection between two nodes. There are four kinds. **Built.**
  - **triggers.** Trigger to agent. The trigger starts work on that agent.
  - **handoff.** Agent to agent. When a run of the source agent succeeds, a task with its output starts on the target agent, in the same flow.
  - **depends-on.** Agent to agent. A task on the target agent waits for the source agent's task in the same flow to succeed.
  - **runs-in.** Agent to sandbox. The agent's runs may use that sandbox.

## Work

- **Flow.** One starting task plus every task that handoff creates from it. A flow begins when a trigger fires, when an operator composes a task, or when a Linear trigger takes an issue. It ends when every task in it is succeeded, failed or cancelled. It finished when no task failed, and it failed when any task failed. A flow is a single pass of work through part of the graph. It is not an issue's lifecycle: one issue can have many flows. **Built** (`flowId`).
- **Task.** One unit of work for one agent: a title, a prompt, a priority and an optional input from an upstream run. A task waits in the queue until the scheduler starts a run for it. **Built.**
- **Run.** One attempt at a task in one sandbox. A run streams logs and ends succeeded, failed or cancelled. A retry is a new run of the same task. **Built.**
- **Attempt.** The number of a run within its task: 1 for the first run, 2 for the first retry. **Built.**
- **Turn.** One exchange inside an agent session: the agent receives a message and replies, possibly after using tools. A run of Claude Code can take many turns. Factory does not track turns. They exist only inside the agent process. **Not a Factory term.**
- **Output.** A succeeded run's summary and artifacts. **Built.**
- **Artifact.** A typed reference that a run produced: a branch, a commit, a pull request, a file or a note. **Built.**
- **Input.** The upstream run's output that a handoff passes to the downstream task. **Built.**
- **Delivery.** What Factory does with a succeeded real run's commits, set per agent. `none` does nothing. `pull-request` makes Factory push the run's branch and open a pull request, which becomes a `pr` artifact. A run with no commits opens nothing, and a failed push or PR creation fails the run. ADR 0009. **Built.**
- **Retry policy.** How many attempts an agent's task gets and how long it waits between them. A failed run with attempts left schedules a retry. The task stays open, and so does its flow. **Built.**

## Issues and Linear

- **Issue.** A work item in the team's tracker. Today the only tracker is Linear. **Built.**
- **Workflow (Linear).** A Linear team's list of issue states, such as Backlog, Todo, In Progress, In Review and Done. This is Linear's term. It has nothing to do with Factory's flows. **Built.**
- **Issue lifecycle.** The path an issue takes through its tracker's workflow, from the moment Factory picks it up until it is done or cancelled. Linear owns it. An issue's lifecycle spans many stages, rounds and human gates, and it can last days. **Planned** as the Gate 4 pipeline. Gate 3 covers one stage of it.
- **Intake.** A Linear trigger's polling of Linear and its taking of issues in the pickup state. **Built.**
- **Intake record.** Factory's saved record of an issue it has taken: the issue, the trigger, its flows and the writes it has made to the issue. It is never pruned, so an issue is never taken twice by mistake. **Built.**
- **Pickup state.** The Linear state a Linear trigger takes issues from, such as Start or Todo. **Built.**
- **Started, finished and failed states.** The Linear states a Linear trigger moves an issue to when its flow's first run starts, when the flow finishes, and when the flow fails. Each can be left unset. **Built.**
- **Write-back.** Factory's writes to an issue: state moves, notes and pull request attachments. Each write is idempotent and retries until it lands. A move is dropped instead when the issue has left its trigger's pickup and started states, because a person moved it. **Built.**
- **Note.** A comment Factory posts on an issue when a flow ends. It lists each task's summary and artifacts or the failure reason, and it is signed with the runs and agents. A cancelled flow's note says why: the issue was canceled or moved in Linear, or a task was cancelled in Factory. **Built.**
- **Attachment.** A link Factory adds to an issue when its flow ends, one per pull request the flow's real runs produced. Factory keys it by URL, so it lands once. **Built.**

## The pipeline

ADR 0008 defines these terms. Gate 4 builds them. `docs/pipeline.html` draws the proposed pipeline end to end.

- **Stage.** A Linear trigger on one state plus the agents its flows reach. A stage does one job in the issue lifecycle, such as build, agent review or merge. **Planned.**
- **Round.** One entry of an issue into a stage's state. Each round runs exactly one flow. An issue that enters Todo, moves to Agent Review and returns to Todo for rework has three rounds: two in the build stage and one in the agent review stage. A round is not a turn and not an attempt. **Planned** (KAT-3619).
- **Human gate.** A Linear state that no trigger handles. Factory takes no action on an issue there. A person releases it by moving the issue to another state. **Planned.**
- **Pipeline.** The chain of stages and human gates that an issue lifecycle follows, such as build, agent review, human review, merge and rework. **Planned.**
- **Recommended default.** The value Factory chooses for a setting from the team's workflow, marked "recommended" in the inspector, with Reset to recommended. **Built.**

## Execution

- **Simulation.** Factory's simulated execution for every sandbox kind except `local`. Simulated runs have made-up durations and outputs. They exist so the control plane can be built and tested before every backend is real. **Built.**
- **Real run.** A run on a `local` sandbox, which spawns the agent CLI (Claude Code) in a git worktree. A delivering agent's worktree is cut from origin's default branch, on the issue's branch name for an issue task. **Built.**
- **World.** The server's whole state: graph, tasks, runs, intake records, logs and events. Every tab receives it over a websocket, and the server saves it to `world.json`. It holds no secrets. **Built.**

## Planning terms

These words describe how the work on Factory is planned. They are not product terms.

- **Gate.** A Linear milestone with a PASS condition, such as Gate 3: Linear lifecycle. Do not confuse it with a human gate, which is a product term.
- **Phase.** A later milestone that has no PASS condition yet.
- **Epic.** A Linear parent issue whose children are slices in delivery order.
- **Slice.** One ticket and one pull request that a user can exercise once it merges.

## Words with more than one meaning

- **Lifecycle.** Use "issue lifecycle" for an issue's path through its tracker's workflow. A sandbox's provisioning, running and stopping states are its "sandbox state machine".
- **Gate.** Use "Gate N" for planning milestones and "human gate" for a pipeline state that waits for a person.
- **Workflow.** Use it only for a Linear team's list of states. Factory's unit of work is a flow.
- **Pipeline.** Use it only for the chain of stages. The canvas configuration is the graph.
