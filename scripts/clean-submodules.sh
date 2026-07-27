#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "Cleaning submodules back to original unpatched tag..."
git -C jellyfin checkout -- .
git -C jellyfin clean -fd
git -C jellyfin-web checkout -- .
git -C jellyfin-web clean -fd
echo "Submodules are clean!"
