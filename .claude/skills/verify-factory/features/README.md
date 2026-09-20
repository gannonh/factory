# Factory verification map

This directory is the maintained source for verifying Factory's user-facing web behavior with `agent-browser`.

## Baseline preconditions

- Run Factory from the repository root with the launch procedure in [SKILL.md](../SKILL.md).
- Source the run's state file at the start of every shell call. It sets `FACTORY_ORIGIN`, `FACTORY_EVIDENCE_DIR`, and `AGENT_BROWSER_SESSION`.
- Never reuse a server or browser session that the current run did not start.
- Run `doctor.sh` before driving the page and after any failed drive.
- Set the viewport to 1440 by 900 after opening the page.
- A new origin loads four agents, three sandboxes, two triggers, and no tasks or runs. The seed starts unpaused and its triggers create work within seconds, so pause before a recipe that requires unchanged seed state.

## Driving conventions

- Snapshot with `agent-browser snapshot -i` before interaction and after every state change.
- Use role, accessible-name, label, and placeholder locators, or refs from the latest snapshot. Do not use coordinates.
- `--name` matches a substring. Add `--exact` when two controls share text.
- The snapshot shows text after CSS transforms, so headings, column headers, labels, and log levels appear in uppercase. `find` ignores case.
- Use `agent-browser eval` only for read-only proof.
- The app saves `factory.world.v3` at most once per second. Wait 1200 ms after a UI change before reading it.
- View, selection, dock tab, and dock collapsed state live in memory only. A reload returns to Canvas with the Logs tab open.

## Proof and skip reporting

- Record a video of the action and capture a screenshot before and after it. `record start` resets the page to the seed world, so meet each recipe's preconditions after starting the recording.
- For a mutation, read the stored value through `factory.world.v3` after the UI changes.
- Name evidence files after the sub-feature ID, for example `sim-pause.webm`, `sim-pause-before.png`, `sim-pause-after.png`, and `sim-pause-storage.json`.
- Post the evidence to the pull request with `post-evidence.sh`.
- Report an unreachable entry point with the attempted locator and snapshot. Do not claim it passed through another entry point.

## Features

- [Simulation controls](simulation-controls.md) covers pause, resume, speed selection, reset, and persisted simulation state.
- [Workspace navigation](workspace-navigation.md) covers the Canvas, Agents, and Sandboxes rail destinations.
- [Canvas editing](canvas-editing.md) covers duplicate, copy and paste, delete, undo, redo, layout, and fit on the graph canvas.
- [Node groups](node-groups.md) covers grouping a selection, naming the group, moving members together, and ungrouping, driven by the `Group` and `Ungroup` toolbar buttons.
- [Agent task composition](agent-task-composition.md) covers opening an agent, composing a task, priority, queue visibility, and persisted task state.
- [Sandbox creation](sandbox-creation.md) covers the sandbox form, cancellation, provisioning, and persisted sandbox state.
- [Operational dock](operational-dock.md) covers Queue, Runs, Logs, Events, collapse, expand, run history after a reload, and the agent inspector's runs shortcut.
