# Demonstrating undo and redo (KAT-3407)

The canvas keeps a session undo stack for graph edits. It records right-click spawn, node delete (with the edges attached to the deleted nodes and any separately selected edges, as one step), drag moves (a multi-selection drag is one step), the Layout button (one step), connect, edge kind changes, edge deletes from the Delete key or the edge inspector, and inspector edits to agents, triggers and sandbox capacity. It does not record simulation pause and speed, sandbox lifecycle actions, sandbox creation from the Sandboxes view, agent pause and resume, task enqueue and cancel, trigger Fire, Fit view or selection. The stack holds the newest 100 entries, lives only in memory, and is cleared by a page reload and by Reset. Consecutive edits to the same field of the same node collapse into one step until another entry, an Undo or a Redo intervenes; editing a field back to where the step started removes the step. Rejected and no-op writes add nothing. Undo of a delete brings nodes and edges back under their original ids with the same normalization a reload applies (agents return `idle` unless they were paused, sandboxes return with no leases and an empty metric history, triggers return with no last-fired time), while runs and tasks keep the status the delete gave them. The checked-in suites under `npm test` cover the history logic and the key matching; this page records the browser walkthrough.

## Base fixture

1. Run `npm run dev` and open http://localhost:5173.
2. Click Reset in the top bar so the seeded world loads. Undo and Redo in the canvas toolbar are disabled.
3. Pause the simulation from the top bar.

## Demonstration (AC1, AC2, AC3, AC4)

1. Right-click the canvas background and pick New trigger. Trigger 3 appears where you right-clicked and Undo becomes enabled.
2. Drag a connection from Trigger 3 onto Planner. A green `triggers` edge appears.
3. Drag Planner to a new spot.
4. In Planner's inspector, replace the name with `Lead`, then click the canvas background. The node reads Lead.
5. Press Cmd/Ctrl+Z. The node reads Planner again in one step.
6. Press Cmd/Ctrl+Z. Planner moves back to where it was before the drag.
7. Press Cmd/Ctrl+Z. The Trigger 3 → Planner edge disappears.
8. Press Cmd/Ctrl+Z. Trigger 3 disappears. Undo is disabled and Redo is enabled.
9. Press Shift+Cmd/Ctrl+Z. Trigger 3 returns at the spot where it was spawned, with the same name and kind. Undo is enabled and Redo stays enabled because three steps remain.
10. In the Events tab, click the trigger's `created` event. It selects Trigger 3, which shows the node came back under its original id.
11. Click Coder and press Delete. Coder disappears with its four edges: Planner → Coder and Coder → Reviewer handoffs and its `runs-in` edges to mac-studio and builder-a. Redo is now disabled, because a new edit discards the redo steps.
12. Press Cmd/Ctrl+Z. Coder returns with the name Coder, role implementer, concurrency 2 and all four edges. Clicking the `Deleted 1 node` event in the Events tab selects Coder.
13. Press Shift+Cmd/Ctrl+Z to delete Coder and its edges again, then Cmd/Ctrl+Z to bring them back.
14. Marquee-select Reviewer and QA by dragging across empty canvas, and press Delete. One Cmd/Ctrl+Z restores both nodes and their edges.
15. Click Coder, Shift-click the Nightly sweep → Planner edge, and press Delete. One Cmd/Ctrl+Z restores Coder, its edges and the Nightly sweep → Planner edge.

## Moves and layout (AC2)

1. Marquee-select Coder and Reviewer and drag one of them. Both move.
2. Press Cmd/Ctrl+Z once. Both return to their positions before the drag. Shift+Cmd/Ctrl+Z moves both again.
3. Click Layout. Every node moves to the dagre layout.
4. Press Cmd/Ctrl+Z once. Every node returns to its previous position. Shift+Cmd/Ctrl+Z applies the layout again.

## Edges (AC3)

1. Connect two agents, for example QA → Coder with `handoff` picked in the toolbar toggle. Cmd/Ctrl+Z removes the edge and Shift+Cmd/Ctrl+Z restores it; the `Connected QA → Coder (handoff)` event in the Events tab still selects it.
2. Click the Planner → Coder edge and pick `depends on` in the edge inspector. Cmd/Ctrl+Z switches it back to `handoff` and Shift+Cmd/Ctrl+Z switches it to `depends on` again. Undo once more to leave it as `handoff`.
3. Click the Coder → Reviewer edge and press Delete. Cmd/Ctrl+Z restores it.
4. Click the Reviewer → QA edge and click Delete edge in the inspector. Cmd/Ctrl+Z restores it.
5. To confirm the ids, wait one second for the throttled save and run `Object.keys(JSON.parse(localStorage.getItem('factory.world.v3')).edges)` in DevTools. The seeded ids `ed-3` (Coder → Reviewer) and `ed-4` (Reviewer → QA) are listed.

## Inspector fields (AC4)

1. Select Nightly sweep and change Interval (s) from 18 to 30, or edit the Task template text, then click the canvas background. One Cmd/Ctrl+Z restores the full previous value and one Shift+Cmd/Ctrl+Z re-applies the full new value (select the trigger again to read it).
2. Select builder-a and change Capacity from 2 to 3, then press Enter or click the canvas background. One Cmd/Ctrl+Z restores 2 and one Shift+Cmd/Ctrl+Z restores 3.
3. Select Planner, change Retry policy Attempts from 3 to 4, then Backoff ms from 2000 to 3000, then click the canvas background. One Cmd/Ctrl+Z restores both 3 and 2000.
4. Select Planner, change its name, then its role, then click the canvas background. The first Cmd/Ctrl+Z restores the role and the second restores the name.

## Runtime state (AC5)

1. With the simulation paused, queue three tasks in Coder's inspector, then resume.
2. When Coder's Live workload shows a running run and a queued count above zero, pause the simulation and note Coder's `failed` counter.
3. Select Coder on the canvas and press Delete, then press Cmd/Ctrl+Z.
4. Coder and its four edges return. Coder shows `idle` and its `failed` counter equals the value noted in step 2.
5. The Runs tab lists each run that was running as `failed` with reason `agent deleted`. Opening a run's task (for example from its `Queued` event in the Events tab) shows `failed`. The task that was still queued no longer appears in Queue, and its `Queued` event opens a task showing `cancelled`.

## Stack bounds and rejections (AC6)

1. On a fresh load, Undo and Redo are disabled.
2. Make an edit, then click Reset. Undo and Redo are disabled.
3. Make an edit, wait one second for the throttled save, and reload the page. The edit is still on the canvas and Undo and Redo are disabled.
4. With Undo disabled, Cmd/Ctrl+Z does nothing. When every step has been redone, Redo is disabled and Shift+Cmd/Ctrl+Z does nothing.
5. Starting from an empty stack (for example right after Reset):
   - Set builder-a's Capacity to 0 and press Enter. Capacity stays at 2 and Undo stays disabled.
   - Re-enter builder-a's current capacity and press Enter. Undo stays disabled.
   - Draw Planner → Coder with `handoff` picked in the toolbar toggle. The `edge already exists` toast appears and Undo stays disabled.
6. Draw Planner → Coder with `depends on` picked (one step). Open the new edge from its `Connected Planner → Coder (depends on)` event in the Events tab, since it overlaps the handoff edge on the canvas, and pick `handoff` in the edge inspector. The kind stays `depends on`, because Planner → Coder already has a handoff edge, and one Cmd/Ctrl+Z removes the depends-on edge, leaving Undo disabled.
7. Make two edits and press Cmd/Ctrl+Z once. Redo is enabled. Make another edit. Redo is disabled.

## Controls (AC7)

1. The canvas toolbar shows `Undo ⌘/Ctrl+Z` and `Redo ⇧⌘/Ctrl+Z` next to Layout and Fit. Hovering Redo shows `Redo (⇧⌘/Ctrl+Z or ⌘/Ctrl+Y)`.
2. Drag Planner on the canvas, switch to the Agents view and press Cmd/Ctrl+Z, then switch back: Planner is at its previous position. In the Agents view, select Planner and change its Model; with the select still focused, press Cmd/Ctrl+Z. The model is restored.
3. In the Sandboxes view, select builder-a, change Capacity and press Enter, then click an empty part of the inspector and press Cmd/Ctrl+Z. The capacity is restored.
4. Select Nightly sweep and click its `enabled` checkbox. With the checkbox still focused, press Cmd/Ctrl+Z. The checkbox is checked again.
5. Drag Planner, then type into Planner's task composer title input or prompt textarea. Press Cmd/Ctrl+Z inside the field: the browser's text undo applies to the field and Planner does not move. Click the canvas background and press Cmd/Ctrl+Z: Planner moves back.
6. After an Undo, press Cmd/Ctrl+Y. The step is redone and the browser history page does not open.

## Evidence

- Deterministic history scenarios for every recorded edit, restore normalization, coalescing, rejections, the 100-entry bound and Reset: `tests/history.test.ts` via `npm test`.
- Key matching for Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Cmd/Ctrl+Y and the text entry guard: `tests/historyShortcuts.test.ts` via `npm test`.
- Browser screenshots from the Build acceptance run are kept locally under the runner's `uat-evidence/` directory (`uat-evidence/` is gitignored; not committed).

## Verification

1. `npm ci`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `npm run dev`
