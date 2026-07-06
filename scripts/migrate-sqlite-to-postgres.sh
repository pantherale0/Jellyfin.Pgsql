#!/usr/bin/env bash
# Migrate an existing Jellyfin SQLite database (jellyfin.db) into PostgreSQL.
#
# Prerequisites:
#   - pgloader
#   - PostgreSQL reachable via POSTGRES_* env vars
#   - EF migration bundle (MIGRATOR_BIN) or dotnet ef database update
#
# Environment:
#   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
#   SQLITE_DB          Path to jellyfin.db (default: ./data/jellyfin.db)
#   MIGRATOR_BIN       Path to EF migrations bundle executable
#   MIGRATION_MARKER   Skip if this file exists (default: beside jellyfin.db)
#   DRY_RUN            Set to true to print steps without executing
set -euo pipefail

log() {
    echo "[migrate] $*"
}

die() {
    echo "[migrate] ERROR: $*" >&2
    exit 1
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

usage() {
    cat <<'EOF'
Usage: migrate-sqlite-to-postgres.sh [OPTIONS] [PATH_TO_JELLYFIN.DB]

Migrate Jellyfin data from SQLite into PostgreSQL.

Options:
  --dry-run           Validate inputs and print planned steps only
  --sqlite-db PATH    SQLite database file (default: ./data/jellyfin.db)
  --migrator PATH     EF migrations bundle executable
  --help              Show this help

Environment variables:
  POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
  MIGRATE_FROM_SQLITE Set to true when invoked from the container entrypoint

The script will:
  1. Back up jellyfin.db
  2. Apply PostgreSQL EF migrations (schema + migration history)
  3. Copy table data with pgloader (excluding __EFMigrationsHistory)
  4. Rename jellyfin.db and write a completion marker
EOF
}

DRY_RUN="${DRY_RUN:-false}"
SQLITE_DB="${SQLITE_DB:-}"
MIGRATOR_BIN="${MIGRATOR_BIN:-}"
MIGRATION_MARKER="${MIGRATION_MARKER:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --sqlite-db)
            SQLITE_DB="${2:-}"
            shift 2
            ;;
        --migrator)
            MIGRATOR_BIN="${2:-}"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        -*)
            die "Unknown option: $1"
            ;;
        *)
            SQLITE_DB="$1"
            shift
            ;;
    esac
done

POSTGRES_HOST="${POSTGRES_HOST:-}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-}"
POSTGRES_USER="${POSTGRES_USER:-}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

if [[ -z "${SQLITE_DB}" ]]; then
    SQLITE_DB="./data/jellyfin.db"
fi

if [[ ! -f "${SQLITE_DB}" ]]; then
    die "SQLite database not found: ${SQLITE_DB}"
fi

SQLITE_DB="$(cd "$(dirname "${SQLITE_DB}")" && pwd)/$(basename "${SQLITE_DB}")"
SQLITE_DIR="$(dirname "${SQLITE_DB}")"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DB="${SQLITE_DIR}/jellyfin.db.backup.${TIMESTAMP}"
ARCHIVED_DB="${SQLITE_DIR}/jellyfin.db.pre-pgsql.${TIMESTAMP}"

if [[ -z "${MIGRATION_MARKER}" ]]; then
    MIGRATION_MARKER="${SQLITE_DIR}/.jellyfin-pgsql-migration-complete"
fi

if [[ -f "${MIGRATION_MARKER}" ]]; then
    log "Migration marker already present (${MIGRATION_MARKER}); skipping."
    exit 0
fi

for key in POSTGRES_HOST POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD; do
    if [[ -z "${!key:-}" ]]; then
        die "Missing required environment variable: ${key}"
    fi
done

if [[ "${DRY_RUN}" != "true" ]]; then
    require_cmd pgloader
fi

if [[ -z "${MIGRATOR_BIN}" ]]; then
    if [[ -x "./docker/jellyfin.PgsqlMigrator" ]]; then
        MIGRATOR_BIN="./docker/jellyfin.PgsqlMigrator"
    elif [[ -f "./docker/jellyfin.PgsqlMigrator.dll" ]]; then
        MIGRATOR_BIN="./docker/jellyfin.PgsqlMigrator.dll"
    elif [[ -x "/jellyfin-pgsql/jellyfin.PgsqlMigrator" ]]; then
        MIGRATOR_BIN="/jellyfin-pgsql/jellyfin.PgsqlMigrator"
    fi
fi

ConnectionString="Password=${POSTGRES_PASSWORD};User ID=${POSTGRES_USER};Host=${POSTGRES_HOST};Port=${POSTGRES_PORT};Database=${POSTGRES_DB}"
if [[ -n "${POSTGRES_SSLMODE:-}" ]]; then
    ConnectionString="${ConnectionString};SSL Mode=${POSTGRES_SSLMODE}"
fi
if [[ -n "${POSTGRES_TRUSTSERVERCERTIFICATE:-}" ]]; then
    ConnectionString="${ConnectionString};Trust Server Certificate=${POSTGRES_TRUSTSERVERCERTIFICATE}"
fi

wait_for_postgres() {
    log "Waiting for PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT}..."
    local attempt
    for attempt in $(seq 1 60); do
        if PGPASSWORD="${POSTGRES_PASSWORD}" pg_isready \
            -h "${POSTGRES_HOST}" \
            -p "${POSTGRES_PORT}" \
            -U "${POSTGRES_USER}" \
            -d "${POSTGRES_DB}" >/dev/null 2>&1; then
            log "PostgreSQL is ready."
            return 0
        fi
        sleep 2
    done
    die "PostgreSQL not available after 60 attempts."
}

run_migrator() {
    if [[ -z "${MIGRATOR_BIN}" ]]; then
        die "EF migration bundle not found. Set MIGRATOR_BIN or build one with scripts/validate-migrations.sh"
    fi

    log "Applying PostgreSQL EF migrations via ${MIGRATOR_BIN}..."
    if [[ "${MIGRATOR_BIN}" == *.dll ]]; then
        require_cmd dotnet
        dotnet "${MIGRATOR_BIN}" --connection "${ConnectionString}"
    else
        "${MIGRATOR_BIN}" --connection "${ConnectionString}"
    fi
}

write_pgloader_config() {
    local load_file="$1"
    local pgpass="${HOME}/.pgpass.migrate.${TIMESTAMP}"

    # Avoid putting passwords in the pgloader URI (handles special characters safely).
    printf '%s:%s:%s:%s:%s\n' \
        "${POSTGRES_HOST}" \
        "${POSTGRES_PORT}" \
        "${POSTGRES_DB}" \
        "${POSTGRES_USER}" \
        "${POSTGRES_PASSWORD}" > "${pgpass}"
    chmod 600 "${pgpass}"
    export PGPASSFILE="${pgpass}"

    cat > "${load_file}" <<EOF
LOAD DATABASE
     FROM sqlite://${SQLITE_DB}
     INTO postgresql://${POSTGRES_USER}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}

WITH quote identifiers,
     data only,
     truncate,
     disable triggers,
     reset sequences,
     workers = 4,
     concurrency = 1,

     cast type datetime to timestamptz drop default drop not null using zero-dates-to-null,
          type bool to boolean using tinyint-to-boolean

 EXCLUDING TABLE NAMES MATCHING '~__EFMigrationsHistory',
                             '~sqlite_sequence'

 SET work_mem to '16MB',
     maintenance_work_mem to '64MB';
EOF

    echo "${pgpass}"
}

run_pgloader() {
    local load_file pgpass
    load_file="$(mktemp /tmp/jellyfin-pgloader.XXXXXX.load)"
    pgpass="$(write_pgloader_config "${load_file}")"

    log "Copying SQLite data into PostgreSQL with pgloader..."
    if ! pgloader "${load_file}"; then
        rm -f "${load_file}"
        rm -f "${pgpass}"
        die "pgloader failed. The SQLite backup remains at ${BACKUP_DB}"
    fi

    rm -f "${load_file}"
    rm -f "${pgpass}"
    unset PGPASSFILE
}

write_marker() {
    cat > "${MIGRATION_MARKER}" <<EOF
migrated_at=${TIMESTAMP}
sqlite_backup=${BACKUP_DB}
archived_sqlite=${ARCHIVED_DB}
postgres_host=${POSTGRES_HOST}
postgres_db=${POSTGRES_DB}
EOF
}

log "SQLite source: ${SQLITE_DB}"
log "PostgreSQL target: ${POSTGRES_USER}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
log "Backup will be written to: ${BACKUP_DB}"

if [[ "${DRY_RUN}" == "true" ]]; then
    log "Dry run only — no changes made."
    exit 0
fi

require_cmd pg_isready

log "Creating SQLite backup..."
cp -a "${SQLITE_DB}" "${BACKUP_DB}"

wait_for_postgres
run_migrator
run_pgloader

log "Archiving original SQLite database..."
mv "${SQLITE_DB}" "${ARCHIVED_DB}"

write_marker
log "Migration complete."
log "  Backup:  ${BACKUP_DB}"
log "  Archive: ${ARCHIVED_DB}"
log "  Marker:  ${MIGRATION_MARKER}"
log "Start Jellyfin normally; it will use PostgreSQL via database.xml."
