#!/bin/sh
# Apply all patches from patches/ for a given submodule target.
#
# Naming convention (flat patches/ directory):
#   jellyfin_web*.patch  -> jellyfin-web/
#   jellyfin_*.patch     -> jellyfin/  (excluding jellyfin_web*)
#
# Usage: apply-patches.sh <jellyfin|jellyfin-web> [patches-dir]

set -eu

TARGET="${1:?Usage: $0 <jellyfin|jellyfin-web> [patches-dir]}"
PATCHES_DIR="${2:-patches}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

if [ ! -d "$PATCHES_DIR" ]; then
    echo "No patches directory found at $PATCHES_DIR; skipping."
    exit 0
fi

echo "Resetting $TARGET submodule to clean state..."
git -C "$TARGET" checkout -- .
git -C "$TARGET" clean -fd

apply_patch() {
    patch_file="$1"
    echo "Applying $patch_file to $TARGET/"
    git apply --directory="$TARGET" "$patch_file"
}

found=0
# shellcheck disable=SC2012
for patch_file in $(ls "$PATCHES_DIR"/*.patch 2>/dev/null | sort); do
    base=$(basename "$patch_file")
    case "$TARGET" in
        jellyfin-web)
            case "$base" in
                jellyfin_web*.patch)
                    apply_patch "$patch_file"
                    found=1
                    ;;
            esac
            ;;
        jellyfin)
            case "$base" in
                jellyfin_web*.patch)
                    ;; # handled by jellyfin-web target
                jellyfin_*.patch|jellyfin.patch)
                    apply_patch "$patch_file"
                    found=1
                    ;;
            esac
            ;;
        *)
            echo "Unknown target: $TARGET (expected jellyfin or jellyfin-web)" >&2
            exit 1
            ;;
    esac
done

if [ "$found" -eq 0 ]; then
    echo "No patches to apply for $TARGET"
fi
