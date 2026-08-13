#!/usr/bin/env bash
# Rebase the patches/ series from one Jellyfin tag onto another.
#
# Each matching patch is applied as a commit on --from, then the series is
# rebased onto --to. Successful commits are written back to patches/*.patch
# (still incremental against preceding patches, same lexicographic order).
#
# Usage:
#   ./scripts/rebase-patches.sh --from v12.0-rc4 --to v12.0-rc5
#   ./scripts/rebase-patches.sh --from v12.0-rc4 --to v12.0-rc5 --target jellyfin
#
# Does not update git config. Submodule is left clean at --to on success or
# after a conflict abort. True merge conflicts are not auto-resolved.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/patches"
FROM_TAG=""
TO_TAG=""
TARGET="all"
CONFLICT_REPORT=""

GIT_NAME="patch-rebase"
GIT_EMAIL="patch-rebase@local"

usage() {
    cat <<EOF
Usage: $(basename "$0") --from TAG --to TAG [OPTIONS]

Replay patches/*.patch as a commit series on --from and rebase onto --to,
then rewrite the patch files.

Options:
  --from TAG          Source Jellyfin tag (e.g. v12.0-rc4)
  --to TAG            Destination Jellyfin tag (e.g. v12.0-rc5)
  --target TARGET     jellyfin, jellyfin-web, or all (default: all)
  --patches-dir DIR   Patch directory (default: patches/)
  --conflict-report FILE
                      Write a conflict/failure report to FILE
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --from)
            FROM_TAG="$2"
            shift 2
            ;;
        --to)
            TO_TAG="$2"
            shift 2
            ;;
        --target)
            TARGET="$2"
            shift 2
            ;;
        --patches-dir)
            PATCHES_DIR="$2"
            shift 2
            ;;
        --conflict-report)
            CONFLICT_REPORT="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            exit 1
            ;;
    esac
done

normalize_tag() {
    local tag="$1"
    tag="${tag#v}"
    echo "v${tag}"
}

if [[ -z "${FROM_TAG}" || -z "${TO_TAG}" ]]; then
    echo "ERROR: --from and --to are required." >&2
    usage
    exit 1
fi

FROM_TAG="$(normalize_tag "${FROM_TAG}")"
TO_TAG="$(normalize_tag "${TO_TAG}")"

write_report() {
    local body="$1"
    echo "${body}" >&2
    if [[ -n "${CONFLICT_REPORT}" ]]; then
        printf '%s\n' "${body}" > "${CONFLICT_REPORT}"
    fi
}

ensure_trailing_newline() {
    local file="$1"
    if [[ -s "${file}" ]] && [[ -n "$(tail -c 1 "${file}")" ]]; then
        echo "" >> "${file}"
    fi
}

git_sub() {
    git -C "${REPO_ROOT}/${1}" \
        -c "user.name=${GIT_NAME}" \
        -c "user.email=${GIT_EMAIL}" \
        -c advice.detachedHead=false \
        "${@:2}"
}

reset_clean() {
    local name="$1"
    local tag="$2"
    git_sub "${name}" reset --hard "${tag}" >/dev/null
    git_sub "${name}" clean -fd >/dev/null
}

collect_conflicts() {
    local name="$1"
    git_sub "${name}" diff --name-only --diff-filter=U 2>/dev/null || true
}

current_rebase_patch() {
    local name="$1"
    local git_dir message
    git_dir="$(git_sub "${name}" rev-parse --git-dir)"
    for message in \
        "${git_dir}/rebase-merge/message" \
        "${git_dir}/rebase-apply/final-commit"; do
        if [[ -f "${message}" ]]; then
            sed -n '1p' "${message}"
            return 0
        fi
    done
    git_sub "${name}" log -1 --format=%s HEAD 2>/dev/null || echo "(unknown)"
}

in_rebase() {
    local name="$1"
    local git_dir
    git_dir="$(git_sub "${name}" rev-parse --git-dir)"
    [[ -d "${git_dir}/rebase-merge" || -d "${git_dir}/rebase-apply" ]]
}

is_snapshot_path() {
    local path="$1"
    case "${path}" in
        *ModelSnapshot.cs|*DbContextModelSnapshot.cs|*JellyfinDbModelSnapshot.cs) return 0 ;;
        *) return 1 ;;
    esac
}

only_snapshot_conflicts() {
    local files="$1"
    local line
    [[ -n "${files}" ]] || return 1
    while IFS= read -r line; do
        [[ -z "${line}" ]] && continue
        if ! is_snapshot_path "${line}"; then
            return 1
        fi
    done <<< "${files}"
    return 0
}

abort_rebase() {
    local name="$1"
    git_sub "${name}" rebase --abort >/dev/null 2>&1 || true
    reset_clean "${name}" "${TO_TAG}"
}

# During rebase, --ours is the new tag (onto), --theirs is the patch commit.
# EF snapshots are huge and often look binary to git; the fork's SQLite snapshot
# hunks are not needed for PostgreSQL. Prefer the new upstream snapshot.
resolve_snapshot_conflicts() {
    local name="$1"
    local files="$2"
    local file
    while IFS= read -r file; do
        [[ -z "${file}" ]] && continue
        git_sub "${name}" checkout --ours -- "${file}"
        git_sub "${name}" add "${file}"
    done <<< "${files}"
}

report_rebase_conflict() {
    local name="$1"
    local patch_name="$2"
    local conflicted="$3"
    write_report "ERROR: patch rebase conflict in \`${name}/\` while applying \`${patch_name}\` onto ${TO_TAG}.

Conflicted files:
${conflicted:-  (git did not report unmerged paths)}

True merge conflicts are not auto-resolved. Fix by checking out ${FROM_TAG},
applying the series as commits, rebasing onto ${TO_TAG}, and exporting with
\`./scripts/export-patch.sh\`, or re-run:

  ./scripts/rebase-patches.sh --from ${FROM_TAG} --to ${TO_TAG} --target ${name}
"
}

rebase_one_target() {
    local name="$1"
    local -a patches=()
    local patch base abs_patch hash parent subject written dropped
    local -a original_names=()
    local -a exported_names=()

    mapfile -t patches < <(bash "${SCRIPT_DIR}/apply-patches.sh" --list "${name}" "${PATCHES_DIR}")
    if [[ ${#patches[@]} -eq 0 ]]; then
        echo "[rebase] No patches for ${name}; skipping."
        return 0
    fi

    echo "[rebase] ${name}: ${#patches[@]} patch(es) ${FROM_TAG} -> ${TO_TAG}"

    git_sub "${name}" fetch --tags origin >/dev/null 2>&1 || git_sub "${name}" fetch --tags origin

    if ! git_sub "${name}" rev-parse --verify --quiet "${FROM_TAG}^{commit}" >/dev/null; then
        write_report "ERROR: ${name} does not have tag ${FROM_TAG}."
        return 1
    fi
    if ! git_sub "${name}" rev-parse --verify --quiet "${TO_TAG}^{commit}" >/dev/null; then
        write_report "ERROR: ${name} does not have tag ${TO_TAG}."
        return 1
    fi

    reset_clean "${name}" "${FROM_TAG}"

    for patch in "${patches[@]}"; do
        base="$(basename "${patch}")"
        original_names+=("${base}")
        case "${patch}" in
            /*) abs_patch="${patch}" ;;
            *) abs_patch="${REPO_ROOT}/${patch}" ;;
        esac
        echo "[rebase] Applying ${base} onto ${FROM_TAG} series..."
        if ! git_sub "${name}" apply -p1 "${abs_patch}"; then
            reset_clean "${name}" "${TO_TAG}"
            write_report "ERROR: ${base} does not apply on ${FROM_TAG} in ${name}/.
The existing patch stack is already broken on the source tag; fix that before rebasing."
            return 1
        fi
        git_sub "${name}" add -A
        if git_sub "${name}" diff --cached --quiet; then
            git_sub "${name}" commit --allow-empty -q -m "patch: ${base}"
        else
            git_sub "${name}" commit -q -m "patch: ${base}"
        fi
    done

    echo "[rebase] Rebasing ${name} series onto ${TO_TAG}..."
    local snapshot_drops=""
    if ! git_sub "${name}" rebase --onto "${TO_TAG}" "${FROM_TAG}" --empty=drop; then
        while in_rebase "${name}"; do
            local conflicted patch_name
            conflicted="$(collect_conflicts "${name}")"
            patch_name="$(current_rebase_patch "${name}")"
            if only_snapshot_conflicts "${conflicted}"; then
                echo "[rebase] WARNING: keeping ${TO_TAG} EF snapshot(s), dropping patch hunks in:"
                echo "${conflicted}"
                snapshot_drops+="${patch_name}:"$'\n'"${conflicted}"$'\n'
                resolve_snapshot_conflicts "${name}" "${conflicted}"
                if GIT_EDITOR=true git_sub "${name}" rebase --continue; then
                    break
                fi
                continue
            fi
            abort_rebase "${name}"
            report_rebase_conflict "${name}" "${patch_name}" "${conflicted}"
            return 2
        done
        if in_rebase "${name}"; then
            abort_rebase "${name}"
            write_report "ERROR: rebase of ${name} did not complete after snapshot conflict handling."
            return 2
        fi
    fi

    dropped=""
    while IFS= read -r hash; do
        [[ -n "${hash}" ]] || continue
        subject="$(git_sub "${name}" log -1 --format=%s "${hash}")"
        if [[ "${subject}" != patch:* ]]; then
            reset_clean "${name}" "${TO_TAG}"
            write_report "ERROR: unexpected commit on rebased ${name} series: ${subject}"
            return 1
        fi
        base="${subject#patch: }"
        parent="$(git_sub "${name}" rev-parse "${hash}^")"
        git_sub "${name}" diff --binary "${parent}" "${hash}" > "${PATCHES_DIR}/${base}"
        ensure_trailing_newline "${PATCHES_DIR}/${base}"
        exported_names+=("${base}")
        echo "[rebase] Wrote patches/${base}"
    done < <(git_sub "${name}" rev-list --reverse "${TO_TAG}..HEAD")

    for base in "${original_names[@]}"; do
        written=false
        for exported in "${exported_names[@]+"${exported_names[@]}"}"; do
            if [[ "${exported}" == "${base}" ]]; then
                written=true
                break
            fi
        done
        if [[ "${written}" != "true" ]]; then
            cat > "${PATCHES_DIR}/${base}" <<EOF
# This patch was a no-op after rebasing ${FROM_TAG} -> ${TO_TAG}
# (likely absorbed upstream). Review and delete this file plus its
# docs/patches.md entry if the change is no longer needed.
EOF
            dropped+="- ${base}"$'\n'
            echo "[rebase] ${base} became empty on ${TO_TAG}; wrote a no-op stub."
        fi
    done

    reset_clean "${name}" "${TO_TAG}"

    if [[ -n "${snapshot_drops}" ]]; then
        echo "[rebase] WARNING: dropped SQLite EF snapshot hunks (kept ${TO_TAG} snapshot):"
        echo "${snapshot_drops}"
        if [[ -n "${CONFLICT_REPORT}" ]]; then
            {
                echo "Dropped SQLite EF snapshot hunks (kept ${TO_TAG} snapshot; PG schema belongs in plugin migrations):"
                echo "${snapshot_drops}"
            } >> "${CONFLICT_REPORT}"
        fi
    fi

    if [[ -n "${dropped}" ]]; then
        echo "[rebase] WARNING: empty after rebase (stubs written):"
        echo "${dropped}"
        if [[ -n "${CONFLICT_REPORT}" ]]; then
            {
                echo "Empty after rebase (no-op stubs written; review and delete if absorbed upstream):"
                echo "${dropped}"
            } >> "${CONFLICT_REPORT}"
        fi
    fi

    echo "[rebase] ${name}: rebase complete."
}

if [[ "${FROM_TAG}" == "${TO_TAG}" ]]; then
    echo "[rebase] --from and --to are the same (${FROM_TAG}); nothing to do."
    exit 0
fi

cd "${REPO_ROOT}"

case "${TARGET}" in
    all)
        rebase_one_target jellyfin
        if [[ -d "${REPO_ROOT}/jellyfin-web/.git" ]] || [[ -f "${REPO_ROOT}/jellyfin-web/.git" ]]; then
            rebase_one_target jellyfin-web
        fi
        ;;
    jellyfin|jellyfin-web)
        rebase_one_target "${TARGET}"
        ;;
    *)
        echo "Unknown target: ${TARGET} (expected jellyfin, jellyfin-web, or all)" >&2
        exit 1
        ;;
esac
