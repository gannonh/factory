# Agent task composition

An agent inspector lets a user enter a title, optional prompt, and priority, then queue a task for the selected agent.

## Sub-features

- `task-open-agent` opens the same agent inspector from the canvas or roster.
- `task-compose` accepts a title and optional prompt.
- `task-priority` selects low, normal, or high priority. The default is normal.
- `task-queue` submits the task and opens the Queue dock tab.
- `task-persist` leaves the queued task visible after a reload. The page does not write `factory.world.v3`.

## How to get to it (user POV)

- On Canvas, choose an agent node such as `Planner`.
- In Agents, choose the agent's table row and use the inspector that opens on the right.
- Enter a task in `Compose task`, then choose `Queue` or press Cmd/Ctrl+Enter from the title or prompt field.

## Driving it with agent-browser

Preconditions:

- Doctor passes and the simulation is paused for a stable queue. Pause before opening the inspector.
- The Canvas snapshot contains a group whose name starts with `Planner`, or the Agents snapshot contains a row whose name starts with `Planner`.

- **Open from Agents.** `agent-browser find role button click --name "Agents"`, take the ref of the row whose name starts with `Planner` from `agent-browser snapshot -i`, and click it. The snapshot shows `button "Close inspector"`, `heading "COMPOSE TASK"`, and `textbox "Task title"`.
- **Open from Canvas.** `agent-browser find role button click --name "Canvas"`, then click the ref of the group whose name starts with `Planner`. The same inspector opens.
- **Compose.** `agent-browser find placeholder "Task title" fill "vf-task-1"`. Optionally fill `agent-browser find placeholder "Prompt / instructions" fill "..."`.
- **Set priority.** `agent-browser find role button click --name "high"`.
- **Queue through the button.** `agent-browser find role button click --name "Queue" --exact`. The fields clear, the composer's `Queue` button is disabled, the dock tab reads `Queue 1`, and the Queue panel lists `button "vf-task-1"`.
- **Queue through the keyboard.** Fill the title, then `agent-browser press Control+Enter`. The same Queue result appears. `Meta+Enter` is equivalent.
- **Prove the task stayed on the server.** `agent-browser reload`, open Queue, and require `button "vf-task-1"`. `localStorage.getItem('factory.world.v3')` is null.

## Gotchas

- A running simulation can move a queued task into a run before the screenshot. Pause before composing when queue visibility is the proof target.
- The title is required. `Queue` stays disabled for a whitespace-only title, and the keyboard shortcut does nothing without a title even when the prompt has text.
- An empty prompt is stored as the trimmed task title.
- The dock tab is named `Queue` plus its count, so `--name "Queue"` without `--exact` can match the tab instead of the composer button.
- The inspector's title `Agent` is plain text, not a heading. Detect the inspector by `button "Close inspector"` and `textbox "Task title"`.
- The canvas group name and the roster row name contain more text after the agent name. Match the name prefix from the snapshot.
