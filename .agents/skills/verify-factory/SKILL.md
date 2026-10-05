---
name: verify-factory
description: Verify Factory's Vite React web UI by driving it with agent-browser, recording video and screenshots, and posting that evidence to the pull request. Use when changing simulation controls, the canvas, agents, sandboxes, task flows, or the operational dock.
---

# Verify Factory

Factory is a React page backed by a Node process on this machine. The page needs no credentials. Each verification run starts that process and a Vite server on a free loopback port, and uses a named `agent-browser` session with a temporary browser profile. The world is not stored in `localStorage`.

Read [features/README.md](features/README.md) before choosing a recipe.

Requirements: `node`/`npx`, `agent-browser` 0.36 or later, `ffmpeg`, `curl`, `git`, and an authenticated `gh`. Port checks use `lsof` on macOS and `ss` (iproute2) on Linux. The helpers are tested on macOS and Linux. On Linux, install agent-browser so a real binary is on `PATH`: `npm i -g agent-browser && agent-browser install` (a global install under the node install's `bin` precedes any mise shim).

This skill lives at `.agents/skills/verify-factory/`. `.claude/skills` is a symlink to `.agents/skills`, so there is one copy. Keep its text and scripts free of harness-specific names and paths.

## Launch

Run all shell commands from the repository root of the checkout under verification. Install the lockfile-defined dependencies with `npm ci` if `node_modules` is absent.

```bash
FACTORY_STATE_FILE="$(<skill-dir>/scripts/launch.sh)"
echo "$FACTORY_STATE_FILE"
```

`<skill-dir>` is the directory that holds this file, relative to the repository root.

`launch.sh` picks a free loopback port, starts Vite on `127.0.0.1` in the background, waits until the port serves the Factory page, and prints the path of the run's state file. The state file records the absolute path of the skill's `scripts/` directory as `FACTORY_SCRIPTS`, the server PID, port, origin, checked-out commit, evidence directory, the resolved `agent-browser` binary as `AGENT_BROWSER`, and the `agent-browser` session name. The evidence directory is `uat-evidence/verify-factory/<run-id>/`, which is gitignored.

Shell variables do not persist between tool calls. Start every later shell call with:

```bash
. <the state-file path printed by launch.sh>
```

Sourcing the file exports `AGENT_BROWSER_SESSION`, so every drive command in that call uses this run's session, and `AGENT_BROWSER`, the resolved binary. Run drive commands as `"$AGENT_BROWSER"` so a broken mise shim on `PATH` never shadows the real binary.

## Doctor

Doctor is read-only. Run it before driving the page, after any failed drive, and whenever browser behavior looks wrong.

```bash
"$FACTORY_SCRIPTS/doctor.sh" "$FACTORY_STATE_FILE" | tee "$FACTORY_EVIDENCE_DIR/doctor.txt"
```

It requires the recorded PID to be alive, to own the recorded port, and to serve the HTML title `Factory`. If this run's browser session is open, it also requires the session URL to be under `FACTORY_ORIGIN`. It exits nonzero and names the failed check otherwise. Do not drive a session that fails doctor; run Cleanup and launch again.

## Drive

Use `agent-browser` only, invoked as `"$AGENT_BROWSER"`. Do not install Playwright or Cypress, use coordinates, call application APIs, import the store, or write localStorage.

1. Open the page and size the viewport. The default viewport leaves the top row of canvas nodes under the canvas toolbar, where clicks are refused.

   ```bash
   "$AGENT_BROWSER" open "$FACTORY_ORIGIN"
   "$AGENT_BROWSER" set viewport 1440 900
   "$AGENT_BROWSER" wait --text "Factory"
   ```

2. Read the page with `"$AGENT_BROWSER" snapshot -i` before each interaction. Refs such as `@e12` are valid only until the page changes.
3. Act by role and accessible name, by label, or by placeholder:

   ```bash
   "$AGENT_BROWSER" find role button click --name "Pause"
   "$AGENT_BROWSER" find role button click --name "Queue" --exact
   "$AGENT_BROWSER" find label "Name" fill "vf-box"
   "$AGENT_BROWSER" find placeholder "Task title" fill "vf-task"
   ```

   `--name` matches a substring. Add `--exact` when another control contains the same text. When a name carries live text, such as a dock tab count or a canvas node's model and load, take the ref from the snapshot line that starts with the name.
4. Wait on the result with `"$AGENT_BROWSER" wait --text "..."`, then snapshot again.
5. Read browser storage only to prove the page did not write the world. The Pause button is the simulation state.

   ```bash
   cat <<'EOF' | "$AGENT_BROWSER" eval --stdin | tee "$FACTORY_EVIDENCE_DIR/sim-pause-storage.json"
   (() => ({ key: 'factory.world.v3', present: localStorage.getItem('factory.world.v3') !== null }))()
   EOF
   ```

   `present` is false. Pause and resume are visible on the top bar.

The snapshot shows text after CSS transforms. Column headers, section headings, form labels, and log level buttons appear in uppercase (`AGENT`, `COMPOSE TASK`, `NAME`, `DEBUG`) although the source text is lower or title case. `find` matches names without regard to case.

## Evidence

Every proof records a video of the action, a screenshot before and after it, and a read-only check. Name the files after the sub-feature ID from the feature map.

The baseline proof is `sim-pause`:

```bash
"$AGENT_BROWSER" record start "$FACTORY_EVIDENCE_DIR/sim-pause.webm"
"$AGENT_BROWSER" wait --text "Pause"
"$AGENT_BROWSER" wait 800
"$AGENT_BROWSER" screenshot "$FACTORY_EVIDENCE_DIR/sim-pause-before.png"
"$AGENT_BROWSER" find role button click --name "Pause"
"$AGENT_BROWSER" wait --text "Resume"
"$AGENT_BROWSER" wait 1200
"$AGENT_BROWSER" screenshot "$FACTORY_EVIDENCE_DIR/sim-pause-after.png"
# run the storage expression from Drive here; require present: false. The button reads Resume.
"$AGENT_BROWSER" record stop
```

`record start` reopens the page in a fresh browser context. The view is Canvas and nothing is selected. The viewport size is kept. The world stays on the server, so a reload does not restore the seed. Start the recording first, then do the proof's setup, such as pausing or opening a workspace, inside the recording.

Keep each recording to the action under proof. Short waits before and after the click make the change visible to a viewer. Stop the recording before starting the next proof.

A valid proof exercises the user-facing control and captures both the action state and the result. Internal setters and test-only endpoints do not count.

Post the evidence to the pull request under verification:

```bash
"$FACTORY_SCRIPTS/post-evidence.sh" "$FACTORY_STATE_FILE" <pr-number>
```

`post-evidence.sh` converts each `.webm` to an MP4 and a GIF, pushes the screenshots, GIFs, and MP4s to the `verification-evidence` branch under `pr-<number>/<run-id>/`, and creates one PR comment. The comment renders each GIF and screenshot inline, links each MP4, and includes the `.json` and `.txt` transcripts. It states the commit the run verified and says when the PR head differs. The evidence branch shares no history with `main`, runs no workflow, and adds nothing to the PR diff or the working tree. Running the command again for the same run updates the same comment. It writes the comment URL and evidence commit to `posted.txt`.

GitHub embeds a video player only for files uploaded through its web editor, which has no API. The inline GIF is the recording a reviewer sees in the comment.

## Cleanup

```bash
"$FACTORY_SCRIPTS/cleanup.sh" "$FACTORY_STATE_FILE"
```

`cleanup.sh` closes this run's `agent-browser` session, which discards its temporary profile. It stops the recorded Vite PID only after confirming that PID is this checkout's Vite server on the recorded port, and the recorded world-server PID only after confirming it is this checkout's `server/main.ts` on the recorded world port. It confirms the page origin no longer answers, writes `cleanup.txt`, and lists the evidence directory. It never kills by process name alone, and it leaves the evidence directory and the posted comment intact. It is safe to run again.

Run cleanup after the last proof and after every failed attempt before launching again. Confirm the listed evidence files still exist.

## Restart the world

A persistence scenario must prove the world survives a world-server restart. Restart only the world process with `restart-world.sh`; Vite keeps serving and its proxy already targets the world port, so the port must not change:

```bash
"$FACTORY_SCRIPTS/restart-world.sh" "$FACTORY_STATE_FILE"
```

`restart-world.sh` stops the recorded world PID (only after confirming it is this checkout's `server/main.ts`), starts a fresh world server on the same `FACTORY_WORLD_PORT` and `FACTORY_DATA_DIR`, waits for `/health`, and rewrites `FACTORY_WORLD_PID` (and `FACTORY_WORLD_PORT`) in the state file. Re-source the state file before the next shell call so `cleanup.sh` stops the new PID. Drive the page again to prove the reloaded world still shows the state the recipe saved. If the restart fails or is interrupted before the rewrite lands, it terminates the freshly spawned world process so no orphan holds the port or data directory, and leaves the state file naming the old PID.

## Helpers

The skill ships five executable helpers in `scripts/`:

- `launch.sh` starts the isolated server and prints the state-file path. It exits nonzero if `node_modules` is missing, if no working `agent-browser` binary is found, or if Vite does not serve Factory within 30 seconds.
- `doctor.sh <state-file>` performs the read-only PID, port, page, and session check.
- `restart-world.sh <state-file>` restarts the world server on the same data dir and records the new PID in the state file.
- `post-evidence.sh <state-file> <pr-number>` publishes the run's evidence as one PR comment. It exits nonzero when the evidence directory lacks a `.webm` or a `.png`, or when a GIF exceeds 10 MB.
- `cleanup.sh <state-file>` stops the run's session and server and keeps the evidence.

Use the helpers through the exact commands above. Do not inspect their internals as a substitute for running them.
