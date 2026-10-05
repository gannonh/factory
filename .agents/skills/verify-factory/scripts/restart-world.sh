#!/usr/bin/env bash
# Restarts this run's factory world process only: stops the recorded world pid
# and starts a fresh one on the same world port and data dir, then rewrites
# FACTORY_WORLD_PID (and FACTORY_WORLD_PORT) in the state file so cleanup.sh
# stops the new process. Vite keeps serving; its proxy targets the world port,
# which is why the port must not change.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "usage: restart-world.sh STATE_FILE" >&2
  exit 2
fi
state_file="$1"
. "$state_file"

if [[ -z "${FACTORY_WORLD_PORT:-}" ]]; then
  echo "state file has no FACTORY_WORLD_PORT" >&2
  exit 1
fi

# Stop the old world process only after confirming it is this checkout's server.
if [[ -n "${FACTORY_WORLD_PID:-}" ]] && kill -0 "$FACTORY_WORLD_PID" 2>/dev/null; then
  world_line="$(ps -o command= -p "$FACTORY_WORLD_PID")"
  if [[ "$world_line" != *"server/main.ts"* ]]; then
    echo "pid $FACTORY_WORLD_PID is not this run's factory server: $world_line" >&2
    exit 1
  fi
  kill "$FACTORY_WORLD_PID"
  for _ in $(seq 1 20); do
    kill -0 "$FACTORY_WORLD_PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$FACTORY_WORLD_PID" 2>/dev/null; then
    echo "pid $FACTORY_WORLD_PID did not exit after SIGTERM" >&2
    exit 1
  fi
fi

# Until the state-file rewrite below lands, the replacement world is not yet
# recorded, so cleanup.sh cannot stop it. If the script exits or is interrupted
# before that rewrite, terminate the replacement so it cannot orphan the run's
# port and data directory. The trap is disarmed only after the rewrite succeeds.
new_world_pid=""
stop_new_world() {
  local status=$?
  if [[ -n "$new_world_pid" ]] && kill -0 "$new_world_pid" 2>/dev/null; then
    local world_line
    world_line="$(ps -o command= -p "$new_world_pid" 2>/dev/null || true)"
    if [[ "$world_line" == *"server/main.ts"* ]]; then
      kill "$new_world_pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$new_world_pid" 2>/dev/null || break
        sleep 0.25
      done
      if kill -0 "$new_world_pid" 2>/dev/null; then
        kill -9 "$new_world_pid" 2>/dev/null || true
      fi
    fi
  fi
  exit "$status"
}

cd "$FACTORY_REPO_ROOT"
FACTORY_PORT="$FACTORY_WORLD_PORT" \
FACTORY_ORIGIN="$FACTORY_ORIGIN" \
FACTORY_DATA_DIR="$FACTORY_DATA_DIR" \
  nohup node --import tsx server/main.ts \
  > "$FACTORY_EVIDENCE_DIR/world-restart.log" 2>&1 < /dev/null &
new_world_pid=$!
disown "$new_world_pid"

trap stop_new_world EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if ! kill -0 "$new_world_pid" 2>/dev/null; then
    echo "factory server exited during restart; see $FACTORY_EVIDENCE_DIR/world-restart.log" >&2
    exit 1
  fi
  if curl --fail --silent --max-time 2 --output /dev/null "http://127.0.0.1:$FACTORY_WORLD_PORT/health"; then
    break
  fi
  sleep 0.5
done
if ! curl --fail --silent --max-time 2 --output /dev/null "http://127.0.0.1:$FACTORY_WORLD_PORT/health"; then
  echo "factory server did not serve /health on $FACTORY_WORLD_PORT within 30 seconds" >&2
  exit 1
fi

# Rewrite the world pid and port in the state file so the next sourcing (and
# cleanup.sh) sees the new process. The port is unchanged, but write it too so
# the file records the current process.
tmp="$(mktemp "${state_file}.XXXXXX")"
while IFS= read -r line; do
  case "$line" in
    'export FACTORY_WORLD_PID='*) line="export FACTORY_WORLD_PID=${new_world_pid}" ;;
    'export FACTORY_WORLD_PORT='*) line="export FACTORY_WORLD_PORT=${FACTORY_WORLD_PORT}" ;;
  esac
  printf '%s\n' "$line"
done < "$state_file" > "$tmp"
mv "$tmp" "$state_file"

# The rewrite landed: the new pid is recorded and owned by cleanup.sh from here,
# so the trap must not kill it.
trap - EXIT INT TERM HUP

printf 'restarted_world_pid=%s\n' "$new_world_pid"
printf 'world_port=%s\n' "$FACTORY_WORLD_PORT"
printf 'data_dir=%s\n' "$FACTORY_DATA_DIR"
