# Demonstrating copy, paste and duplicate (KAT-3408)

The canvas copies a node selection together with the edges between the selected nodes. Cmd/Ctrl+C copies the selected nodes, Cmd/Ctrl+V pastes the copied fragment, and Cmd/Ctrl+D duplicates the current selection without touching the clipboard. Copies get new ids, keep the configuration and name of their originals, land 40 px right of and below them, and become the canvas selection. A second paste of the same copy lands at 80 px, a third at 120 px. An edge to a node outside the selection is not copied. Runtime state is not cloned: a pasted agent is `idle` (or `paused` if its original was paused) with zeroed counters, a pasted sandbox starts `provisioning` with no leases, and a pasted trigger has never fired. Runs and tasks stay with the originals. Each paste or duplicate is one undo step. The clipboard holds a snapshot taken at copy time, lives in memory only, and is not the system clipboard. The keys act only while the Canvas view is open and focus is outside text entry. While page text is selected, Cmd/Ctrl+C copies that text instead. The checked-in suites under `npm test` cover the clipboard logic, the API rule and the key matching; this page records the browser walkthrough.

## Base fixture

1. Run `npm run dev` and open http://localhost:5173.
2. Click Reset in the top bar, then Pause. Click Fit in the canvas toolbar if the graph sits under the toolbar. Undo and Redo are disabled.

Each section below starts from this fixture. The seeded graph has 10 edges, among them the Planner → Coder handoff, Planner's `runs-in` edge to mac-studio and Coder's `runs-in` edges to mac-studio and builder-a.

## Duplicate and one undo (AC2, AC5)

1. Drag a marquee from empty canvas across Planner and Coder so both are selected.
2. Press Cmd/Ctrl+D. A second Planner and a second Coder appear 40 px right of and below the originals, joined by a violet handoff edge. The two new nodes are selected, the originals are deselected, and the inspector shows one of the new agents with `done` 0 and `failed` 0. Undo becomes enabled.
3. Press Cmd/Ctrl+Z once. Both new agents and the new handoff disappear, the originals and their edges are unchanged, and Undo is disabled.
4. Press Shift+Cmd/Ctrl+Z. Both agents and the handoff return. After the one-second throttled save, `JSON.parse(localStorage.getItem('factory.world.v3')).agents` lists them under the same ids as before the undo.

## Copy and paste (AC1, AC4)

1. Click the canvas background so nothing is selected, then press Cmd/Ctrl+V. Nothing happens and Undo stays disabled, because nothing was copied yet.
2. Marquee-select Planner and Coder and press Cmd/Ctrl+C. Click the canvas background so nothing is selected.
3. Press Cmd/Ctrl+V. New Planner and Coder agents appear at the 40 px offset with a handoff between them, selected. Paste did not need a selection.
4. Press Cmd/Ctrl+V again. A second pair appears at the 80 px offset, and only that pair is selected.
5. Click the canvas background and press Cmd/Ctrl+C. With nothing selected the copy is a no-op: Cmd/Ctrl+V still pastes Planner and Coder, now at 120 px.
6. Press Cmd/Ctrl+Z three times. Each press removes one pasted pair with its handoff.
7. Marquee-select Planner and Coder, press Cmd/Ctrl+C, then press Delete. Press Cmd/Ctrl+V. The pair is pasted from the snapshot taken at copy time, with its handoff, although the originals are gone.

## External edges (AC3)

1. Marquee-select Planner and Coder and press Cmd/Ctrl+D.
2. The canvas has 11 edges: the 10 seeded ones and the new handoff. No dotted `runs-in` edge leaves either new agent, and mac-studio and builder-a have the same edges as before.
3. Marquee-select Planner, Coder and mac-studio and press Cmd/Ctrl+D. This time the copies include a new mac-studio, and the new Planner and new Coder each have a `runs-in` edge to it, because those edges are inside the selection. Coder's edge to builder-a is still not copied.

## Idle sandboxes and triggers (AC4)

1. Click Resume and wait until mac-studio reads `leases 1/1` and Nightly sweep reads `×1`, then click Pause.
2. Click mac-studio, hold Shift (or Cmd on macOS) and click Nightly sweep. Press Cmd/Ctrl+C, then Cmd/Ctrl+V.
3. The new mac-studio reads `provisioning` and `leases 0/1`, and the Logs tab gains `provisioning mac-studio (local) on localhost`. The new Nightly sweep reads `×0`. The originals keep their lease and their fired count. The Events tab shows one `Pasted 2 nodes` event.

## Keys (constraints)

1. With a node selected, click into an inspector text field and press Cmd/Ctrl+C, Cmd/Ctrl+V and Cmd/Ctrl+D. The field keeps its native copy and paste, and no node is created.
2. With a node selected, open the Events tab, select some event text with the mouse and press Cmd/Ctrl+C. The text goes to the system clipboard; a following Cmd/Ctrl+V on the canvas pastes whatever was copied from the canvas before.
3. With nothing selected, press Cmd/Ctrl+D. Nothing is created and the browser's bookmark dialog does not open.
4. Switch to the Agents view and press Cmd/Ctrl+V. Nothing is pasted, because the keys are bound only while the canvas is mounted. Cmd/Ctrl+Z still undoes there.

## Evidence

- Clipboard scenarios (configuration copied, new ids, 40 and 80 px offsets, internal edges only, no-op copy and paste, idle sandbox and trigger, paste after delete, one-step undo and redo under the same ids for paste and duplicate) and the `api.graph.paste` boundary rule: `tests/clipboard.test.ts` via `npm test`.
- Key matching for Cmd/Ctrl+C, V and D, Shift, the text entry guard and the key position fallback: `tests/shortcuts.test.ts` via `npm test`.

## Verification

1. `npm ci`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `npm run dev`
