# Node groups

The graph canvas lets a user group a selection of nodes, name the group, move the members together, and ungroup them.

## Sub-features

- `canvas-group` groups two or more selected ungrouped nodes with the `Group` toolbar button.
- `canvas-ungroup` removes that grouping with the `Ungroup` toolbar button.
- `canvas-group-rename` changes the group name in the group inspector.
- `canvas-group-move` drags the group header so every member moves.

## How to get to it (user POV)

- Choose `Canvas` in the left rail.
- Marquee-select two or more ungrouped nodes, then use `Group` in the toolbar at the top left of the canvas.
- Select a group frame or one of its members, then use `Ungroup`.
- Click the group header to open the group inspector and edit the name.

## Driving it with agent-browser

Preconditions:

- Doctor passes, the simulation is paused, and the viewport is 1440 by 900.
- Drive `Group` and `Ungroup` with `role button` and those exact accessible names. Use `--exact`. Canvas node snapshots also expose accessibility `group` roles for seed agents such as QA; those are not the toolbar buttons. Do not retarget those locators.

- **Group.** `agent-browser find role button click --name "Fit" --exact`. Take the refs of the groups whose names start with `Planner` and `Coder` from `agent-browser snapshot -i`, click the Planner ref, then `agent-browser press Shift`, click the Coder ref. `agent-browser find role button click --name "Group" --exact`. The snapshot lists a group whose name starts with `Group 1`, `Ungroup` becomes enabled, and the inspector heading is `GROUP`. The inspector's members list shows `Planner` and `Coder`.
- **Rename.** With that group selected, fill the inspector name field with `Crew`. The frame header reads `Crew`. After `agent-browser reload`, the snapshot still lists a group whose name starts with `Crew`.
- **Ungroup.** The reload cleared the selection. Take the ref of the group whose name starts with `Crew` from `agent-browser snapshot -i`, click it, then `agent-browser find role button click --name "Ungroup" --exact`. The `Group 1` / `Crew` frame is gone. The snapshot still lists the `Planner` and `Coder` nodes, and `Ungroup` is disabled.

## Gotchas

- At the default viewport, `Fit` leaves the top row of nodes under the canvas toolbar. Set the viewport to 1440 by 900 first.
- `Group` is disabled unless two or more selected nodes are ungrouped. A mixed selection of grouped and ungrouped nodes leaves it disabled.
- `Ungroup` is disabled unless the selection resolves to exactly one group.
- Existing canvas-editing recipes locate seed agents through snapshot `group` names such as QA. Those accessibility groups remain the node shells. The toolbar buttons are `Group` and `Ungroup` with `--exact`.
- Paste and duplicate of grouped members create ungrouped copies. Do not require the copies to share a `groupId`.
