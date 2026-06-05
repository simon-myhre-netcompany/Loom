#!/usr/bin/env bash
# Compile the EventKit calendar helper. macOS-only; a no-op elsewhere so the
# main `npm run build` stays cross-platform.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ]; then
  echo "build-helper: not macOS, skipping native helpers."
  exit 0
fi

# Copy the JXA mail helper (interpreted, no compiler needed) next to its
# compiled connector so `./helper.js` resolves from dist/.
mkdir -p dist/connectors/mail
cp src/connectors/mail/helper.js dist/connectors/mail/helper.js
echo "build-helper: copied mail helper.js into dist/"

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
