#!/usr/bin/env bash
# Create or update a GitHub issue when migration sync fails in CI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FAILURE_REPORT="${REPO_ROOT}/.sync-failure-report.md"
LABEL="migration-sync-failure"

if [[ -z "${GH_TOKEN:-}" ]]; then
    echo "[report-sync-failure] GH_TOKEN not set; skipping issue creation." >&2
    exit 0
fi

if [[ ! -f "${FAILURE_REPORT}" ]]; then
    echo "[report-sync-failure] No failure report at ${FAILURE_REPORT}; skipping." >&2
    exit 0
fi

TARGET_VERSION="$(grep -m1 'Migration sync failed for Jellyfin ' "${FAILURE_REPORT}" | sed 's/# Migration sync failed for Jellyfin //')"
TITLE="Migration sync failed for Jellyfin ${TARGET_VERSION}"

echo "[report-sync-failure] Looking for open issue: ${TITLE}"

EXISTING_ISSUE="$(gh issue list \
    --label "${LABEL}" \
    --state open \
    --limit 100 \
    --json number,title \
    --jq ".[] | select(.title == \"${TITLE}\") | .number" | head -n1)"

TIMESTAMP="$(date -u +"%Y-%m-%d %H:%M UTC")"
COMMENT_BODY="$(cat <<EOF
## Sync failed again (${TIMESTAMP})

$(cat "${FAILURE_REPORT}")
EOF
)"

if [[ -n "${EXISTING_ISSUE}" ]]; then
    echo "[report-sync-failure] Updating existing issue #${EXISTING_ISSUE}"
    gh issue comment "${EXISTING_ISSUE}" --body "${COMMENT_BODY}"
    gh issue reopen "${EXISTING_ISSUE}" 2>/dev/null || true
else
    echo "[report-sync-failure] Creating new issue"
    gh label create "${LABEL}" \
        --description "Automated migration sync failure" \
        --color "B60205" 2>/dev/null || true
    gh issue create \
        --title "${TITLE}" \
        --label "${LABEL}" \
        --body "$(cat "${FAILURE_REPORT}")" \
        || gh issue create \
            --title "${TITLE}" \
            --body "$(cat "${FAILURE_REPORT}")"
fi
