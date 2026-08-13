#!/usr/bin/env bash
# Validate PostgreSQL EF migrations against a live database and build the EF bundle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT="${REPO_ROOT}/Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj"

# shellcheck source=lib-ensure-dev-postgres.sh
source "${SCRIPT_DIR}/lib-ensure-dev-postgres.sh"

cd "${REPO_ROOT}"

echo "[validate] Restoring tools and packages..."
dotnet tool restore
dotnet restore Jellyfin.Plugin.Pgsql.sln

if ! ensure_dev_postgres "[validate]"; then
    exit 1
fi

export ConnectionStrings__Default="Host=${POSTGRES_HOST};Port=${POSTGRES_PORT};Database=${POSTGRES_DB};Username=${POSTGRES_USER};Password=${POSTGRES_PASSWORD}"

echo "[validate] Applying migrations (dotnet ef database update)..."
if ! update_output="$(dotnet ef database update \
    --project "${PROJECT}" \
    -- --migration-provider Jellyfin-PgSql 2>&1)"; then
    build_output="$(dotnet build "${PROJECT}" 2>&1 || true)"
    echo "${update_output}"
    echo ""
    echo "--- dotnet build ---"
    echo "${build_output}"
    exit 1
fi
echo "${update_output}"

echo "[validate] Building EF migration bundle..."
dotnet ef migrations bundle \
    --force \
    -o "${REPO_ROOT}/docker/jellyfin.PgsqlMigrator" \
    -r linux-x64 \
    --self-contained \
    --project "${PROJECT}" \
    --startup-project "${PROJECT}" \
    -- --migration-provider Jellyfin-PgSql
chmod +x "${REPO_ROOT}/docker/jellyfin.PgsqlMigrator"

if [[ ! -f "${REPO_ROOT}/docker/jellyfin.PgsqlMigrator" ]]; then
    echo "[validate] ERROR: EF bundle was not created." >&2
    exit 1
fi

echo "[validate] All checks passed."
