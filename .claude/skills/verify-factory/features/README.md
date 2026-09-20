# Factory verification map

This directory is the maintained source for verifying Factory's user-facing web behavior through the Kata Code collaborative preview.

## Baseline preconditions

- Run Factory from the repository root with the launch procedure in [SKILL.md](../SKILL.md).
- Use the new port and `tailscale0` browser origin written to the run's state file.
- Keep the returned shell session ID and preview tab ID. Never reuse an instance or tab that the current run did not create.
- Run `doctor.sh` before driving the page. Require the Factory title in both the HTTP check and the browser tab.
- A new origin loads four agents, three sandboxes, two triggers, and no tasks or runs. Active triggers can create work immediately, so pause before a recipe that requires unchanged seed state.

## Driving conventions

- Call `preview_status`, `preview_open` when needed, `preview_navigate`, and `preview_snapshot` before interaction.
- Use role and accessible-name locators from the snapshot. Do not use coordinates.
- Treat each listed locator and text value as literal.
- Use `preview_evaluate` only for read-only proof, except for the explicit localStorage cleanup step.
- Let the production mock server and persistence throttle run at their normal timing.

## Proof and skip reporting

- Capture the visible action state and the visible result state.
- Save screenshots, doctor output, and the storage transcript under the run's `uat-evidence/verify-factory/<run-id>/` directory.
- For a mutation, read the stored value through `factory.world.v3` after the UI changes.
- Record the feature ID, user entry point, tab ID, origin, port, and server session ID.
- Report an unreachable entry point with the attempted locator and snapshot. Do not claim it passed through another entry point.

## Features

- [Simulation controls](simulation-controls.md) covers pause, resume, speed selection, reset, and persisted simulation state.
- [Workspace navigation](workspace-navigation.md) covers the Canvas, Agents, and Sandboxes rail destinations.
- [Agent task composition](agent-task-composition.md) covers opening an agent, composing a task, priority, queue visibility, and persisted task state.
- [Sandbox creation](sandbox-creation.md) covers the sandbox form, cancellation, provisioning, and persisted sandbox state.
- [Operational dock](operational-dock.md) covers Queue, Runs, Logs, Events, collapse, expand, and the agent inspector's runs shortcut.
