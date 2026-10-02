# Work backends enter as polled triggers

## Decision

A work backend such as Linear is a trigger kind, `linear`, and not a new node kind. The trigger stores the team, the optional project and the pickup state. It joins exactly one agent with a `triggers` edge. Each issue in the pickup state becomes one flow and one task on that agent. Handoff edges carry the flow to more agents.

The server polls each enabled Linear trigger every 30 seconds of wall-clock time, and Fire polls at once. No poll runs while the trigger is disabled or the simulation is paused. A new Linear trigger starts disabled, and the server refuses to enable it until it has a team and a pickup state.

`server/linear.ts` is the only code that speaks Linear's GraphQL API. The API key comes from `LINEAR_API_KEY` in the server's environment and stays inside that module's client. The world records each poll's time and error in `World.intakePolls`, which is not saved.

`World.intake` maps each taken issue to its trigger and flow. The server saves it whole and never prunes it. Intake skips any issue that already has a record.

## Reason

A trigger already means "something outside starts a flow on an agent". The canvas, the edge rules, enable and disable, Fire, copy and paste, and undo all work on triggers today. A node kind would repeat all of it. One agent per trigger keeps one issue as one flow, so the flow's tasks and runs answer for that issue.

The server binds to `127.0.0.1`, so Linear cannot deliver webhooks to it without a tunnel or a public relay. Polling needs only outbound HTTPS. A 30 second interval keeps the delay short and the request count low.

Every tab receives the whole world, and the server writes it to disk. A key in the world would reach both. The server's environment is the only place the key lives.

Retention prunes old tasks and runs. If intake checked tasks to find issues it had already taken, a pruned task would let its issue start a second flow. The intake map is small: one record per issue ever taken.

## Limits

Intake reads issues and never writes back to Linear. It does not move an issue to another state, comment on it or link a pull request. A deleted trigger leaves its intake records, so its issues are not taken again by a new trigger. The intake map grows by one record per issue and has no compaction.

## When to reopen

Reopen this decision when the server runs where Linear can reach it, so webhooks become possible. Reopen it also when intake must write to Linear, or when the intake map grows large enough to slow a save.
