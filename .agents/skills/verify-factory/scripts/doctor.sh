#!/usr/bin/env bash
# Read-only check that this run's Factory instance is the one worth driving.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "usage: doctor.sh STATE_FILE" >&2
  exit 2
fi
. "$1"

# Return the pid that owns the LISTEN socket on a loopback port, or exit
# nonzero. lsof is the macOS tool; on Linux sartre has no lsof, so fall back to
# ss (iproute2) and read the owning pid from its process column.
port_owner_pid() {
  local port="$1" out=""
  if command -v lsof >/dev/null 2>&1; then
    out="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
    [[ -n "$out" ]] && { printf '%s\n' "$out"; return 0; }
    return 1
  fi
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -ltnpH "sport = :$port" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n 1 || true)"
    [[ -n "$out" ]] && { printf '%s\n' "$out"; return 0; }
    return 1
  fi
  return 1
}

if ! kill -0 "$FACTORY_SERVER_PID" 2>/dev/null; then
  echo "server pid $FACTORY_SERVER_PID is not running" >&2
  exit 1
fi

listener="$(port_owner_pid "$FACTORY_PORT" || true)"
if [[ "$listener" != "$FACTORY_SERVER_PID" ]]; then
  echo "port $FACTORY_PORT is owned by pid '${listener:-none}', expected $FACTORY_SERVER_PID" >&2
  exit 1
fi

if [[ -n "${FACTORY_WORLD_PID:-}" ]] && ! kill -0 "$FACTORY_WORLD_PID" 2>/dev/null; then
  echo "world pid $FACTORY_WORLD_PID is not running" >&2
  exit 1
fi

if [[ -n "${FACTORY_WORLD_PORT:-}" ]]; then
  world_listener="$(port_owner_pid "$FACTORY_WORLD_PORT" || true)"
  if [[ "$world_listener" != "$FACTORY_WORLD_PID" ]]; then
    echo "port $FACTORY_WORLD_PORT is owned by pid '${world_listener:-none}', expected $FACTORY_WORLD_PID" >&2
    exit 1
  fi
fi

if ! curl --fail --silent --show-error "$FACTORY_ORIGIN/" | grep -q '<title>Factory</title>'; then
  echo "$FACTORY_ORIGIN did not serve the Factory page" >&2
  exit 1
fi

# Empty until the run opens its browser session.
browser_url=""
if "${AGENT_BROWSER:-agent-browser}" session list 2>/dev/null | grep -qF "$AGENT_BROWSER_SESSION"; then
  browser_url="$("${AGENT_BROWSER:-agent-browser}" get url 2>/dev/null || true)"
fi
if [[ -n "$browser_url" && "$browser_url" != "$FACTORY_ORIGIN"/* ]]; then
  echo "browser session $AGENT_BROWSER_SESSION is at $browser_url, expected $FACTORY_ORIGIN" >&2
  exit 1
fi

printf 'run_id=%s\n' "$FACTORY_RUN_ID"
printf 'head_sha=%s\n' "$FACTORY_HEAD_SHA"
printf 'server_pid=%s\n' "$FACTORY_SERVER_PID"
printf 'port=%s\n' "$FACTORY_PORT"
printf 'port_owner=%s\n' "$listener"
printf 'title=Factory\n'
printf 'browser_session=%s\n' "$AGENT_BROWSER_SESSION"
printf 'browser_url=%s\n' "${browser_url:-not open}"
