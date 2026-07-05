#!/usr/bin/env bash
# Post-process EF migration files for PostgreSQL compatibility.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/Jellyfin.Plugin.Pgsql/Migrations"
WARNINGS_FILE="${1:-}"

log_warning() {
    local msg="$1"
    echo "[postprocess] WARNING: ${msg}" >&2
    if [[ -n "${WARNINGS_FILE}" ]]; then
        echo "- ${msg}" >> "${WARNINGS_FILE}"
    fi
}

fix_filter_syntax() {
    local file="$1"
    if [[ ! -f "${file}" ]]; then
        return
    fi

    # SQLite-style [Column] -> PostgreSQL "Column" in filter expressions
    sed -i 's/\.HasFilter("\[\([^]]*\)\] IS NOT NULL")/.HasFilter("\"\\1\" IS NOT NULL")/g' "${file}"
    sed -i 's/filter: "\[\([^]]*\)\] IS NOT NULL"/filter: "\"\\1\" IS NOT NULL"/g' "${file}"
}

scan_sqlite_only_migration() {
    local file="$1"
    if [[ ! -f "${file}" ]] || [[ "${file}" == *".Designer.cs" ]]; then
        return 0
    fi

    if grep -qE 'PRAGMA|journal_mode|Sqlite|AUTOINCREMENT' "${file}"; then
        log_warning "SQLite-specific SQL found in $(basename "${file}")"
    fi

    # Migration with only raw SQL and no portable MigrationBuilder ops
    if grep -q 'migrationBuilder\.Sql(' "${file}" && \
       ! grep -qE 'migrationBuilder\.(Create|Drop|Alter|Add|Rename)' "${file}"; then
        log_warning "Migration $(basename "${file}") appears SQLite-only (raw Sql only)"
        return 1
    fi

    return 0
}

is_empty_migration() {
    local file="$1"
    if [[ ! -f "${file}" ]] || [[ "${file}" == *".Designer.cs" ]]; then
        return 1
    fi

    # Up method with no operations between braces (excluding comments/whitespace)
    local body
    body="$(sed -n '/protected override void Up(/,/protected override void Down(/p' "${file}" | head -n -1 | tail -n +2)"
    body="$(echo "${body}" | sed '/^[[:space:]]*\/\//d' | sed '/^[[:space:]]*$/d')"
    [[ -z "${body}" ]]
}

if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
    echo "[postprocess] Migrations directory not found: ${MIGRATIONS_DIR}" >&2
    exit 1
fi

echo "[postprocess] Fixing PostgreSQL filter syntax..."
while IFS= read -r -d '' file; do
    fix_filter_syntax "${file}"
done < <(find "${MIGRATIONS_DIR}" -name '*.cs' -print0)

echo "[postprocess] Scanning for SQLite-only migrations..."
latest_migration=""
latest_ts=0
for file in "${MIGRATIONS_DIR}"/*.cs; do
    [[ -f "${file}" ]] || continue
    [[ "${file}" == *".Designer.cs" ]] && continue
    [[ "$(basename "${file}")" == "JellyfinDbContextModelSnapshot.cs" ]] && continue

    basename_file="$(basename "${file}")"
    ts="${basename_file%%_*}"
    if [[ "${ts}" =~ ^[0-9]+$ ]] && (( ts > latest_ts )); then
        latest_ts="${ts}"
        latest_migration="${file}"
    fi
done

if [[ -n "${latest_migration}" ]]; then
    scan_sqlite_only_migration "${latest_migration}" || true

    if is_empty_migration "${latest_migration}"; then
        log_warning "Latest migration $(basename "${latest_migration}") has empty Up() — marking for removal"
        echo "${latest_migration}" > "${REPO_ROOT}/.sync-empty-migration"
        designer="${latest_migration%.cs}.Designer.cs"
        if [[ -f "${designer}" ]]; then
            echo "${designer}" >> "${REPO_ROOT}/.sync-empty-migration"
        fi
    fi
fi

echo "[postprocess] Done."
