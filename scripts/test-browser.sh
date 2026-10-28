#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm typecheck:extension
pnpm build:extension
exec node tests/run-browser.cjs "$@"
