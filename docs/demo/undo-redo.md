# Demonstrating undo and redo (KAT-3407)

The canvas keeps a session undo stack for graph edits. It records right-click spawn, node delete (the deleted nodes, every edge attached to them and any separately selected edges, as one step), drag moves (a multi-selection drag is one step), the Layout button (one step), connect, edge kind changes, edge deletes from the Delete key or the edge inspector, and inspector edits to agents, triggers and sandbox capacity. It does not record simulation pause and speed, sandbox lifecycle actions, sandbox creation from the Sandboxes view, agent pause and resume, task enqueue and cancel, trigger Fire, Fit view or selection. The stack holds the newest 100 entries, lives only in memory, and is cleared by a page reload and by Reset. Consecutive edits to the same top-level field of the same node collapse into one step until another entry, an Undo or a Redo intervenes; editing a field back to where the step started removes the step. Rejected and no-op writes add nothing. Undo of a delete brings nodes and edges back under their original ids with the same normalization a reload applies (agents return `idle` unless they were paused, sandboxes return with no leases and an empty metric history, triggers return with no last-fired time), while runs and tasks keep the status the delete gave them. The checked-in suites under `npm test` cover the history logic and the key matching; this page records the browser walkthrough.

## Base fixture

1. Run `npm run dev` and open http://localhost:5173.
2. Click Reset in the top bar, then Pause. Click Fit in the canvas toolbar if the graph sits under the toolbar. Undo and Redo in the canvas toolbar are disabled.

Each section below starts from this fixture, so its step counts begin with an empty undo stack. The shortcut keys act only while focus is outside text entry, so click the canvas background after typing in an inspector field before pressing them. Clicking the background also closes the inspector; select the node again to read its values. To check ids, wait one second for the throttled save and run `JSON.parse(localStorage.getItem('factory.world.v3')).edges` (or `.agents`, `.triggers`) in DevTools.

## Demonstration (AC1, AC2, AC3, AC4)

1. Right-click the canvas background and pick New trigger. Trigger 3 appears where you right-clicked and Undo becomes enabled.
2. Drag a connection from Trigger 3's handle onto Planner. A green `triggers` edge appears.
3. Drag Planner to a new spot.
4. In Planner's inspector, replace the name with `Lead`, then click the canvas background. The inspector closes and the node reads Lead.
5. Press Cmd/Ctrl+Z. The node reads Planner again in one step.
6. Press Cmd/Ctrl+Z. Planner moves back to where it was before the drag.
7. Press Cmd/Ctrl+Z. The Trigger 3 → Planner edge disappears.
8. Press Cmd/Ctrl+Z. Trigger 3 disappears. Undo is disabled and Redo is enabled.
9. Press Shift+Cmd/Ctrl+Z. Trigger 3 returns under the same id at the spot where it was spawned. Undo is enabled and Redo stays enabled because three steps remain.
10. Click Coder and press Delete. Coder disappears with its four edges: the Planner → Coder and Coder → Reviewer handoffs and its `runs-in` edges to mac-studio and builder-a. Redo is now disabled, because a new edit discards the redo steps.
11. Press Cmd/Ctrl+Z. Coder returns with the name Coder, role implementer and all four edges under their seeded ids `ed-2`, `ed-3`, `ed-6` and `ed-7`.

## Delete as one step (AC1)

1. Drag a marquee from empty canvas across Planner and Coder so both are selected, and press Delete. Both nodes and their six edges disappear.
2. Press Cmd/Ctrl+Z once. Both nodes and all six edges return under their original ids and Undo is disabled. Shift+Cmd/Ctrl+Z deletes them again; Cmd/Ctrl+Z brings them back.
3. Click QA, hold Shift (or Cmd on macOS) and click an edge that does not touch QA, for example Planner → Coder, keeping the pointer still while clicking. Press Delete. QA, its two edges and the selected edge disappear. One Cmd/Ctrl+Z restores all of them.

## Moves and layout (AC2)

1. Click Layout. Every node moves to the dagre layout.
2. Press Cmd/Ctrl+Z once. Every node returns to its previous position. Cmd/Ctrl+Y applies the layout again; Cmd/Ctrl+Z reverts it.
3. Marquee-select Planner and Coder and drag one of them. Both move. Redo is disabled, because the drag discarded the layout redo step.
4. Press Cmd/Ctrl+Z once. Both return to their positions before the drag. Shift+Cmd/Ctrl+Z moves both again.

## Edges (AC3)

1. With `handoff` picked in the toolbar toggle, draw Planner → Reviewer. Cmd/Ctrl+Z removes the edge and Shift+Cmd/Ctrl+Z restores it under the same id.
2. Click the new Planner → Reviewer edge and pick `depends on` in the edge inspector. Cmd/Ctrl+Z switches it back to `handoff`, Cmd/Ctrl+Y switches it to `depends on` again, and Cmd/Ctrl+Z leaves it as `handoff`.
3. Draw Reviewer → QA with `handoff`, click the new edge and press Delete. Cmd/Ctrl+Z restores it under the same id.
4. Click the Planner → Reviewer edge and click Delete edge in the inspector. Cmd/Ctrl+Z restores it under the same id; Shift+Cmd/Ctrl+Z deletes it again.

## Inspector fields (AC4)

1. Select Planner. Change Retry policy Attempts from 3 to 5, then Backoff ms from 2000 to 4500, then the name to `Lead`, then the role to `architect`, and click the canvas background.
2. The first Cmd/Ctrl+Z restores the role, the second restores the full name Planner, and the third restores both Attempts 3 and Backoff 2000; Undo is then disabled. Three Shift+Cmd/Ctrl+Z presses re-apply the retry values together, the full name `Lead`, and the role.
3. Select Nightly sweep, change Interval (s) from 18 to 45 and replace the Task template text, then click the canvas background. The first Cmd/Ctrl+Z restores the full previous template, the second restores the 18 s interval, and two redos re-apply them.
4. Select mac-studio, change Capacity from 1 to 3 and press Enter, then click the canvas background so focus leaves the Capacity field. Cmd/Ctrl+Z restores 1 and Shift+Cmd/Ctrl+Z restores 3. With focus still in the Capacity field the keys stay with the field instead.

## Runtime state (AC5)

1. With the simulation paused, select Coder and queue four tasks from its inspector. Coder's concurrency is 2. Queueing does not enable Undo.
2. Resume the simulation. When two Coder runs are `running` and two tasks are queued, note Coder's `failed` counter in its inspector (0 after Reset).
3. With the simulation still running, click Coder on the canvas, press Delete, then press Cmd/Ctrl+Z.
4. Coder returns with its four edges, shows `idle`, and its `failed` counter equals the value noted in step 2. Its `done` counter keeps any run that finished before the delete.
5. In the Runs tab each run that was running when Coder was deleted shows `failed`; opening one shows Failure reason `agent deleted`, and the Events tab shows `Coder gave up on “…” (agent deleted)`. The run's task stays `failed`: its task panel opens from the task's `Queued “…” for Coder` event.
6. Click the `Queued “…” for Coder` event of a task that was still queued at the delete. Its task panel shows `cancelled`.

## Stack bounds and rejections (AC6)

1. On a fresh load and right after Reset, Undo and Redo are disabled. Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z do nothing.
2. Starting from an empty stack right after Reset:
   - Draw Nightly sweep → Planner again. The `edge already exists` toast appears and Undo stays disabled.
   - Select mac-studio, set Capacity to 0 and press Enter. Capacity stays 1 and Undo stays disabled.
   - Enter 1 again and press Enter. Undo stays disabled.
3. Draw Reviewer → QA with `handoff` (one step). Click the new edge and pick `depends on` in the inspector. The kind stays `handoff`, because Reviewer → QA already has a depends-on edge. One Cmd/Ctrl+Z removes the handoff edge and leaves Undo disabled, so the rejected kind change added nothing.
4. Make an edit, wait one second for the throttled save, and reload the page. The edit is still there and Undo and Redo are disabled.

## Controls (AC7)

1. The canvas toolbar shows `Undo ⌘/Ctrl+Z` and `Redo ⇧⌘/Ctrl+Z` before Layout and Fit. Hovering Redo shows `Redo (⇧⌘/Ctrl+Z or ⌘/Ctrl+Y)`.
2. Select Nightly sweep and click its `enabled` checkbox. With the checkbox still focused, press Cmd/Ctrl+Z. The checkbox is checked again.
3. Select Planner and pick another Model. With the select still focused, press Cmd/Ctrl+Z. The previous model returns. Shift+Cmd/Ctrl+Z re-applies the new one; after another Cmd/Ctrl+Z, Cmd/Ctrl+Y re-applies it too.
4. Click into Planner's role input and type two characters. Cmd/Ctrl+Z inside the field undoes the typing through the browser's text undo; the model change from step 3 stays. The same keys inside the system prompt textarea or the Concurrency number input leave the undo stack alone.
5. Click Layout, switch to the Agents view and press Cmd/Ctrl+Z: the layout is undone. Switch to the Sandboxes view: Shift+Cmd/Ctrl+Z redoes it and Cmd/Ctrl+Z undoes it again.
6. With focus outside text entry, Cmd/Ctrl+Y redoes, and the app cancels the key's default action so the browser's own shortcut for it (the History page in Chrome on macOS) does not run. Inside text entry the app leaves the default action alone.

## Evidence

- Deterministic history scenarios for every recorded edit, restore normalization, coalescing, rejections, the 100-entry bound and Reset: `tests/history.test.ts` via `npm test`.
- Key matching for Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Cmd/Ctrl+Y and the text entry guard: `tests/historyShortcuts.test.ts` via `npm test`.
- Browser screenshots, a video of the Demonstration and a step log from the Build acceptance run are kept locally under the runner's `uat-evidence/` directory (`uat-evidence/` is gitignored; not committed).

## Verification

1. `npm ci`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `npm run dev`
