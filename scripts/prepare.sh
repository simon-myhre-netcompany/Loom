#!/usr/bin/env bash
# npm `prepare` hook — builds dist/ when installing straight from git
# (npm install -g github:<owner>/loom).
#
# npm 10/11 prepares git deps in a temp clone WITHOUT exposing devDependency
# binaries to the script (tsc lands in node_modules but .bin isn't linked /
# on PATH yet), so a plain `npm run build` fails with "tsc: not found".
# Use the local compiler when present; otherwise fetch the build tools ad hoc.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x node_modules/.bin/tsc ]; then
  npm install --no-save --silent "typescript@^5" "@types/node@^22"
fi
node_modules/.bin/tsc
bash scripts/build-helper.sh
