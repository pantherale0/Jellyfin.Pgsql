#!/bin/bash

set -euo pipefail

wait_for_config_mount() {
    local attempts=12
    local delay=5
    local i

    for i in $(seq 1 "$attempts"); do
        if mkdir -p /config/log /config/plugins 2>/dev/null \
            && touch /config/.jellyfin-pgsql-write-test 2>/dev/null \
            && rm -f /config/.jellyfin-pgsql-write-test 2>/dev/null; then
            return 0
        fi

        echo "[entrypoint] /config not writable/healthy (attempt $i/$attempts), waiting ${delay}s..."
        sleep "$delay"
    done

    echo "[entrypoint] ERROR: /config mount is not healthy inside container."
    echo "[entrypoint] /proc/self/mountinfo for /config:"
    grep ' /config\|/mnt/glusterfs' /proc/self/mountinfo || true
    return 1
}

wait_for_config_mount

sync_plugin_if_needed() {
    local src_dir="/jellyfin-pgsql/plugin"
    local dst_dir="/config/plugins/PostgreSQL"
    local plugin_file="Jellyfin.Plugin.Pgsql.dll"
    local src_file="${src_dir}/${plugin_file}"
    local dst_file="${dst_dir}/${plugin_file}"

    if [ ! -f "$src_file" ]; then
        echo "[entrypoint] ERROR: Source plugin file missing: $src_file"
        return 1
    fi

    local src_hash
    src_hash=$(sha256sum "$src_file" | awk '{print $1}')

    if [ ! -f "$dst_file" ]; then
        echo "[entrypoint] Plugin not present in /config, installing"
        rm -rf "$dst_dir"
        mkdir -p "$dst_dir"
        cp -a "${src_dir}/." "$dst_dir/"
        return 0
    fi

    local dst_hash
    dst_hash=$(sha256sum "$dst_file" | awk '{print $1}')

    if [ "$src_hash" != "$dst_hash" ]; then
        echo "[entrypoint] Plugin hash changed, updating plugin files"
        rm -rf "$dst_dir"
        mkdir -p "$dst_dir"
        cp -a "${src_dir}/." "$dst_dir/"
    else
        echo "[entrypoint] Plugin hash unchanged, skipping plugin copy"
    fi
}

sync_plugin_if_needed

# Create database.xml if it doesn't exist
if [ ! -f /config/config/database.xml ]; then
    mkdir -p /config/config
    cp /jellyfin-pgsql/database.xml /config/config/database.xml
fi

# Ensure plugin name is correct (auto-heal instead of abort)
ConfiguredPluginName="$(xmlstarlet select -t -m '//DatabaseConfigurationOptions/CustomProviderOptions/PluginName' -v . -n /config/config/database.xml || true)"
if [ "${ConfiguredPluginName}" != "PostgreSQL" ]; then
    echo "[entrypoint] PluginName is '${ConfiguredPluginName:-<empty>}' - setting to 'PostgreSQL'"
    xmlstarlet edit -L -u '//DatabaseConfigurationOptions/CustomProviderOptions/PluginName' -v 'PostgreSQL' /config/config/database.xml
fi

# Validate required env vars
missing=0
for key in POSTGRES_HOST POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD; do
    if [ -z "${!key:-}" ]; then
        echo "[entrypoint] Missing required env var: $key"
        missing=1
    fi
done

if [ "$missing" -ne 0 ]; then
    echo "[entrypoint] Please set POSTGRES_HOST, POSTGRES_DB, POSTGRES_USER and POSTGRES_PASSWORD"
    exit 3
fi

# Default port when omitted
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

# Build connection string for migration
ConnectionString="Password=${POSTGRES_PASSWORD};User ID=${POSTGRES_USER};Host=${POSTGRES_HOST};Port=${POSTGRES_PORT};Database=${POSTGRES_DB}"

# Add SSL options if provided
if [ -n "${POSTGRES_SSLMODE:-}" ]; then
    ConnectionString="${ConnectionString};SSL Mode=${POSTGRES_SSLMODE}"
fi

if [ -n "${POSTGRES_TRUSTSERVERCERTIFICATE:-}" ]; then
    ConnectionString="${ConnectionString};Trust Server Certificate=${POSTGRES_TRUSTSERVERCERTIFICATE}"
fi

# Update database.xml only when connection string has changed
CurrentConnectionString="$(xmlstarlet select -t -m '//DatabaseConfigurationOptions/CustomProviderOptions/ConnectionString' -v . -n /config/config/database.xml || true)"
if [ "${CurrentConnectionString}" != "${ConnectionString}" ]; then
    echo "[entrypoint] Updating PostgreSQL connection string in database.xml"
    xmlstarlet edit -L -u '//DatabaseConfigurationOptions/CustomProviderOptions/ConnectionString' -v "${ConnectionString}" /config/config/database.xml
else
    echo "[entrypoint] PostgreSQL connection string unchanged"
fi

# Migrate jellyfin.db if exists
# if [ ! -f /config/data/jellyfin.db ]; then

#     # run the EFbundle to migrate db to current state
#     dotnet run /jellyfin-pgsql/jellyfin.PgsqlMigrator.dll --connection "${ConnectionString}"
#     # run pgloader to move data
#     pgloader /jellyfin-pgsql/jellyfindb.load
#     # rename jellyfin db
#     mv /config/data/jellyfin.db /config/data/jellyfin.db.pgsql
# fi


# Run original Jellyfin entrypoint
exec /jellyfin/jellyfin "$@"
