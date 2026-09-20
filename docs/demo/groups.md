# Demonstrating group, name, move, and ungroup (KAT-3409)

The canvas groups a selection of two or more ungrouped nodes. The group is a name plus membership on those nodes. Member positions stay absolute in the world. The canvas draws a frame from the members' bounding boxes. The Group toolbar button is enabled when two or more non-frame nodes are selected and none already belongs to a group. Ungroup is enabled when the selection is exactly one group, either the frame or its members. After Group, the new group is selected and its inspector opens. Rename goes through the inspector name field and coalesces keystrokes into one undo step. Dragging the frame header moves every member. Dragging a member outside the frame resizes the frame on drop. Copy, paste and duplicate of grouped members create ungrouped copies. Nested groups, auto-layout of groups, and copying a group as a group are out of scope. The checked-in suites under `npm test` cover the API, history, persistence and paste contract; this page records the browser walkthrough.

## Base fixture

1. Run `npm run dev` and open http://localhost:5173.
2. Click Reset in the top bar, then Pause. Click Fit in the canvas toolbar if the graph sits under the toolbar. Undo and Redo are disabled. Group and Ungroup are disabled.

Each section below starts from this fixture. The seeded graph has four agents, three sandboxes and two triggers, all ungrouped.

## Group a selection (AC1, AC5)

1. Drag a marquee from empty canvas across Planner and Coder so both are selected. Group becomes enabled. Ungroup stays disabled.
2. Click Group. A frame named Group 1 appears around Planner and Coder. The frame is selected, the inspector title reads Group, and the name field reads Group 1. Undo becomes enabled. After the one-second throttled save, `JSON.parse(localStorage.getItem('factory.world.v3')).groups` holds that id with name Group 1, and both agents have that `groupId`. Planner and Coder keep the positions they had before the group.
3. Select QA and Reviewer and click Group. A second frame named Group 2 appears. Group 1 is unchanged.
4. Select Planner (inside Group 1) and QA (inside Group 2). Group stays disabled because both already belong to a group. Select only Planner. Group stays disabled because one node is not enough.

## Name (AC2)

1. Click the Group 1 header so the inspector shows Group.
2. Replace the name with `Crew`. The frame header reads Crew.
3. Click the canvas background, then press Cmd/Ctrl+Z. The name returns to Group 1 in one step. Shift+Cmd/Ctrl+Z restores Crew.
4. In the inspector member list, click Coder. The inspector switches to the Coder agent.

## Move as one (AC3, AC5)

1. Click Reset, Pause, Fit. Marquee Planner and Coder and click Group.
2. Drag the Group 1 header to a new spot and drop. Planner and Coder move with the frame. One Cmd/Ctrl+Z returns every member to its previous position. Shift+Cmd/Ctrl+Z moves them again.
3. Drag Coder by its own body outside the frame and drop. Coder's position updates and the frame grows to include it. Cmd/Ctrl+Z restores Coder's previous position and the previous frame size.

## Ungroup (AC4, AC5)

1. Click Reset, Pause, Fit. Marquee Planner and Coder and click Group. Rename it to Crew.
2. With the frame selected, Ungroup is enabled. Click Ungroup. The frame disappears. Planner and Coder stay where they were, now ungrouped. The inspector closes. After the save, those agents have `groupId` null and `groups` no longer lists Crew.
3. Press Cmd/Ctrl+Z. The Crew frame returns under the same group id, with Planner and Coder as members. Shift+Cmd/Ctrl+Z ungroups again.
4. Group Planner and Coder again. Select Planner (not the frame). Ungroup is enabled. Click Ungroup. Both members ungroup.

## Reload, delete, paste (AC6)

1. Click Reset, Pause, Fit. Marquee Planner and Coder, click Group, rename to Crew, wait one second, and reload. Crew is still there with both members. Undo and Redo are disabled.
2. Delete Coder. Crew still frames Planner. Cmd/Ctrl+Z restores Coder inside Crew.
3. Delete Planner and Coder together. The frame disappears. Cmd/Ctrl+Z restores both members and the name Crew.
4. Marquee Planner and Coder (grouped) and press Cmd/Ctrl+D. The copies are ungrouped, with `groupId` null. The originals stay in Crew.

## Evidence

- Group, ungroup, undo and redo under stable ids, rename coalesce, delete then undo, reload, empty-group save omission, and a save without `groups` seeding a fresh world: `tests/groups.test.ts` via `npm test`.
- Paste and duplicate of grouped members with `groupId` null: `tests/clipboard.test.ts` via `npm test`.

## Verification

1. `npm ci`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `npm run dev`
