#!/usr/bin/env bash
# Sync PostgreSQL migrations with Jellyfin core releases.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
STATE_FILE="${REPO_ROOT}/.github/jellyfin-sync-state.json"
PROJECT="${REPO_ROOT}/Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj"
MIGRATIONS_DIR="${REPO_ROOT}/Jellyfin.Plugin.Pgsql/Migrations"
WARNINGS_FILE="${REPO_ROOT}/.sync-warnings.md"
SYNC_REPORT="${REPO_ROOT}/.sync-report.md"
SYNC_BACKUP_DIR=""
SYNC_STARTED=false
RESOLVED_NUGET_VERSION=""
RESOLVED_MICROSOFT_VERSION=""
RESOLVED_NPGSQL_VERSION=""
RESOLVED_NPGSQL_EF=""
RESOLVED_PLUGIN_TFM=""
RESOLVED_DOTNET_SDK=""
FORCE=false
TARGET_VERSION=""
DRY_RUN=false

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Sync PostgreSQL EF migrations with a Jellyfin release.

Options:
  --version VERSION   Target Jellyfin version (default: latest release)
  --force             Run sync even if state appears up to date
  --dry-run           Detect drift and report without making changes
  -h, --help          Show this help

Notes:
  Run with --dry-run first when testing a new Jellyfin version.
  TargetFramework and Microsoft/Npgsql package versions are managed via Directory.Build.props
  and are updated automatically during sync.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            TARGET_VERSION="${2#v}"
            shift 2
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
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

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "[sync] ERROR: required command not found: $1" >&2
        exit 1
    fi
}

require_cmd gh
require_cmd jq
require_cmd git
require_cmd dotnet
require_cmd sed
require_cmd curl

read_state() {
    jq -r "$1" "${STATE_FILE}"
}

fetch_latest_release() {
    gh api repos/jellyfin/jellyfin/releases/latest -q '.tag_name' | sed 's/^v//'
}

fetch_core_migrations() {
    local version="$1"
    gh api "repos/jellyfin/jellyfin/contents/src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/Migrations?ref=v${version}" \
        --paginate \
        -q '.[].name' \
        | grep -E '^[0-9]+_.*\.cs$' \
        | grep -v '\.Designer\.cs$' \
        | sort
}

latest_migration_id() {
    # Strip .cs suffix, return migration id like 20250925203415_ExtendPeopleMapKey
    echo "$1" | sed 's/\.cs$//'
}

version_gt() {
    # Returns 0 if $1 > $2 (semver-ish)
    [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" != "$1" ]]
}

migration_gt() {
    # Compare migration timestamps (first 14 digits)
    local a="${1%%_*}"
    local b="${2%%_*}"
    [[ "${a}" > "${b}" ]]
}

nuget_version_exists() {
    local package="$1"
    local version="$2"
    local package_lower
    package_lower="$(echo "${package}" | tr '[:upper:]' '[:lower:]')"
    curl -sf "https://api.nuget.org/v3-flatcontainer/${package_lower}/index.json" \
        | jq -e --arg v "${version}" '.versions | index($v)' >/dev/null
}

resolve_nuget_version() {
    local tag_version="$1"
    local candidates=()

    candidates+=("${tag_version}")
    if [[ "${tag_version}" =~ ^([0-9]+\.[0-9]+)-(.+)$ ]]; then
        candidates+=("${BASH_REMATCH[1]}.0-${BASH_REMATCH[2]}")
    fi

    local candidate
    for candidate in "${candidates[@]}"; do
        if nuget_version_exists "Jellyfin.Controller" "${candidate}"; then
            echo "${candidate}"
            return 0
        fi
    done

    echo "[sync] ERROR: no NuGet package found for Jellyfin version ${tag_version}" >&2
    echo "[sync]        Tried: ${candidates[*]}" >&2
    return 1
}

get_target_framework() {
    sed -n 's:.*<PluginTargetFramework>\([^<]*\)</PluginTargetFramework>.*:\1:p' "${REPO_ROOT}/Directory.Build.props" | head -n1
}

resolve_microsoft_package_version() {
    local nuget_version="$1"
    local version
    version="$(curl -sf "https://api.nuget.org/v3-flatcontainer/jellyfin.controller/${nuget_version}/jellyfin.controller.nuspec" \
        | grep -oP 'Microsoft\.Extensions\.Configuration\.Binder" version="\K[0-9.]+' | head -1 || true)"
    if [[ -z "${version}" ]]; then
        echo "9.0.11"
    else
        echo "${version}"
    fi
}

compute_plugin_stack() {
    local tag_version="$1"
    RESOLVED_NUGET_VERSION="$(resolve_nuget_version "${tag_version}")"
    RESOLVED_MICROSOFT_VERSION="$(resolve_microsoft_package_version "${RESOLVED_NUGET_VERSION}")"

    local major="${RESOLVED_MICROSOFT_VERSION%%.*}"
    if [[ "${major}" -ge 10 ]]; then
        RESOLVED_PLUGIN_TFM="net10.0"
        RESOLVED_DOTNET_SDK="10.0"
        RESOLVED_NPGSQL_VERSION="10.0.3"
        RESOLVED_NPGSQL_EF="10.0.2"
    else
        RESOLVED_PLUGIN_TFM="net9.0"
        RESOLVED_DOTNET_SDK="9.0"
        RESOLVED_NPGSQL_VERSION="9.0.4"
        RESOLVED_NPGSQL_EF="9.0.4"
    fi
}

update_directory_build_props() {
    local props_file="$1"
    sed -i "s/<JellyfinVersion>[^<]*<\/JellyfinVersion>/<JellyfinVersion>${RESOLVED_NUGET_VERSION}<\/JellyfinVersion>/" "${props_file}"
    sed -i "s/<MicrosoftPackageVersion>[^<]*<\/MicrosoftPackageVersion>/<MicrosoftPackageVersion>${RESOLVED_MICROSOFT_VERSION}<\/MicrosoftPackageVersion>/" "${props_file}"
    sed -i "s/<NpgsqlVersion>[^<]*<\/NpgsqlVersion>/<NpgsqlVersion>${RESOLVED_NPGSQL_VERSION}<\/NpgsqlVersion>/" "${props_file}"
    sed -i "s/<NpgsqlEfVersion>[^<]*<\/NpgsqlEfVersion>/<NpgsqlEfVersion>${RESOLVED_NPGSQL_EF}<\/NpgsqlEfVersion>/" "${props_file}"
    sed -i "s/<PluginTargetFramework>[^<]*<\/PluginTargetFramework>/<PluginTargetFramework>${RESOLVED_PLUGIN_TFM}<\/PluginTargetFramework>/" "${props_file}"
    sed -i "s/<DotNetSdkVersion>[^<]*<\/DotNetSdkVersion>/<DotNetSdkVersion>${RESOLVED_DOTNET_SDK}<\/DotNetSdkVersion>/" "${props_file}"
}

report_restore_failure() {
    local tag_version="$1"
    local restore_output="$2"

    echo "${restore_output}" >&2
    echo "[sync] ERROR: Pre-flight restore failed for Jellyfin ${tag_version} (NuGet ${RESOLVED_NUGET_VERSION})." >&2

    if echo "${restore_output}" | grep -q "NU1202"; then
        echo "[sync]        Jellyfin packages require ${RESOLVED_PLUGIN_TFM}; check PluginTargetFramework in Directory.Build.props." >&2
    elif echo "${restore_output}" | grep -q "NU1605"; then
        echo "[sync]        Package downgrade detected — Microsoft/Npgsql versions must match Jellyfin (Microsoft ${RESOLVED_MICROSOFT_VERSION})." >&2
    fi
}

preflight_check() {
    local tag_version="$1"
    compute_plugin_stack "${tag_version}"
    local tfm="${RESOLVED_PLUGIN_TFM}"
    local tmpdir
    tmpdir="$(mktemp -d)"

    echo "[sync] Pre-flight: tag v${tag_version}, NuGet ${RESOLVED_NUGET_VERSION}, TFM ${tfm}, Microsoft ${RESOLVED_MICROSOFT_VERSION}..."

    cp "${REPO_ROOT}/Directory.Build.props" "${tmpdir}/"
    cp "${REPO_ROOT}/jellyfin.ruleset" "${tmpdir}/"
    cp "${PROJECT}" "${tmpdir}/Jellyfin.Plugin.Pgsql.csproj"
    mkdir -p "${tmpdir}/Jellyfin.Plugin.Pgsql"
    mv "${tmpdir}/Jellyfin.Plugin.Pgsql.csproj" "${tmpdir}/Jellyfin.Plugin.Pgsql/"

    update_directory_build_props "${tmpdir}/Directory.Build.props"

    local restore_output
    if ! restore_output="$(dotnet restore "${tmpdir}/Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj" 2>&1)"; then
        rm -rf "${tmpdir}"
        report_restore_failure "${tag_version}" "${restore_output}"
        return 1
    fi

    rm -rf "${tmpdir}"
    echo "[sync] Pre-flight passed."
}

begin_sync_backup() {
    SYNC_BACKUP_DIR="$(mktemp -d)"
    cp "${REPO_ROOT}/Directory.Build.props" "${SYNC_BACKUP_DIR}/"
    cp "${REPO_ROOT}/docker/Dockerfile" "${SYNC_BACKUP_DIR}/"
    cp "${REPO_ROOT}/build.yaml" "${SYNC_BACKUP_DIR}/"
    cp "${STATE_FILE}" "${SYNC_BACKUP_DIR}/"
    git -C "${REPO_ROOT}/jellyfin" rev-parse HEAD > "${SYNC_BACKUP_DIR}/submodule_commit"
    SYNC_STARTED=true
}

rollback_sync() {
    if [[ "${SYNC_STARTED}" != "true" ]] || [[ -z "${SYNC_BACKUP_DIR}" ]]; then
        return
    fi

    echo "[sync] Rolling back partial changes..." >&2
    cp "${SYNC_BACKUP_DIR}/Directory.Build.props" "${REPO_ROOT}/"
    cp "${SYNC_BACKUP_DIR}/Dockerfile" "${REPO_ROOT}/docker/"
    cp "${SYNC_BACKUP_DIR}/build.yaml" "${REPO_ROOT}/"
    cp "${SYNC_BACKUP_DIR}/jellyfin-sync-state.json" "${STATE_FILE}"

    local previous_commit
    previous_commit="$(cat "${SYNC_BACKUP_DIR}/submodule_commit")"
    if [[ -d "${REPO_ROOT}/jellyfin/.git" ]] || [[ -f "${REPO_ROOT}/jellyfin/.git" ]]; then
        git -C "${REPO_ROOT}/jellyfin" checkout "${previous_commit}" >/dev/null 2>&1 || true
        git -C "${REPO_ROOT}" add jellyfin 2>/dev/null || true
    fi

    rm -rf "${SYNC_BACKUP_DIR}"
    SYNC_STARTED=false
}

on_sync_exit() {
    local exit_code=$?
    if [[ "${exit_code}" -ne 0 ]] && [[ "${SYNC_STARTED}" == "true" ]]; then
        rollback_sync
    elif [[ -n "${SYNC_BACKUP_DIR}" ]]; then
        rm -rf "${SYNC_BACKUP_DIR}"
    fi
    return "${exit_code}"
}

bump_version_refs() {
    local tag_version="$1"
    compute_plugin_stack "${tag_version}"
    echo "[sync] Bumping version refs to ${tag_version} (NuGet ${RESOLVED_NUGET_VERSION}, TFM ${RESOLVED_PLUGIN_TFM})..."

    update_directory_build_props "${REPO_ROOT}/Directory.Build.props"

    sed -i "s/^ARG JELLYFIN_VERSION=.*/ARG JELLYFIN_VERSION=${tag_version}/" \
        "${REPO_ROOT}/docker/Dockerfile"

    sed -i "s/^FROM mcr.microsoft.com\/dotnet\/sdk:[0-9.]* AS build/FROM mcr.microsoft.com\/dotnet\/sdk:${RESOLVED_DOTNET_SDK} AS build/" \
        "${REPO_ROOT}/docker/Dockerfile"

    sed -i "s/^targetAbi: \".*\"/targetAbi: \"${RESOLVED_NUGET_VERSION}.0\"/" \
        "${REPO_ROOT}/build.yaml"

    sed -i "s/^framework: \".*\"/framework: \"${RESOLVED_PLUGIN_TFM}\"/" \
        "${REPO_ROOT}/build.yaml"
}

update_submodule() {
    local version="$1"
    echo "[sync] Updating jellyfin submodule to v${version}..."

    git submodule update --init jellyfin
    git -C "${REPO_ROOT}/jellyfin" fetch --tags origin
    git -C "${REPO_ROOT}/jellyfin" checkout "v${version}"

    git add jellyfin
}

get_submodule_commit() {
    git -C "${REPO_ROOT}/jellyfin" rev-parse HEAD
}

get_latest_pg_migration() {
    local latest="" ts=0
    for file in "${MIGRATIONS_DIR}"/*.cs; do
        [[ -f "${file}" ]] || continue
        [[ "${file}" == *".Designer.cs" ]] && continue
        local base
        base="$(basename "${file}")"
        [[ "${base}" == "JellyfinDbContextModelSnapshot.cs" ]] && continue
        local prefix="${base%%_*}"
        if [[ "${prefix}" =~ ^[0-9]+$ ]] && (( prefix > ts )); then
            ts="${prefix}"
            latest="$(latest_migration_id "${base}")"
        fi
    done
    echo "${latest}"
}

remove_empty_migration() {
    if [[ ! -f "${REPO_ROOT}/.sync-empty-migration" ]]; then
        return
    fi

    echo "[sync] Removing empty migration via dotnet ef migrations remove..."
    dotnet ef migrations remove --force \
        --project "${PROJECT}" \
        -- --migration-provider Jellyfin-PgSql

    echo "- Removed empty migration (no schema diff)" >> "${SYNC_REPORT}"
    rm -f "${REPO_ROOT}/.sync-empty-migration"
}

write_state() {
    local version="$1"
    local core_migration="$2"
    local pg_migration="$3"
    local submodule_commit="$4"

    jq -n \
        --arg version "${version}" \
        --arg tag "v${version}" \
        --arg commit "${submodule_commit}" \
        --arg core "${core_migration}" \
        --arg pg "${pg_migration}" \
        '{
            jellyfinVersion: $version,
            jellyfinSubmoduleTag: $tag,
            jellyfinSubmoduleCommit: $commit,
            lastCoreMigration: $core,
            lastPgMigration: $pg
        }' > "${STATE_FILE}"
}

# --- Main ---

if [[ ! -f "${STATE_FILE}" ]]; then
    echo "[sync] ERROR: state file not found: ${STATE_FILE}" >&2
    exit 1
fi

if [[ -z "${TARGET_VERSION}" ]]; then
    TARGET_VERSION="$(fetch_latest_release)"
fi
TARGET_VERSION="${TARGET_VERSION#v}"

echo "[sync] Target Jellyfin version: ${TARGET_VERSION}"

STATE_VERSION="$(read_state '.jellyfinVersion')"
STATE_CORE="$(read_state '.lastCoreMigration')"

CORE_MIGRATIONS="$(fetch_core_migrations "${TARGET_VERSION}")"
if [[ -z "${CORE_MIGRATIONS}" ]]; then
    echo "[sync] ERROR: no core migrations found for v${TARGET_VERSION}" >&2
    exit 1
fi

LATEST_CORE_FILE="$(echo "${CORE_MIGRATIONS}" | tail -n1)"
LATEST_CORE="$(latest_migration_id "${LATEST_CORE_FILE}")"

echo "[sync] Latest core migration: ${LATEST_CORE}"
echo "[sync] State core migration:   ${STATE_CORE}"

NEEDS_SYNC=false
if version_gt "${TARGET_VERSION}" "${STATE_VERSION}"; then
    NEEDS_SYNC=true
    echo "[sync] New Jellyfin release detected (${STATE_VERSION} -> ${TARGET_VERSION})"
elif migration_gt "${LATEST_CORE}" "${STATE_CORE}"; then
    NEEDS_SYNC=true
    echo "[sync] New core migrations detected (${STATE_CORE} -> ${LATEST_CORE})"
elif [[ "${TARGET_VERSION}" != "${STATE_VERSION}" ]]; then
    NEEDS_SYNC=true
    echo "[sync] Version mismatch without newer core migrations"
fi

if [[ "${NEEDS_SYNC}" == "false" ]] && [[ "${FORCE}" == "false" ]]; then
    echo "[sync] Already up to date. Use --force to re-run."
    exit 0
fi

if [[ "${DRY_RUN}" == "true" ]]; then
    compute_plugin_stack "${TARGET_VERSION}" || exit 1
    echo "[sync] Dry run: would sync to ${TARGET_VERSION} (NuGet ${RESOLVED_NUGET_VERSION}, TFM ${RESOLVED_PLUGIN_TFM}, core: ${LATEST_CORE})"
    if ! preflight_check "${TARGET_VERSION}"; then
        echo "[sync] Dry run: pre-flight failed — no changes were made."
        exit 1
    fi
    exit 0
fi

if ! preflight_check "${TARGET_VERSION}"; then
    exit 1
fi

trap on_sync_exit EXIT

rm -f "${WARNINGS_FILE}" "${SYNC_REPORT}" "${REPO_ROOT}/.sync-empty-migration"
echo "# Migration sync report for Jellyfin ${TARGET_VERSION}" > "${SYNC_REPORT}"
echo "" >> "${SYNC_REPORT}"
echo "## New core migrations since last sync" >> "${SYNC_REPORT}"
while IFS= read -r file; do
    id="${file%.cs}"
    if migration_gt "${id}" "${STATE_CORE}"; then
        echo "- ${file}" >> "${SYNC_REPORT}"
    fi
done <<< "${CORE_MIGRATIONS}"

begin_sync_backup
bump_version_refs "${TARGET_VERSION}"
update_submodule "${TARGET_VERSION}"
SUBMODULE_COMMIT="$(get_submodule_commit)"

echo "[sync] Restoring packages..."
dotnet tool restore
dotnet restore "${REPO_ROOT}/Jellyfin.Plugin.Pgsql.sln"

MIGRATION_NAME="Update_${TARGET_VERSION//./_}"
echo "[sync] Generating migration: ${MIGRATION_NAME}..."

dotnet ef migrations add "${MIGRATION_NAME}" \
    --project "${PROJECT}" \
    -- --migration-provider Jellyfin-PgSql

bash "${SCRIPT_DIR}/postprocess-migration.sh" "${WARNINGS_FILE}"
remove_empty_migration

if [[ -f "${WARNINGS_FILE}" ]]; then
    echo "" >> "${SYNC_REPORT}"
    echo "## Warnings" >> "${SYNC_REPORT}"
    cat "${WARNINGS_FILE}" >> "${SYNC_REPORT}"
fi

bash "${SCRIPT_DIR}/validate-migrations.sh"

PG_MIGRATION="$(get_latest_pg_migration)"
write_state "${TARGET_VERSION}" "${LATEST_CORE}" "${PG_MIGRATION}" "${SUBMODULE_COMMIT}"

echo "" >> "${SYNC_REPORT}"
echo "## Result" >> "${SYNC_REPORT}"
echo "- Submodule: v${TARGET_VERSION} (${SUBMODULE_COMMIT})" >> "${SYNC_REPORT}"
echo "- PostgreSQL migration: ${PG_MIGRATION}" >> "${SYNC_REPORT}"
echo "- Validation: passed" >> "${SYNC_REPORT}"

SYNC_STARTED=false
rm -rf "${SYNC_BACKUP_DIR}"

echo "[sync] Sync complete for Jellyfin ${TARGET_VERSION}."
