#!/usr/bin/env bash
# Run loom inside the Ubuntu container — proves/uses the Phase 3 port.
#
#   scripts/loom-docker.sh tempo worklogs --since 7d --json
#   scripts/loom-docker.sh keys
#   LOOM_DOCKER_BUILD=1 scripts/loom-docker.sh --help   # force a rebuild
#
# Security model: secrets stay on the host. .env is dockerignored (never in an
# image layer) and is mounted READ-ONLY into the container only for the
# lifetime of one command. Nothing else from the host is exposed.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=loom

if [ -n "${LOOM_DOCKER_BUILD:-}" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" .
fi

args=(--rm -i)
# A TTY makes loom interactive/table-mode, like running it natively.
if [ -t 0 ] && [ -t 1 ]; then args+=(-t); fi

# Secrets: mount .env read-only (not --env-file, which leaks values into
# `docker inspect`). Loom's own loader picks it up at /app/.env.
if [ -f .env ]; then args+=(-v "$PWD/.env:/app/.env:ro"); fi

# Credential *metadata* (expiry dates, no secrets) — read-write so
# `loom keys add` works from inside the container too.
if [ -f credentials.json ]; then args+=(-v "$PWD/credentials.json:/app/credentials.json"); fi

exec docker run "${args[@]}" "$IMAGE" "$@"
