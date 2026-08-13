#!/bin/sh
# Apply all patches from patches/ for a given submodule target.
#
# Naming convention (flat patches/ directory):
#   jellyfin_web*.patch  -> jellyfin-web/
#   jellyfin_*.patch     -> jellyfin/  (excluding jellyfin_web*)
#
# Usage:
#   apply-patches.sh [jellyfin|jellyfin-web|all] [patches-dir]
#   apply-patches.sh --list [jellyfin|jellyfin-web|all] [patches-dir]
#
# --list prints matching patch paths in apply order (no submodule reset).

set -eu

LIST_ONLY=0
if [ "${1:-}" = "--list" ]; then
    LIST_ONLY=1
    shift
fi

TARGET="${1:-all}"
PATCHES_DIR="${2:-patches}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

if [ "$TARGET" = "all" ]; then
    "$0" $([ "$LIST_ONLY" = 1 ] && echo --list) jellyfin "$PATCHES_DIR"
    "$0" $([ "$LIST_ONLY" = 1 ] && echo --list) jellyfin-web "$PATCHES_DIR"
    exit 0
fi

case "$TARGET" in
    jellyfin|jellyfin-web)
        ;;
    *)
        echo "Unknown target: $TARGET (expected jellyfin, jellyfin-web, or all)" >&2
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
    case "$TARGET" in
        jellyfin-web)
            case "$base" in
                jellyfin_web*.patch) return 0 ;;
            esac
            ;;
        jellyfin)
            case "$base" in
                jellyfin_web*.patch) return 1 ;;
                jellyfin_*.patch|jellyfin.patch) return 0 ;;
            esac
            ;;
    esac
    return 1
}

if [ "$LIST_ONLY" = 1 ]; then
    # shellcheck disable=SC2012
    for patch_file in $(ls "$PATCHES_DIR"/*.patch 2>/dev/null | sort); do
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
for patch_file in $(ls "$PATCHES_DIR"/*.patch 2>/dev/null | sort); do
    base=$(basename "$patch_file")
    if patch_matches "$base"; then
        apply_patch "$patch_file"
        found=1
    fi
done

if [ "$found" -eq 0 ]; then
    echo "No patches to apply for $TARGET"
fi
