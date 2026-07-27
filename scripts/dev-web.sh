#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

echo "================================================================="
echo "        Fast Local Webpack Dev Server (jellyfin-web HMR)"
echo "================================================================="

echo "Applying web patches to jellyfin-web submodule..."
./scripts/apply-patches.sh jellyfin-web

echo "Starting Webpack Dev Server..."
cd jellyfin-web
npm start
