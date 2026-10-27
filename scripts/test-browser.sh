#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if curl --silent --max-time 1 --output /dev/null http://127.0.0.1:10778/; then
  echo 'Port 10778 is in use. Stop that service before running browser tests.' >&2
  exit 1
fi

task_tmp=$(mktemp -d)
task_server_pid=''
stop_server() {
  if [[ -n "$task_server_pid" ]]; then
    kill "$task_server_pid" 2>/dev/null || true
    wait "$task_server_pid" 2>/dev/null || true
    task_server_pid=''
  fi
}
cleanup() { stop_server; rm -rf -- "$task_tmp"; }
trap cleanup EXIT

go build -o "$task_tmp/online-md" .
start_server() {
  local task_data_dir="$1"
  local task_password="$2"
  mkdir -p "$task_data_dir"
  DATA_DIR="$task_data_dir" PORT=10778 PASSWORD="$task_password" "$task_tmp/online-md" >"$task_tmp/server.log" 2>&1 &
  task_server_pid=$!
  for attempt in {1..60}; do
    if curl -fs --output /dev/null http://127.0.0.1:10778/login; then return; fi
    sleep 0.2
  done
  cat "$task_tmp/server.log" >&2
  return 1
}
export TEST_URL=http://127.0.0.1:10778
start_server "$task_tmp/editor" ''
node tests/loading.cjs
TEST_DATA_DIR="$task_tmp/editor" node tests/editor.cjs
node tests/save-state.cjs
node tests/search.cjs
stop_server
start_server "$task_tmp/share" test-password
TEST_DATA_DIR="$task_tmp/share" node tests/share.cjs
