#!/usr/bin/env bash
# Compile the EventKit calendar helper. macOS-only; a no-op elsewhere so the
# main `npm run build` stays cross-platform.
set -euo pipefail
cd "$(dirname "$0")/.."

# Copy the JXA mail helper (interpreted, no compiler needed) next to its
# compiled connector so `./helper.js` resolves from dist/. Done on every
# platform so dist/ has the same shape everywhere.
mkdir -p dist/connectors/mail
cp src/connectors/mail/helper.js dist/connectors/mail/helper.js
echo "build-helper: copied mail helper.js into dist/"

# Stamp the build for `loom --version`. "unknown" when there is no git checkout
# (e.g. npm installing from a GitHub tarball).
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '{ "sha": "%s" }\n' "$SHA" > dist/build-info.json
echo "build-helper: stamped dist/build-info.json ($SHA)"

if [ "$(uname)" != "Darwin" ]; then
  echo "build-helper: not macOS, skipping the EventKit calendar helper."
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-helper: swiftc not found (install Xcode command line tools), skipping calendar."
  exit 0
fi

mkdir -p bin
swiftc src/connectors/calendar/helper.swift -O -o bin/calendar-helper \
  -framework EventKit -framework Foundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker src/connectors/calendar/Info.plist
echo "build-helper: built bin/calendar-helper"
