#!/usr/bin/env bash
# Sourced by sync/validate. Starts docker-compose.dev.yaml postgres when nothing
# is listening locally. Does not start Jellyfin, Keycloak, or rebuild images.
# Requires REPO_ROOT. Exports POSTGRES_HOST/PORT/DB/USER/PASSWORD.

_jf_pg_is_ci() {
    [[ "${CI:-}" == "true" ]] || [[ "${GITHUB_ACTIONS:-}" == "true" ]]
}

postgres_is_ready() {
    local host="${POSTGRES_HOST:-localhost}"
    local port="${POSTGRES_PORT:-5432}"
    (echo > "/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

_jf_pg_compose() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        echo "docker compose"
        return 0
    fi
    if command -v docker-compose >/dev/null 2>&1; then
        echo "docker-compose"
        return 0
    fi
    return 1
}

_jf_pg_wait() {
    local log="$1"
    local attempts="${2:-30}"
    local sleep_s="${3:-2}"
    local i
    for i in $(seq 1 "${attempts}"); do
        if postgres_is_ready; then
            echo "${log} PostgreSQL is ready."
            return 0
        fi
        sleep "${sleep_s}"
    done
    return 1
}

_jf_pg_apply_password() {
    if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
        export POSTGRES_PASSWORD
        return
    fi
    if _jf_pg_is_ci; then
        export POSTGRES_PASSWORD=jellyfin
    else
        # docker-compose.dev.yaml
        export POSTGRES_PASSWORD=jellyfin_secure_pass
    fi
}

# Usage: ensure_dev_postgres "[sync]"
ensure_dev_postgres() {
    local log="${1:-[postgres]}"
    local compose_file="${REPO_ROOT}/docker-compose.dev.yaml"
    local compose
    export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
    export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
    export POSTGRES_DB="${POSTGRES_DB:-jellyfin}"
    export POSTGRES_USER="${POSTGRES_USER:-jellyfin}"

    echo "${log} Checking PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT}..."
    if postgres_is_ready; then
        echo "${log} PostgreSQL is ready."
        _jf_pg_apply_password
        return 0
    fi

    if _jf_pg_is_ci; then
        echo "${log} Waiting for CI PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT}..."
        if _jf_pg_wait "${log}" 30 2; then
            _jf_pg_apply_password
            return 0
        fi
        echo "${log} ERROR: PostgreSQL not available after 30 attempts at ${POSTGRES_HOST}:${POSTGRES_PORT}." >&2
        return 1
    fi

    if [[ "${POSTGRES_HOST}" != "localhost" && "${POSTGRES_HOST}" != "127.0.0.1" ]]; then
        echo "${log} ERROR: PostgreSQL is not reachable at ${POSTGRES_HOST}:${POSTGRES_PORT}." >&2
        echo "${log}        The helper only starts local compose postgres (localhost/127.0.0.1)." >&2
        return 1
    fi

    if [[ ! -f "${compose_file}" ]]; then
        echo "${log} ERROR: PostgreSQL is not reachable and ${compose_file} is missing." >&2
        return 1
    fi

    if ! compose="$(_jf_pg_compose)"; then
        echo "${log} ERROR: PostgreSQL is not reachable and Docker Compose is not installed." >&2
        return 1
    fi

    echo "${log} Starting docker-compose.dev.yaml postgres (not the full Jellyfin stack)..."
    mkdir -p "${REPO_ROOT}/dev-env/postgres-data"
    # shellcheck disable=SC2086
    if ! ${compose} -f "${compose_file}" up -d postgres; then
        echo "${log} ERROR: failed to start the compose postgres service." >&2
        return 1
    fi

    export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-jellyfin_secure_pass}"
    echo "${log} Waiting for PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT}..."
    if _jf_pg_wait "${log}" 30 2; then
        return 0
    fi
    echo "${log} ERROR: PostgreSQL did not become ready after starting compose postgres." >&2
    return 1
}
