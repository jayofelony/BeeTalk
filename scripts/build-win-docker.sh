#!/usr/bin/env bash
# Build the Windows installer on Linux using electron-builder's Wine image.
# Output goes to dist/, owned by the current user.
set -euo pipefail

cd "$(dirname "$0")/.."

# Pre-create cache dirs so Docker doesn't create them as root
mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"

docker run --rm -t \
  -v "$PWD":/project \
  -v beetalk-node-modules:/project/node_modules \
  -v "$HOME/.cache/electron":/root/.cache/electron \
  -v "$HOME/.cache/electron-builder":/root/.cache/electron-builder \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  electronuserland/builder:wine \
  bash -c 'npm ci && npm run build:win; status=$?; chown -R "$HOST_UID:$HOST_GID" dist 2>/dev/null; exit $status'
