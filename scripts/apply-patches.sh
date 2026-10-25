#!/bin/sh
# Apply server patches from patches/.
#
# Naming convention (flat patches/ directory): jellyfin_*.patch -> jellyfin/
#
# Usage:
#   apply-patches.sh [jellyfin|all] [patches-dir]
#   apply-patches.sh --list [jellyfin|all] [patches-dir]
#
# --list prints matching patch paths in apply order (no submodule reset).

set -eu

LIST_ONLY=0
if [ "${1:-}" = "--list" ]; then
    LIST_ONLY=1
    shift
fi

TARGET="${1:-jellyfin}"
PATCHES_DIR="${2:-patches}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

case "$TARGET" in
    all|jellyfin) TARGET="jellyfin" ;;
    *)
        echo "Unknown target: $TARGET (expected jellyfin or all)" >&2
        exit 1
        ;;
esac

if [ ! -d "$PATCHES_DIR" ]; then
    if [ "$LIST_ONLY" = 1 ]; then
        exit 0
    fi
    echo "No patches directory found at $PATCHES_DIR; skipping."
    exit 0
fi

patch_matches() {
    base="$1"
    case "$base" in
        jellyfin_web*.patch)
            echo "ERROR: web patches are no longer supported: $base" >&2
            exit 1
            ;;
        jellyfin_*.patch|jellyfin.patch) return 0 ;;
        *) return 1 ;;
    esac
}

if [ "$LIST_ONLY" = 1 ]; then
    # Byte-order sorting keeps server patch prerequisites stable across locales.
    # shellcheck disable=SC2012
    for patch_file in $(ls "$PATCHES_DIR"/*.patch 2>/dev/null | LC_ALL=C sort); do
        base=$(basename "$patch_file")
        if patch_matches "$base"; then
            echo "$patch_file"
        fi
    done
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
    if ! (cd "$TARGET" && git apply -p1 "$abs_patch"); then
        echo "ERROR: $patch_file failed to apply to $TARGET/" >&2
        exit 1
    fi
}

found=0
# shellcheck disable=SC2012
for patch_file in $(ls "$PATCHES_DIR"/*.patch 2>/dev/null | LC_ALL=C sort); do
    base=$(basename "$patch_file")
    if patch_matches "$base"; then
        apply_patch "$patch_file"
        found=1
    fi
done

if [ "$found" -eq 0 ]; then
    echo "No patches to apply for $TARGET"
fi
