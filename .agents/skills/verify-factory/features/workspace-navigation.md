# Workspace navigation

The left rail switches the main workspace among the graph canvas, agent roster, and sandbox pool without changing the simulated world.

## Sub-features

- `nav-canvas` opens the orchestration graph.
- `nav-agents` opens the agent roster and fleet metrics.
- `nav-sandboxes` opens the sandbox pool and capacity metrics.

## How to get to it (user POV)

- Choose `Canvas` in the left rail.
- Choose `Agents` in the left rail.
- Choose `Sandboxes` in the left rail.

## Driving it with Kata Code preview

Preconditions:

- Doctor passes for the current run.
- The semantic snapshot exposes buttons named `Canvas`, `Agents`, and `Sandboxes`.

- **Open Agents.** Click `role=button[name='Agents']`. A heading named `Agents` appears with roster columns including `Agent`, `Status`, `Model`, and `Tools`.
- **Open Sandboxes.** Click `role=button[name='Sandboxes']`. A heading named `Sandboxes`, the `New sandbox` button, and cards for `mac-studio`, `builder-a`, and `hetzner-cx32` appear.
- **Return to Canvas.** Click `role=button[name='Canvas']`. The React Flow application and seeded nodes named `Planner`, `Coder`, `Reviewer`, and `QA` appear.
- **Prove no mutation.** Read `factory.world.v3` before and after navigation. Navigation may allow normal simulation ticks, but it does not add or remove agents, sandboxes, triggers, or edges.

## Gotchas

- `Agents` appears both as a rail button and as page text. Use the button role.
- React Flow exposes canvas nodes as groups with multi-line accessible names.
- The right inspector can remain open while the main workspace changes.
- The bottom dock is independent of the selected workspace.
