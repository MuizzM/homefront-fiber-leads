#!/usr/bin/env bash
set -euo pipefail

mode="${1:-focused}"
if [[ $# -gt 0 ]]; then shift; fi

node scripts/validate-agent-harness.mjs

if [[ "$mode" == "harness" ]]; then
  exit 0
fi

bash tests/deployment-safety.sh
npm run check
npm run check:fast

if [[ "$mode" == "focused" ]]; then
  if [[ $# -eq 0 ]]; then
    echo "focused validation requires at least one test path" >&2
    exit 2
  fi
  npx vitest run "$@"
  exit 0
fi

if [[ "$mode" == "full" ]]; then
  npm test
  npm run build
  exit 0
fi

echo "usage: bash scripts/agent-verify.sh harness|focused [test paths...]|full" >&2
exit 2
