# Operational dock

The bottom dock exposes queued work, current and completed runs, log output, and simulation events while the user stays in any workspace.

## Sub-features

- `dock-queue` shows queued and waiting tasks.
- `dock-runs` shows run status, progress, attempts, tokens, and duration.
- `dock-logs` filters log lines by level, text, and selected agent.
- `dock-events` opens the subject named by an event.
- `dock-collapse` collapses and expands the dock.

## How to get to it (user POV)

- Choose `Queue`, `Runs`, `Logs`, or `Events` in the bottom dock header.
- From an agent inspector, choose `open runs` to select the Runs tab.
- Choose `Collapse dock` or `Expand dock` at the right edge of the dock header.

## Driving it with Kata Code preview

Preconditions:

- Doctor passes and the Factory page is visible.
- The bottom header exposes buttons whose names start with `Queue`, `Runs`, `Logs`, and `Events` because each name also includes a live count.

- **Open Queue.** Click the Queue button from the semantic snapshot. The panel shows either task rows or `Queue is empty`.
- **Open Runs.** Click the Runs button. The panel shows either run rows or its empty state. Selecting `open runs` from an agent inspector chooses the same tab.
- **Open Logs.** Click the Logs button. Level buttons named `DEBUG`, `INFO`, `WARN`, and `ERROR`, the text filter, selected-agent filter, and follow control appear.
- **Open Events.** Click the Events button. Event rows expose their message as the accessible name; choosing one opens its node, edge, task, or run.
- **Collapse and expand.** Click `role=button[name='Collapse dock']`, require `Expand dock`, then click `role=button[name='Expand dock']` and require the active panel to return.
- **Capture proof.** Save a snapshot with the chosen tab name, live count, and panel content visible.

## Gotchas

- Tab button names include a changing numeric count. Use a name prefix from the latest snapshot rather than an exact full string.
- Choosing a tab while the dock is collapsed does not expand it. Use `Expand dock` first.
- `open runs` selects the tab but does not reopen a collapsed dock.
- Log and event counts change while the simulation runs. Pause when exact counts matter.
