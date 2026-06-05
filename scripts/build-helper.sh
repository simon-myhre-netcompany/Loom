#!/usr/bin/env bash
# Compile the EventKit calendar helper. macOS-only; a no-op elsewhere so the
# main `npm run build` stays cross-platform.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ]; then
  echo "build-helper: not macOS, skipping calendar helper."
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-helper: swiftc not found (install Xcode command line tools), skipping."
  exit 0
fi

mkdir -p bin
swiftc src/connectors/calendar/helper.swift -O -o bin/calendar-helper \
  -framework EventKit -framework Foundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker src/connectors/calendar/Info.plist
echo "build-helper: built bin/calendar-helper"
