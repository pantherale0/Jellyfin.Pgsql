#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "Cleaning the jellyfin submodule back to its pinned tag..."
git -C jellyfin checkout -- .
git -C jellyfin clean -fd
echo "The jellyfin submodule is clean!"
