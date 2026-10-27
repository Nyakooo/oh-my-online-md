#!/usr/bin/env bash
# Mock Docker/curl so deployment failure tests never touch real containers.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_tmp=$(mktemp -d)
trap 'rm -rf -- "$task_tmp"' EXIT
mkdir -p "$task_tmp/bin" "$task_tmp/deployment with spaces"
touch "$task_tmp/deployment with spaces/compose.yaml"
export MOCK_LOG="$task_tmp/commands.log"
cat > "$task_tmp/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_LOG"
if [[ $1 == compose ]]; then
  shift 5
  case "$1" in
    config|pull|up) [[ ${MOCK_FAIL:-} != "$1" ]] ;;
    ps) if [[ $* == *--quiet* ]]; then echo container-id; fi ;;
    logs) echo 'mock diagnostic logs' ;;
  esac
elif [[ $1 == inspect ]]; then
  if [[ ${MOCK_FAIL:-} == container ]]; then echo 'exited false none'; else echo 'running false none'; fi
elif [[ $1 == image ]]; then
  [[ ${MOCK_FAIL:-} != prune ]]
fi
MOCK
cat > "$task_tmp/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "http-check $*" >> "$MOCK_LOG"
if [[ ${MOCK_FAIL:-} == http ]]; then exit 7; fi
printf '200'
MOCK
chmod +x "$task_tmp/bin/"*
export PATH="$task_tmp/bin:$PATH"
run_deploy() {
  : > "$MOCK_LOG"
  (cd /; DEPLOY_TIMEOUT=1 bash "$repo_dir/deploy.sh" --dir "$task_tmp/deployment with spaces" "$@") > "$task_tmp/output" 2>&1
}
assert_absent() { if grep -Fq -- "$1" "$MOCK_LOG"; then cat "$MOCK_LOG"; exit 1; fi; }
assert_present() { grep -Fq -- "$1" "$MOCK_LOG" || { cat "$MOCK_LOG"; exit 1; }; }
run_deploy
assert_present 'pull --policy always'
assert_present 'up -d --no-build --pull never --remove-orphans'
assert_present '--location --max-redirs 3'
assert_present 'image prune --force'
run_deploy --no-prune
assert_absent 'image prune'
for stage in config pull up container http prune; do
  export MOCK_FAIL=$stage
  if run_deploy; then echo "FAIL: $stage should fail"; exit 1; fi
  case "$stage" in
    config) assert_absent 'pull --policy'; assert_absent 'up -d' ;;
    pull) assert_absent 'up -d' ;;
    container|http) assert_present 'logs --no-color --tail 50 online-md'; grep -q 'mock diagnostic logs' "$task_tmp/output" ;;
  esac
  if [[ $stage != prune ]]; then assert_absent 'image prune'; fi
done
unset MOCK_FAIL
exec 8>"$task_tmp/deployment with spaces/.deploy.lock"
flock -n 8
if run_deploy; then echo 'FAIL: overlapping deploy should fail'; exit 1; fi
assert_absent 'pull --policy'
grep -q 'already running' "$task_tmp/output"
exec 8>&-
if run_deploy --invalid; then echo 'FAIL: unknown option should fail'; exit 1; fi
assert_absent 'pull --policy'
echo 'PASS: deployment success, no-prune, failures before replacement/cleanup, readiness diagnostics, lock, paths with spaces and unknown arguments'
