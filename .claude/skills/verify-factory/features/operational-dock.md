# Operational dock

The bottom dock exposes queued work, current and completed runs, log output, and simulation events while the user stays in any workspace.

## Sub-features

- `dock-queue` shows queued, waiting, and running tasks.
- `dock-runs` shows run status, progress, attempts, tokens, and duration.
- `dock-logs` filters log lines by level, text, and selected agent.
- `dock-events` opens the subject named by an event.
- `dock-collapse` collapses and expands the dock.
- `dock-run-history` keeps runs and events across a reload.

## How to get to it (user POV)

- Choose `Queue`, `Runs`, `Logs`, or `Events` in the bottom dock header.
- From an agent inspector, choose `open runs` to select the Runs tab.
- Choose `Collapse dock` or `Expand dock` at the right edge of the dock header.

## Driving it with agent-browser

Preconditions:

- Doctor passes and the Factory page is visible.
- `agent-browser snapshot -i` lists the dock tabs as the label plus a live count, such as `button "Queue 0"`, `button "Runs 0"`, `button "Logs 0"`, and `button "Events 0"`. Take each tab's ref from the snapshot line that starts with its label.

- **Open Queue.** Click the Queue tab ref. The panel shows task rows, or text starting `Queue is empty.`
- **Open Runs.** Click the Runs tab ref. The panel shows `No runs yet.` or a table with column headers `STATUS`, `RUN`, `AGENT`, `FLOW`, `SANDBOX`, `PROGRESS`, `ATTEMPT`, `TOKENS`, `STARTED`, and `DURATION`. To produce runs, queue a task for Planner, choose `Resume`, wait four seconds, and choose `Pause`.
- **Open Logs.** Click the Logs tab ref. The snapshot lists buttons `DEBUG`, `INFO`, `WARN`, and `ERROR`, `textbox "filter…"`, `checkbox "selected agent only"`, and `button "following"`. `agent-browser find role button click --name "ERROR"` on a new origin shows `No log lines at this level yet.`
- **Open Events.** Click the Events tab ref. Each event is a button named by its message, such as `Queued “vf-task-1” for Planner`. Choosing a task event opens the task inspector, which shows the text `TASK` and headings `DETAILS`, `PROMPT`, and `RUNS`.
- **Collapse and expand.** `agent-browser find role button click --name "Collapse dock"` and require `button "Expand dock"`. `agent-browser find role button click --name "Expand dock"` brings the active panel back. Choosing any tab, or `open runs` in an agent inspector, also expands a collapsed dock.
- **Run history.** With at least one run listed, `agent-browser reload`, open the Runs tab, and require the earlier rows. A run that was in progress stays in progress, because the server kept it. `localStorage.getItem('factory.world.v3')` is null.

## Gotchas

- Tab names include a changing count. The Runs count covers running runs only, while the panel lists all runs.
- `checkbox "selected agent only"` is disabled until an agent is selected. The follow control reads `following` or `follow tail`.
- The log level names are lowercase in the source and uppercase in the snapshot. `find` ignores case.
- Curly quotes surround task titles in event names. Copy the name from the snapshot.
- A run event also switches the dock to Runs, an edge event switches the workspace to Canvas, and an event whose subject was deleted does nothing.
- Dock tab and collapsed state are not stored. A reload opens the dock on Logs. Logs are not stored either.
- Log and event counts change while the simulation runs. Pause when exact counts matter.
