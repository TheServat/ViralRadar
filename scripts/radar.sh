#!/usr/bin/env bash
# Viral Radar launcher for macOS and Linux.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed, or not on PATH."
  echo "  Install Node.js 24 or newer from https://nodejs.org and run this again."
  echo
  exit 1
fi

if [ ! -f apps/web/dist/index.html ]; then
  echo "  Building the dashboard for the first time..."
  npm run build
fi

# Open the dashboard once the server has had a moment to bind.
(
  sleep 4
  if command -v open >/dev/null 2>&1; then open http://127.0.0.1:7788
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://127.0.0.1:7788
  fi
) >/dev/null 2>&1 &

exec node apps/api/src/main.ts serve
