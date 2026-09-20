#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: doctor.sh STATE_FILE" >&2
  exit 2
fi

state_file="$1"
if [[ ! -f "$state_file" ]]; then
  echo "state file does not exist: $state_file" >&2
  exit 2
fi

. "$state_file"

listener="$(ss -H -ltn "sport = :$FACTORY_PORT")"
if [[ -z "$listener" ]]; then
  echo "no listener on verification port $FACTORY_PORT" >&2
  exit 1
fi

page="$(curl --fail --silent --show-error "http://127.0.0.1:$FACTORY_PORT/")"
if [[ "$page" != *'<title>Factory</title>'* ]]; then
  echo "port $FACTORY_PORT did not serve the Factory page" >&2
  exit 1
fi

printf 'port=%s\n' "$FACTORY_PORT"
printf 'listener=%s\n' "$listener"
printf 'http_status=200\n'
printf 'title=Factory\n'
printf 'browser_origin=%s\n' "$FACTORY_BROWSER_ORIGIN"
