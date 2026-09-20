#!/usr/bin/env bash
# Stops only what this run started: its agent-browser session and its Vite
# server. Leaves the evidence directory and any posted PR comment intact.
# Safe to run again after a partial cleanup.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "usage: cleanup.sh STATE_FILE" >&2
  exit 2
fi
. "$1"

# The session's browser profile is temporary, so closing it discards this
# origin's factory.world.v3 along with the rest of the profile.
if agent-browser session list 2>/dev/null | grep -qF "$AGENT_BROWSER_SESSION"; then
  agent-browser record stop >/dev/null 2>&1 || true
  agent-browser close >/dev/null
  browser="closed $AGENT_BROWSER_SESSION"
else
  browser="no open session $AGENT_BROWSER_SESSION"
fi

if kill -0 "$FACTORY_SERVER_PID" 2>/dev/null; then
  command_line="$(ps -o command= -p "$FACTORY_SERVER_PID")"
  if [[ "$command_line" != *"$FACTORY_REPO_ROOT/node_modules/vite/bin/vite.js"*"--port $FACTORY_PORT"* ]]; then
    echo "pid $FACTORY_SERVER_PID is not this run's Vite server: $command_line" >&2
    exit 1
  fi
  kill "$FACTORY_SERVER_PID"
  for _ in $(seq 1 20); do
    kill -0 "$FACTORY_SERVER_PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$FACTORY_SERVER_PID" 2>/dev/null; then
    echo "pid $FACTORY_SERVER_PID did not exit after SIGTERM" >&2
    exit 1
  fi
  server="stopped pid $FACTORY_SERVER_PID"
else
  server="pid $FACTORY_SERVER_PID already stopped"
fi

if curl --fail --silent --max-time 2 "$FACTORY_ORIGIN/" >/dev/null; then
  echo "$FACTORY_ORIGIN still answers after cleanup" >&2
  exit 1
fi

{
  printf 'browser=%s\n' "$browser"
  printf 'server=%s\n' "$server"
  printf 'origin_unreachable=%s\n' "$FACTORY_ORIGIN"
  printf 'retained_evidence=%s\n' "$FACTORY_EVIDENCE_DIR"
} | tee "$FACTORY_EVIDENCE_DIR/cleanup.txt"
ls -1 "$FACTORY_EVIDENCE_DIR"
