#!/bin/bash
# Export a patch from modified submodule files against preceding dependencies.
#
# Usage: ./scripts/export-patch.sh <patch_name_or_path>
# Example: ./scripts/export-patch.sh jellyfin_web_zzz_livetv_multiview.patch

set -eu

PATCH_ARG="${1:-}"
if [ -z "$PATCH_ARG" ]; then
    echo "Usage: $0 <patch_name_or_path>"
    echo "Example: $0 jellyfin_web_zzz_livetv_multiview.patch"
    exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

PATCH_BASE=$(basename "$PATCH_ARG")
PATCH_FILE="patches/$PATCH_BASE"

# Determine target submodule based on naming convention
case "$PATCH_BASE" in
    jellyfin_web*.patch)
        TARGET="jellyfin-web"
        ;;
    jellyfin_*.patch|jellyfin.patch)
        TARGET="jellyfin"
        ;;
    *)
        echo "Error: Patch filename must start with jellyfin_web_ or jellyfin_"
        exit 1
        ;;
esac

echo "================================================================="
echo "       Exporting Patch: $PATCH_BASE ($TARGET/)"
echo "================================================================="

# Check if there are changes in the target submodule
if [ -z "$(git -C "$TARGET" status --porcelain)" ]; then
    echo "Error: No modified or untracked files found in $TARGET/. Make your edits first."
    exit 1
fi

# Stage intent to add for new files so git diff sees them
git -C "$TARGET" add -N . 2>/dev/null || true

# Save current uncommitted diff against submodule HEAD
TEMP_CHANGES=$(mktemp)
TEMP_UNTRACKED=$(mktemp -d)
trap 'rm -f "$TEMP_CHANGES"; rm -rf "$TEMP_UNTRACKED"' EXIT

echo "Snapshotted current submodule edits..."
git -C "$TARGET" diff > "$TEMP_CHANGES"

# Copy untracked files if any
(cd "$TARGET" && git status --porcelain | grep '^??' | awk '{print $2}' | while read -r f; do
    if [ -f "$f" ]; then
        mkdir -p "$TEMP_UNTRACKED/$(dirname "$f")"
        cp "$f" "$TEMP_UNTRACKED/$f"
    fi
done) || true

# Reset submodule to clean release tag
echo "Resetting $TARGET submodule to clean state..."
git -C "$TARGET" reset --hard v12.0-rc3 >/dev/null
git -C "$TARGET" clean -fd >/dev/null

# Backup target patch temporarily if it exists
if [ -f "$PATCH_FILE" ]; then
    rm -f "$PATCH_FILE"
fi

# Apply preceding dependency patches
echo "Applying preceding dependency patches to $TARGET/..."
./scripts/apply-patches.sh "$TARGET" >/dev/null

# Create baseline commit
git -C "$TARGET" add -A
git -C "$TARGET" commit -q -m "baseline_deps"
BASE_HASH=$(git -C "$TARGET" rev-parse HEAD)

# Restore feature changes onto baseline_deps
echo "Restoring feature edits onto baseline..."
if [ -s "$TEMP_CHANGES" ]; then
    if ! git -C "$TARGET" apply "$TEMP_CHANGES" 2>/dev/null; then
        git -C "$TARGET" apply --3way "$TEMP_CHANGES" 2>/dev/null || git -C "$TARGET" apply --reject "$TEMP_CHANGES" 2>/dev/null || true
    fi
fi

if [ -d "$TEMP_UNTRACKED" ]; then
    cp -Rf "$TEMP_UNTRACKED/"* "$TARGET/" 2>/dev/null || true
fi

# Stage intent to add for any new files
git -C "$TARGET" add -N . 2>/dev/null || true

# Export diff against baseline_deps
echo "Generating $PATCH_FILE..."
git -C "$TARGET" diff "$BASE_HASH" > "$PATCH_FILE"

# Ensure trailing newline on patch file
if [ -s "$PATCH_FILE" ] && [ -n "$(tail -c 1 "$PATCH_FILE")" ]; then
    echo "" >> "$PATCH_FILE"
fi

FILE_COUNT=$(grep -c "^diff --git" "$PATCH_FILE" || true)
LINE_COUNT=$(wc -l < "$PATCH_FILE")

echo "-----------------------------------------------------------------"
echo "Successfully exported $PATCH_FILE ($FILE_COUNT files, $LINE_COUNT lines)"
echo "Files included:"
grep "^diff --git" "$PATCH_FILE" | sed 's/diff --git a\//  - /' | sed 's/ b\/.*//'
echo "-----------------------------------------------------------------"

# Reset submodule back to clean state
echo "Resetting $TARGET submodule to clean state..."
git -C "$TARGET" reset --hard v12.0-rc3 >/dev/null
git -C "$TARGET" clean -fd >/dev/null

if [ "$TARGET" = "jellyfin-web" ]; then
    echo "Rebuilding web static bundle..."
    ./scripts/build-web.sh
fi

echo "Done!"
