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

## Driving it with agent-browser

Preconditions:

- Doctor passes for the current run.
- `agent-browser snapshot -i` lists buttons named `Canvas`, `Agents`, and `Sandboxes`.

- **Open Agents.** `agent-browser find role button click --name "Agents"`. `agent-browser snapshot` shows `heading "Agents"` and column headers `AGENT`, `STATUS`, `MODEL`, `TEMP`, `LOAD`, `QUEUE`, `DONE`, `FAILED`, `TOKENS`, `SANDBOXES`, and `TOOLS`.
- **Open Sandboxes.** `agent-browser find role button click --name "Sandboxes"`. The snapshot shows `heading "Sandboxes"`, `button "New sandbox"`, and cards containing `mac-studio`, `builder-a`, and `hetzner-cx32`.
- **Return to Canvas.** `agent-browser find role button click --name "Canvas"`. The snapshot lists groups whose names start with `Nightly sweep`, `GitHub PR opened`, `Planner`, `Coder`, `Reviewer`, `QA`, `mac-studio`, `builder-a`, and `hetzner-cx32`, plus groups named `Edge from <id> to <id>`.
- **Prove no mutation.** Read the keys of `agents`, `sandboxes`, `triggers`, and `edges` in `factory.world.v3` before and after navigation. The four key sets are identical, and the stored world has no `view` key.

## Gotchas

- `Agents` and `Sandboxes` each appear as a rail button and as other page text. Use the button role.
- React Flow exposes canvas nodes as groups whose names run the label, role, model, and load together, such as `Plannertech leadopus-50/1`. Match the name prefix from the snapshot.
- Sandbox cards in the Sandboxes view have no role or accessible name. Find them by their text.
- The selected view is not stored. A reload returns to Canvas.
- The right inspector can remain open while the main workspace changes. The bottom dock is independent of the selected workspace.
