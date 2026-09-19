# Simulation controls

Simulation controls let a user pause or resume the scheduler, change its speed, and reset Factory to the seeded world.

## Sub-features

- `sim-pause` pauses the simulation and persists `sim.paused: true`.
- `sim-resume` resumes a paused simulation and persists `sim.paused: false`.
- `sim-speed` selects 1x, 2x, or 4x and persists the selected speed.
- `sim-reset` clears generated work and restores the seed.

## How to get to it (user POV)

- Use the `Pause` or `Resume` button in the top-right simulation controls.
- Use the `1×`, `2×`, or `4×` button beside the pause control.
- Use `Reset` in the same top bar. Its title is `Reset to seed data`.

## Driving it with Kata Code preview

Preconditions:

- Doctor reports the current run's port and the Factory title.
- The preview tab is at `FACTORY_BROWSER_ORIGIN` with a new origin.
- A semantic snapshot contains `role=button[name='Pause']`.

- **Capture the action state.** Save a snapshot while `Pause` is visible. Copy its screenshot to `pause-before.png`.
- **Pause.** Click `role=button[name='Pause']`. Wait for `Resume` and save another snapshot to `pause-after.png`.
- **Prove persistence.** Read `factory.world.v3` with the expression in `SKILL.md`. Require `present: true` and `paused: true`, then save the returned object as `storage.json`.
- **Resume.** Click `role=button[name='Resume']`. Wait for `Pause`; the stored `sim.paused` value becomes false after the persistence throttle.
- **Change speed.** Click `role=button[name='2×']` or `role=button[name='4×']`. The selected control changes color, and stored `sim.speed` equals the chosen number.
- **Reset.** Click `role=button[name='Reset']`. Tasks, runs, logs, and events return to their seed state, and the persisted world contains no generated tasks or runs.

## Gotchas

- The browser persistence write is throttled by one second. Poll the stored value instead of assuming the visible button change has been saved.
- Reset clears session undo history as well as simulated world changes.
- Active cron and webhook triggers can create tasks while the simulation runs. Pause first when a stable screenshot matters.
- Cleanup removes the storage key directly. Do not use Reset as cleanup evidence.
