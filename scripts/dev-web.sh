#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

echo "================================================================="
echo "        Fast Local Webpack Dev Server (jellyfin-web HMR)"
echo "================================================================="

cd jellyfin-web
npm start
