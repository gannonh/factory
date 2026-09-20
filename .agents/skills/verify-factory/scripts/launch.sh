#!/usr/bin/env bash
# Starts one isolated Factory dev server for a verification run and prints the
# path of the run's state file. Everything the run writes lives in one evidence
# directory under uat-evidence/, which is gitignored.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
vite_bin="$repo_root/node_modules/vite/bin/vite.js"
if [[ ! -f "$vite_bin" ]]; then
  echo "node_modules is missing; run npm ci in $repo_root first" >&2
  exit 1
fi

port="$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
evidence_dir="$repo_root/uat-evidence/verify-factory/$run_id"
mkdir -p "$evidence_dir"

# `npm run dev` is `vite`. Running the same binary with node makes the recorded
# PID the server itself, so cleanup can stop exactly this process.
cd "$repo_root"
nohup node "$vite_bin" --host 127.0.0.1 --port "$port" --strictPort \
  > "$evidence_dir/server.log" 2>&1 < /dev/null &
server_pid=$!
disown "$server_pid"

state_file="$evidence_dir/state.env"
{
  printf 'export FACTORY_STATE_FILE=%q\n' "$state_file"
  printf 'export FACTORY_REPO_ROOT=%q\n' "$repo_root"
  printf 'export FACTORY_RUN_ID=%q\n' "$run_id"
  printf 'export FACTORY_HEAD_SHA=%q\n' "$(git rev-parse HEAD)"
  printf 'export FACTORY_PORT=%q\n' "$port"
  printf 'export FACTORY_ORIGIN=%q\n' "http://127.0.0.1:$port"
  printf 'export FACTORY_SERVER_PID=%q\n' "$server_pid"
  printf 'export FACTORY_EVIDENCE_DIR=%q\n' "$evidence_dir"
  printf 'export AGENT_BROWSER_SESSION=%q\n' "verify-factory-$run_id"
} > "$state_file"

for _ in $(seq 1 60); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "vite exited during startup; see $evidence_dir/server.log" >&2
    exit 1
  fi
  if curl --fail --silent "http://127.0.0.1:$port/" | grep -q '<title>Factory</title>'; then
    printf '%s\n' "$state_file"
    exit 0
  fi
  sleep 0.5
done

echo "vite did not serve Factory on port $port within 30 seconds; run cleanup.sh $state_file" >&2
exit 1
