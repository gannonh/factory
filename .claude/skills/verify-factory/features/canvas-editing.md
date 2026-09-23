# Canvas editing

The graph canvas lets a user duplicate, copy, paste, and delete nodes, and undo or redo those graph changes.

## Sub-features

- `canvas-duplicate` duplicates the selected nodes with Cmd/Ctrl+D.
- `canvas-copy-paste` copies the selected nodes with Cmd/Ctrl+C and pastes them with Cmd/Ctrl+V.
- `canvas-delete` deletes the selected nodes or edges with Backspace or Delete.
- `canvas-undo-redo` reverts and reapplies graph changes with the `Undo` and `Redo` buttons or Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, and Cmd/Ctrl+Y.
- `canvas-layout` arranges the graph with `Layout` and fits it to the viewport with `Fit`.
- `canvas-spawn` adds an agent, sandbox, or trigger from the canvas context menu.

## How to get to it (user POV)

- Choose `Canvas` in the left rail and select a node by clicking it.
- Use the keyboard shortcuts above while focus is outside a text field.
- Use `Undo`, `Redo`, `Layout`, and `Fit` in the toolbar at the top left of the canvas.
- Right-click empty canvas and choose `New agent`, `New sandbox`, or `New trigger`.

## Driving it with agent-browser

Preconditions:

- Doctor passes, the simulation is paused, and the viewport is 1440 by 900.
- The Canvas snapshot lists a group whose name starts with `QA`, and `button "Undo ⌘/Ctrl+Z"` is disabled.

- **Select.** `agent-browser find role button click --name "Fit" --exact`, take the ref of the group whose name starts with `QA` from `agent-browser snapshot -i`, and click that ref. The agent inspector opens.
- **Duplicate.** `agent-browser press Meta+d`. The snapshot lists two groups whose names start with `QA`, and `Undo` becomes enabled.
- **Undo.** `agent-browser find role button click --name "Undo"`. One `QA` group remains, `Undo` is disabled, and `Redo` is enabled.
- **Redo.** `agent-browser find role button click --name "Redo"`. Two `QA` groups return. After `agent-browser reload`, two `QA` groups remain.
- **Delete.** Click the ref of the last `QA` group, then `agent-browser press Backspace`. One `QA` group remains After `agent-browser reload`, one `QA` group remains.

## Gotchas

- At the default viewport, `Fit` leaves the top row of nodes under the canvas toolbar and `agent-browser` refuses the click as covered. Set the viewport to 1440 by 900 first.
- Delete acts on the canvas selection. After `Undo` or `Redo`, focus is on the toolbar button and nothing is selected, so click the node again before pressing Backspace.
- Copy yields to the browser when page text is selected, for example in the dock logs.
- Shortcuts do nothing while focus is in a text field, where the browser's own undo, copy, and paste apply.
- `canvas-spawn` needs a right-click on empty canvas. `agent-browser` offers that only through pointer coordinates, which this skill does not use. Report `canvas-spawn` as unreachable rather than proving it another way.
- Reset clears undo history.
