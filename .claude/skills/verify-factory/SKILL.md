---
name: verify-factory
description: Verify Factory's Vite React web UI by driving it with agent-browser, recording video and screenshots, and posting that evidence to the pull request. Use when changing simulation controls, the canvas, agents, sandboxes, task flows, or the operational dock.
---

# Verify Factory

Factory is a React page backed by a Node process on this machine. The page needs no credentials. Each verification run starts that process and a Vite server on a free loopback port, and uses a named `agent-browser` session with a temporary browser profile. The world is not stored in `localStorage`.

Read [features/README.md](features/README.md) before choosing a recipe.

Requirements: `node`, `agent-browser` 0.36 or later, `ffmpeg`, `lsof`, and an authenticated `gh`. The helpers are tested on macOS.

This skill lives at `.agents/skills/verify-factory/` and `.claude/skills/verify-factory/`. The two directories are identical. Edit one, copy it over the other with `rsync -a --delete`, and confirm with `diff -r` that they match.

## Launch

Run all shell commands from the repository root of the checkout under verification. Install the lockfile-defined dependencies with `npm ci` if `node_modules` is absent.

```bash
FACTORY_STATE_FILE="$(<skill-dir>/scripts/launch.sh)"
echo "$FACTORY_STATE_FILE"
```

`<skill-dir>` is the directory that holds this file, relative to the repository root.

`launch.sh` picks a free loopback port, starts Vite on `127.0.0.1` in the background, waits until the port serves the Factory page, and prints the path of the run's state file. The state file records the absolute path of the skill's `scripts/` directory as `FACTORY_SCRIPTS`, the server PID, port, origin, checked-out commit, evidence directory, and `agent-browser` session name. The evidence directory is `uat-evidence/verify-factory/<run-id>/`, which is gitignored.

Shell variables do not persist between tool calls. Start every later shell call with:

```bash
. <the state-file path printed by launch.sh>
```

Sourcing the file exports `AGENT_BROWSER_SESSION`, so every `agent-browser` command in that call uses this run's session.

## Doctor

Doctor is read-only. Run it before driving the page, after any failed drive, and whenever browser behavior looks wrong.

```bash
"$FACTORY_SCRIPTS/doctor.sh" "$FACTORY_STATE_FILE" | tee "$FACTORY_EVIDENCE_DIR/doctor.txt"
```

It requires the recorded PID to be alive, to own the recorded port, and to serve the HTML title `Factory`. If this run's browser session is open, it also requires the session URL to be under `FACTORY_ORIGIN`. It exits nonzero and names the failed check otherwise. Do not drive a session that fails doctor; run Cleanup and launch again.

## Drive

Use `agent-browser` only. Do not install Playwright or Cypress, use coordinates, call application APIs, import the store, or write localStorage.

1. Open the page and size the viewport. The default viewport leaves the top row of canvas nodes under the canvas toolbar, where clicks are refused.

   ```bash
   agent-browser open "$FACTORY_ORIGIN"
   agent-browser set viewport 1440 900
   agent-browser wait --text "Factory"
   ```

2. Read the page with `agent-browser snapshot -i` before each interaction. Refs such as `@e12` are valid only until the page changes.
3. Act by role and accessible name, by label, or by placeholder:

   ```bash
   agent-browser find role button click --name "Pause"
   agent-browser find role button click --name "Queue" --exact
   agent-browser find label "Name" fill "vf-box"
   agent-browser find placeholder "Task title" fill "vf-task"
   ```

   `--name` matches a substring. Add `--exact` when another control contains the same text. When a name carries live text, such as a dock tab count or a canvas node's model and load, take the ref from the snapshot line that starts with the name.
4. Wait on the result with `agent-browser wait --text "..."`, then snapshot again.
5. Read browser storage only to prove the page did not write the world. The Pause button is the simulation state.

   ```bash
   cat <<'EOF' | agent-browser eval --stdin | tee "$FACTORY_EVIDENCE_DIR/sim-pause-storage.json"
   (() => ({ key: 'factory.world.v3', present: localStorage.getItem('factory.world.v3') !== null }))()
   EOF
   ```

   `present` is false. Pause and resume are visible on the top bar.

The snapshot shows text after CSS transforms. Column headers, section headings, form labels, and log level buttons appear in uppercase (`AGENT`, `COMPOSE TASK`, `NAME`, `DEBUG`) although the source text is lower or title case. `find` matches names without regard to case.

## Evidence

Every proof records a video of the action, a screenshot before and after it, and a read-only check. Name the files after the sub-feature ID from the feature map.

The baseline proof is `sim-pause`:

```bash
agent-browser record start "$FACTORY_EVIDENCE_DIR/sim-pause.webm"
agent-browser wait --text "Pause"
agent-browser wait 800
agent-browser screenshot "$FACTORY_EVIDENCE_DIR/sim-pause-before.png"
agent-browser find role button click --name "Pause"
agent-browser wait --text "Resume"
agent-browser wait 1200
agent-browser screenshot "$FACTORY_EVIDENCE_DIR/sim-pause-after.png"
# run the storage expression from Drive here; require present: false. The button reads Resume.
agent-browser record stop
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

## Helpers

The skill ships four executable helpers in `scripts/`:

- `launch.sh` starts the isolated server and prints the state-file path. It exits nonzero if `node_modules` is missing or Vite does not serve Factory within 30 seconds.
- `doctor.sh <state-file>` performs the read-only PID, port, page, and session check.
- `post-evidence.sh <state-file> <pr-number>` publishes the run's evidence as one PR comment. It exits nonzero when the evidence directory lacks a `.webm` or a `.png`, or when a GIF exceeds 10 MB.
- `cleanup.sh <state-file>` stops the run's session and server and keeps the evidence.

Use the helpers through the exact commands above. Do not inspect their internals as a substitute for running them.
