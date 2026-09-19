#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
port="$(node -e "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close()})")"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
tailscale_ip="$(ip -4 -o addr show dev tailscale0 2>/dev/null | awk 'NR == 1 { split($4, address, "/"); print address[1] }' || true)"

if [[ -z "$tailscale_ip" ]]; then
  echo "tailscale0 has no IPv4 address; Kata Code preview cannot reach the Vite server" >&2
  exit 1
fi

runtime_dir="$(mktemp -d "/tmp/verify-factory.${run_id}.XXXXXX")"
evidence_dir="$repo_root/uat-evidence/verify-factory/$run_id"
mkdir -p "$evidence_dir"
state_file="$runtime_dir/state.env"

{
  printf 'FACTORY_REPO_ROOT=%q\n' "$repo_root"
  printf 'FACTORY_PORT=%q\n' "$port"
  printf 'FACTORY_RUN_ID=%q\n' "$run_id"
  printf 'FACTORY_RUNTIME_DIR=%q\n' "$runtime_dir"
  printf 'FACTORY_EVIDENCE_DIR=%q\n' "$evidence_dir"
  printf 'FACTORY_BROWSER_ORIGIN=%q\n' "http://$tailscale_ip:$port"
} > "$state_file"

printf '%s\n' "$state_file"
