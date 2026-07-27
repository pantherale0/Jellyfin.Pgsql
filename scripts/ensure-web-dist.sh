#!/bin/bash
# ensure-web-dist.sh — Build jellyfin-web/dist only when needed.
#
# Rebuilds when:
#   1. dist/index.html does not exist, OR
#   2. The set of web patches has changed since the last build
#      (detected via a hash of all jellyfin_web*.patch files).
#
# This avoids serving a stale dist/ after patches are updated.
set -e

cd "$(dirname "$0")/.."

DIST_MARKER="jellyfin-web/dist/index.html"
HASH_FILE="jellyfin-web/dist/.patches-hash"

# Compute a hash over the content of all web patches
current_hash=$(cat patches/jellyfin_web*.patch 2>/dev/null | sha256sum | cut -d' ' -f1)
stored_hash=""
if [ -f "$HASH_FILE" ]; then
    stored_hash=$(cat "$HASH_FILE")
fi

if [ -f "$DIST_MARKER" ] && [ "$current_hash" = "$stored_hash" ]; then
    echo "jellyfin-web/dist is up to date (patches unchanged). Skipping rebuild."
    exit 0
fi

if [ "$current_hash" != "$stored_hash" ] && [ -f "$DIST_MARKER" ]; then
    echo "Web patches changed since last build — rebuilding dist..."
else
    echo "No dist found — building from scratch..."
fi

./scripts/build-web.sh

# Store the hash so subsequent runs can skip
echo "$current_hash" > "$HASH_FILE"
