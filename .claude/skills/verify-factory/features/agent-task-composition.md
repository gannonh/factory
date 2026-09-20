# Agent task composition

An agent inspector lets a user enter a title, optional prompt, and priority, then queue a task for the selected agent.

## Sub-features

- `task-open-agent` opens the same agent inspector from the canvas or roster.
- `task-compose` accepts a title and optional prompt.
- `task-priority` selects low, normal, or high priority.
- `task-queue` submits the task and opens the Queue dock tab.
- `task-persist` stores the task under `factory.world.v3`.

## How to get to it (user POV)

- On Canvas, choose an agent node such as `Planner`.
- In Agents, choose the agent's table row and use the inspector that opens on the right.
- Enter a task in `Compose task`, then choose `Queue` or press Cmd/Ctrl+Enter from the title or prompt field.

## Driving it with Kata Code preview

Preconditions:

- Doctor passes and the simulation is paused for a stable queue.
- The Canvas snapshot contains a Planner group, or the Agents snapshot contains a Planner row.

- **Open from Canvas.** Click the group whose accessible name starts with `Planner`. The inspector heading reads `Agent` and contains a `Compose task` section.
- **Open from Agents.** Click `role=button[name='Agents']`, then click the row whose accessible name starts with `Planner`. The same inspector opens.
- **Compose.** Fill `input[placeholder='Task title']` with a unique title and `textarea[placeholder^='Prompt / instructions']` with the requested work.
- **Set priority.** Click `role=button[name='high']`, `role=button[name='normal']`, or `role=button[name='low']`.
- **Queue through the button.** Click `role=button[name='Queue']`. The fields clear, the Queue dock tab becomes active, and the task title appears.
- **Queue through the keyboard.** From a non-empty title or prompt field, press Enter with Control on Linux and Windows or Meta on macOS. The same Queue result appears.
- **Prove persistence.** Read `factory.world.v3` and find one task with the entered title, selected agent ID, and selected priority.

## Gotchas

- A running simulation can move a queued task into a run before the screenshot. Pause before composing when queue visibility is the proof target.
- The title is required. `Queue` remains disabled for whitespace-only titles.
- An empty prompt is stored as the trimmed task title.
- The canvas group name contains model and load text after the agent name. Match the name prefix from the snapshot.
