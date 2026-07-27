#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

echo "================================================================="
echo "       Building Patched Web UI (jellyfin-web/dist)"
echo "================================================================="

# Ensure patches are applied before building
echo "Applying web patches to jellyfin-web submodule..."
./scripts/apply-patches.sh jellyfin-web

echo "Cleaning old web build..."
rm -rf jellyfin-web/dist/*

echo "Installing/syncing web dependencies..."
cd jellyfin-web
npm install

echo "Building web static production bundle into jellyfin-web/dist..."
npm run build:production

echo "jellyfin-web/dist updated successfully!"
