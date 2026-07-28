#!/bin/sh
# Apply all patches from patches/ for a given submodule target.
#
# Naming convention (flat patches/ directory):
#   jellyfin_web*.patch  -> jellyfin-web/
#   jellyfin_*.patch     -> jellyfin/  (excluding jellyfin_web*)
#
# Usage: apply-patches.sh [jellyfin|jellyfin-web|all] [patches-dir]

set -eu

TARGET="${1:-all}"
PATCHES_DIR="${2:-patches}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

if [ "$TARGET" = "all" ]; then
    "$0" jellyfin "$PATCHES_DIR"
    "$0" jellyfin-web "$PATCHES_DIR"
    exit 0
fi

if [ ! -d "$PATCHES_DIR" ]; then
    echo "No patches directory found at $PATCHES_DIR; skipping."
    exit 0
fi

if git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
    echo "Resetting $TARGET submodule to clean state..."
    git -C "$TARGET" checkout -- .
    git -C "$TARGET" clean -fd
else
    echo "$TARGET is not a git repository; initializing temporary git repository..."
    (cd "$TARGET" && git init -q && git config user.name "build" && git config user.email "build@local" && git add -A && git commit -q -m "initial" >/dev/null 2>&1 || true)
fi

apply_patch() {
    patch_file="$1"
    echo "Applying $patch_file to $TARGET/"
    case "$patch_file" in
        /*) abs_patch="$patch_file" ;;
        *)  abs_patch="$REPO_ROOT/$patch_file" ;;
    esac
    (cd "$TARGET" && git apply -p1 "$abs_patch")
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
            echo "Unknown target: $TARGET (expected jellyfin, jellyfin-web, or all)" >&2
            exit 1
            ;;
    esac
done

if [ "$found" -eq 0 ]; then
    echo "No patches to apply for $TARGET"
fi
