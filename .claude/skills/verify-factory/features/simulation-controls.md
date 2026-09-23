# Simulation controls

Simulation controls let a user pause or resume the scheduler, change its speed, and reset Factory to the seeded world.

## Sub-features

- `sim-pause` pauses the simulation. The button reads Resume.
- `sim-resume` resumes a paused simulation. The button reads Pause.
- `sim-speed` selects 1x, 2x, or 4x. The selected button stays highlighted.
- `sim-reset` clears generated work, restores the seed, and returns the simulation to unpaused at 1x.

## How to get to it (user POV)

- Use the `Pause` or `Resume` button in the top-right simulation controls.
- Use the `1×`, `2×`, or `4×` button beside the pause control.
- Use `Reset` in the same top bar. Its title is `Reset to seed data`.
- These controls have no keyboard shortcuts.

## Driving it with agent-browser

Preconditions:

- Doctor passes for the current run.
- The session is at `FACTORY_ORIGIN` on a new origin with no agent inspector open.
- `agent-browser snapshot -i` lists `button "Pause"`.

- **Pause.** Run the `sim-pause` proof in [SKILL.md](../SKILL.md): record, screenshot, `agent-browser find role button click --name "Pause"`, wait for `Resume`, screenshot, read storage, stop recording. Require `present: false` and a Resume button.
- **Resume.** `agent-browser find role button click --name "Resume"`, then `agent-browser wait --text "Pause"`. The snapshot lists `button "Pause"`.
- **Change speed.** `agent-browser find role button click --name "4×"`. After 1200 ms, take an after screenshot and require the `4×` button to be the highlighted speed.
- **Reset.** `agent-browser find role button click --name "Reset"`. The pause control reads `Pause`, the dock tabs read `Queue 0`, `Runs 0`, `Logs 0`, and `Events 0`, and `Undo` and `Redo` are disabled. After 1500 ms, a screenshot shows `1×` highlighted, and the Sandboxes view lists only the three seeded sandboxes.

## Gotchas

- The speed buttons use the multiplication sign `×` (U+00D7), not the letter x.
- The selected speed shows only as a color change, which a snapshot cannot see. Prove speed through the highlighted button in a screenshot.
- An open agent inspector contains its own `Pause` or `Resume` button for that agent. Drive the simulation control with no agent selected, or choose `Close inspector` first.
- Reset restores the seed world on the server and clears this tab's undo history. `factory.world.v3` stays absent.
- Active cron and webhook triggers create tasks while the simulation runs. Pause first when a stable screenshot matters.
- Do not use Reset as cleanup. `cleanup.sh` discards the run's browser profile.
