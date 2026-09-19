#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: cleanup-runtime.sh STATE_FILE" >&2
  exit 2
fi

state_file="$1"
if [[ ! -f "$state_file" ]]; then
  echo "state file does not exist: $state_file" >&2
  exit 2
fi

. "$state_file"

case "$FACTORY_RUNTIME_DIR" in
  /tmp/verify-factory.*) ;;
  *)
    echo "refusing to remove unexpected runtime path: $FACTORY_RUNTIME_DIR" >&2
    exit 2
    ;;
esac

if [[ "$FACTORY_EVIDENCE_DIR" != "$FACTORY_REPO_ROOT"/uat-evidence/verify-factory/* ]]; then
  echo "refusing cleanup with unexpected evidence path: $FACTORY_EVIDENCE_DIR" >&2
  exit 2
fi

rm -r -- "$FACTORY_RUNTIME_DIR"
printf 'removed_runtime=%s\n' "$FACTORY_RUNTIME_DIR"
printf 'retained_evidence=%s\n' "$FACTORY_EVIDENCE_DIR"
