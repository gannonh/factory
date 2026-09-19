---
name: verify-factory
description: Verify Factory's Vite React web UI through the Kata Code collaborative preview when changing simulation controls, agents, sandboxes, task flows, or the operational dock.
---

# Verify Factory

Factory is a browser-only React app backed by an in-page mock server. The app needs no credentials or external services. Each verification run uses a new Vite port, which gives it a separate localStorage origin for `factory.world.v3`.

Read [features/README.md](features/README.md) before choosing a recipe.

## Launch

Run all shell commands from the repository root. Install the lockfile-defined dependencies with `npm ci` if `node_modules` is absent.

Prepare a free port, a temporary runtime directory, a unique evidence directory, and a preview-reachable origin:

```bash
FACTORY_STATE_FILE="$(.agents/skills/verify-factory/scripts/prepare.sh)"
. "$FACTORY_STATE_FILE"
echo "FACTORY_STATE_FILE=$FACTORY_STATE_FILE"
echo "FACTORY_PORT=$FACTORY_PORT"
echo "FACTORY_BROWSER_ORIGIN=$FACTORY_BROWSER_ORIGIN"
echo "FACTORY_EVIDENCE_DIR=$FACTORY_EVIDENCE_DIR"
npm run dev -- --host 0.0.0.0 --port "$FACTORY_PORT" --strictPort
```

Run that command in a PTY-backed shell tool call with a short yield. Keep it in the foreground. Record the returned numeric shell `session_id` as `FACTORY_SERVER_SESSION`; this is the only process handle cleanup may stop. Vite is ready when the same session prints `ready` and lists the selected port.

The helper writes shell-quoted values to `FACTORY_STATE_FILE`. Source that file in later shell calls. The runtime directory is under `/tmp`; proof stays under `uat-evidence/verify-factory/<run-id>/`.

## Doctor

Doctor is read-only. Run it before driving the page and whenever preview behavior looks wrong.

1. Poll `FACTORY_SERVER_SESSION` with an empty shell-session write. Require the session to remain live.
2. Run the following command with the state path printed during launch:

   ```bash
   .agents/skills/verify-factory/scripts/doctor.sh "$FACTORY_STATE_FILE" | tee "$FACTORY_EVIDENCE_DIR/doctor.txt"
   ```

   It requires the selected port to have a listener, fetches that exact port through loopback, and requires the HTML title `Factory`.
3. Call Kata Code `preview_status` for the run's tab. After navigation, use `preview_evaluate` with this read-only expression:

   ```js
   ({ title: document.title, origin: location.origin, port: location.port })
   ```

   Require `title` to equal `Factory`, `origin` to equal `FACTORY_BROWSER_ORIGIN`, and `port` to equal `FACTORY_PORT`.

Do not drive a tab whose origin or port differs from the state file.

## Drive

Use the Kata Code collaborative preview tools. Do not install Playwright or Cypress, use coordinates, call application APIs, import the store, or write localStorage directly.

1. Call `preview_status`. If it has no tab, call `preview_open` with a blank tab.
2. Call `preview_navigate` with `url` set to `FACTORY_BROWSER_ORIGIN`, `readiness` set to `domContentLoaded`, and a 60-second timeout. In this environment, the `environment-port` target fails before navigation; Vite's `tailscale0` address is the verified route into the same isolated server.
3. Call `preview_wait_for` with visible text `Factory`.
4. Call `preview_snapshot` and inspect its semantic elements before each interaction. Use role and accessible-name locators such as `role=button[name='Pause']`, `role=button[name='Agents']`, and `role=button[name='Sandboxes']`.
5. Use `preview_click`, `preview_type`, and `preview_press` with those locators. Re-snapshot after each state change.

If a preview call returns `PreviewAutomationClientDisconnectedError` or says no automation host is available, call `preview_open` with the same tab ID and `reuseExistingTab: true`. Verify the tab still has `FACTORY_BROWSER_ORIGIN`, then retry the failed read-only wait or snapshot. Do not repeat a mutation whose preceding click already succeeded.

For the baseline pause proof:

1. Snapshot the starting page with `save: true`. The `Pause` button must be visible.
2. Click `role=button[name='Pause']`.
3. Wait for visible text `Resume`, then snapshot with `save: true`.
4. Read the persisted state with `preview_evaluate`:

   ```js
   (() => {
     const raw = localStorage.getItem('factory.world.v3')
     if (raw === null) return { key: 'factory.world.v3', present: false, paused: null }
     const value = JSON.parse(raw)
     return { key: 'factory.world.v3', present: true, paused: value.sim?.paused ?? null, speed: value.sim?.speed ?? null }
   })()
   ```

   This expression only reads the production persistence boundary. If `present` is false or `paused` is not true, evaluate it again until the one-second persistence throttle has elapsed. Do not change state through `preview_evaluate` during a proof.

## Evidence

Keep proof under `FACTORY_EVIDENCE_DIR`. Copy each saved snapshot from the path returned by `preview_snapshot`:

- `pause-before.png` shows Factory and the enabled `Pause` action.
- `pause-after.png` shows the same origin and the resulting `Resume` action.
- `storage.json` contains the exact read-only `preview_evaluate` result with `present: true` and `paused: true`.
- `doctor.txt` contains the port, listener, HTTP status, and Factory title.
- `cleanup.txt` records the stopped server, cleared storage key, removed runtime directory, and retained evidence path.

Write the feature ID, action, tab ID, origin, port, and server session ID to `proof.txt`. Keep the tool timeline or terminal transcript that contains the click between the two screenshots.

A valid proof exercises the user-facing control and captures both the action state and the result. It also checks the persisted side effect through localStorage. Internal setters and test-only endpoints do not count. Mocks are acceptable only at Factory's existing in-browser mock-server boundary.

## Cleanup

Cleanup acts only on the tab origin, shell session, and temporary directory created by this run. It must leave `FACTORY_EVIDENCE_DIR` intact.

1. While the tab is still at `FACTORY_BROWSER_ORIGIN`, call `preview_evaluate`:

   ```js
   (() => {
     const key = 'factory.world.v3'
     const existed = localStorage.getItem(key) !== null
     localStorage.removeItem(key)
     return { origin: location.origin, key, existed, cleared: localStorage.getItem(key) === null }
   })()
   ```

   Require the returned origin to match the state file and `cleared` to be true. This removes only Factory's key from this run's unique origin.
2. Send Ctrl-C only to `FACTORY_SERVER_SESSION` with the shell-session write tool. Poll the same session until it exits. Never kill by process name or port.
3. Confirm `curl --fail --silent "http://127.0.0.1:$FACTORY_PORT/"` now fails. Record that result in `cleanup.txt`.
4. Remove only this run's temporary directory:

   ```bash
   .agents/skills/verify-factory/scripts/cleanup-runtime.sh "$FACTORY_STATE_FILE"
   ```

5. Confirm every evidence file still exists after the runtime directory is gone.

Run cleanup after every failed attempt before starting another origin.

## Helpers

The skill ships three executable helpers:

- `scripts/prepare.sh` allocates a free loopback port, creates the evidence and temporary runtime directories, discovers the `tailscale0` address used by Kata Code preview, and prints the generated state-file path.
- `scripts/doctor.sh <state-file>` performs the read-only port and page check. It exits nonzero for a missing listener, an HTTP failure, or the wrong title.
- `scripts/cleanup-runtime.sh <state-file>` validates that the runtime path belongs to this skill and removes only that directory. It does not stop processes or remove evidence.

Use the helpers through the exact commands above. Do not inspect their internals as a substitute for running them.
