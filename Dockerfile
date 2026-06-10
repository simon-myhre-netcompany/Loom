# Loom on Ubuntu — Phase 3 portability image.
#
# Runs every HTTP/API connector (tempo, jira, confluence, github, slack) and
# the ICS calendar backend. macOS-local sources (EventKit calendar, Apple Mail)
# degrade with a clear message; no Swift toolchain needed or included.
#
# SECRETS ARE NEVER BAKED IN: .env is dockerignored, so no image layer can
# contain a token. Provide credentials at runtime instead, either by mounting
# .env read-only (what scripts/loom-docker.sh does):
#
#   docker build -t loom .
#   docker run --rm -v "$PWD/.env:/app/.env:ro" loom tempo worklogs --since 7d --json
#
# or with --env-file (note: env vars are then visible in `docker inspect`):
#
#   docker run --rm --env-file .env loom jira issues --since 7d --json

FROM ubuntu:24.04 AS build

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
RUN npm run build   # tsc + build-helper.sh (helper build is a no-op off macOS)


FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
# credentials.json (expiry metadata, no secrets) is personal/local — the
# loom-docker.sh wrapper mounts it at runtime when present.

# `loom` on PATH, as documented in GOAL.md Phase 3.
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/loom \
    && chmod +x /usr/local/bin/loom

# Non-root: ubuntu:24.04 ships an `ubuntu` user (uid 1000).
USER ubuntu

ENTRYPOINT ["loom"]
CMD ["--help"]
