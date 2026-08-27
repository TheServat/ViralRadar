#!/usr/bin/env bash
#
# One-shot installer for Viral Radar on macOS and Linux.
# Safe to run again: it never overwrites an existing .env.
#
#   ./scripts/install.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

green() { printf '  \033[32m\xe2\x9c\x93\033[0m %s\n' "$1"; }
step()  { printf '\n  \033[36m%s\033[0m\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }

printf '\n  Viral Radar - installer\n  %s\n' "$ROOT"

step 'Checking Node.js'
if ! command -v node >/dev/null 2>&1; then
  printf '\n  Node.js is not installed, or not on PATH.\n'
  printf '  Install Node.js 24 or newer from https://nodejs.org and run this again.\n\n'
  exit 1
fi
MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$MAJOR" -lt 24 ]; then
  # node:sqlite and native TypeScript execution both need 24.
  printf '\n  Node.js %s found, but 24 or newer is required.\n\n' "$(node --version)"
  exit 1
fi
green "Node.js $(node --version)"

step 'Installing dependencies'
# One workspace install covers both apps.
npm install --no-audit --no-fund
green 'Dependencies installed'

step 'Checking configuration'
if [ -f .env ]; then
  green '.env already exists and was left alone'
else
  cp .env.example .env
  green '.env created from the template'
  warn 'Open the Settings page after starting to add your API keys'
fi

step 'Building the dashboard'
npm run build
green 'Dashboard built'

printf '\n  \033[32mInstalled.\033[0m\n\n'
printf '  Start it:   ./scripts/radar.sh   (or: npm start)\n'
printf '  Dashboard:  http://127.0.0.1:7788\n'
printf '  Check it:   npm run doctor\n\n'
printf '  \033[90mGrowth needs two measurements, so give it about 40 minutes\n'
printf '  before judging the results.\033[0m\n\n'
