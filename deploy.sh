#!/usr/bin/env bash
# Update a server deployment using published images; never build from source.
set -Eeuo pipefail

deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prune=true
health_url=${HEALTH_URL:-http://127.0.0.1:10777/login}
deploy_timeout=${DEPLOY_TIMEOUT:-60}

usage() {
  cat <<'HELP'
Usage: bash deploy.sh [--dir DIRECTORY] [--no-prune]

  --dir DIRECTORY  Directory containing compose.yaml and .env (default: repository root)
  --no-prune       Keep dangling images after a successful deployment
  -h, --help      Show this help

Environment:
  HEALTH_URL       Local readiness URL (default: http://127.0.0.1:10777/login)
  DEPLOY_TIMEOUT   Readiness timeout in seconds (default: 60)

Requires Bash, Docker Compose v2, curl and flock. Reads Compose's normal .env
configuration. Cleanup removes host-wide dangling images only, never volumes.
HELP
}
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --dir) [[ $# -ge 2 && -n $2 ]] || fail '--dir requires a directory'; deploy_dir=$2; shift 2 ;;
    --no-prune) prune=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown argument: $1" ;;
  esac
done
[[ $deploy_timeout =~ ^[1-9][0-9]{0,4}$ ]] || fail 'DEPLOY_TIMEOUT must be an integer between 1 and 99999'
for dependency in docker curl flock; do
  command -v "$dependency" >/dev/null || fail "Missing dependency: $dependency"
done
[[ -d $deploy_dir ]] || fail "Deployment directory does not exist: $deploy_dir"
cd -- "$deploy_dir"
[[ -f compose.yaml ]] || fail 'compose.yaml was not found in the deployment directory'

# Keep the lock file in place: removing it can allow overlapping lock holders.
exec 9>.deploy.lock
flock -n 9 || fail 'Another deployment is already running in this directory'
compose=(docker compose --project-directory "$PWD" -f "$PWD/compose.yaml")
trap 'code=$?; log "ERROR: Deployment failed (exit $code); cleanup was not completed. Check the output above." >&2; exit "$code"' ERR
log 'Checking Docker and Compose configuration…'
docker info >/dev/null
"${compose[@]}" version >/dev/null
"${compose[@]}" config --quiet

log 'Pulling published images…'
"${compose[@]}" pull --policy always
log 'Updating containers…'
"${compose[@]}" up -d --no-build --pull never --remove-orphans

log "Waiting for online-md (timeout: ${deploy_timeout}s)…"
deadline=$((SECONDS + deploy_timeout))
ready=false
while ((SECONDS < deadline)); do
  container_id=$("${compose[@]}" ps --all --quiet online-md)
  if [[ -n $container_id ]]; then
    status=$(docker inspect --format '{{.State.Status}} {{.State.Restarting}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")
    if [[ $status == 'running false none' || $status == 'running false healthy' ]]; then
      http_code=$(curl --silent --show-error --fail --location --max-redirs 3 --noproxy '*' --connect-timeout 2 --max-time 3 --output /dev/null --write-out '%{http_code}' "$health_url" 2>/dev/null) || http_code=000
      if [[ $http_code == 200 ]]; then ready=true; break; fi
    elif [[ $status == exited* || $status == dead* ]]; then
      break
    fi
  fi
  sleep 2
done
if [[ $ready != true ]]; then
  "${compose[@]}" ps --all >&2 || true
  "${compose[@]}" logs --no-color --tail 50 online-md >&2 || true
  fail 'Service readiness check failed. Images were kept; inspect logs before retrying or rolling back.'
fi

"${compose[@]}" ps
if [[ $prune == true ]]; then
  log 'Removing host-wide dangling images…'
  docker image prune --force
fi
log 'Deployment complete; online-md is running and responding to HTTP requests.'
