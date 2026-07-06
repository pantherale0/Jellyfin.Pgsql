# Build stage
# Context hint: project root ../
# sudo docker build -t ghcr.io/jpvenson/jellyfin.pgsql:10.11.0-1 -f ./Dockerfile ../
ARG JELLYFIN_VERSION=12.0-rc2
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy project files
COPY .editorconfig .
COPY jellyfin.ruleset .
COPY Directory.Build.props .
COPY Jellyfin.Plugin.Pgsql.sln .
COPY build.yaml .
COPY .config/ ./.config/
COPY Jellyfin.Plugin.Pgsql/ ./Jellyfin.Plugin.Pgsql/

# Restore and publish
RUN dotnet restore Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj
RUN dotnet publish Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj -c Release --no-restore -o /app/publish
RUN dotnet tool restore
RUN dotnet ef migrations bundle \
    -o /app/jellyfin.PgsqlMigrator \
    -r linux-x64 \
    --self-contained \
    --project ./Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj \
    --startup-project ./Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj \
    --force \
    -- --migration-provider Jellyfin-PgSql

# Final stage - Jellyfin with plugin
FROM jellyfin/jellyfin:${JELLYFIN_VERSION}

# Install PostgreSQL 18 client tools for backup/restore functionality
RUN apt-get update && \
    apt-get install -y wget ca-certificates gnupg lsb-release && \
    wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt/ $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && \
    apt-get install -y postgresql-client-18 xmlstarlet pgloader && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy the published plugin and config files
COPY --from=build /app/publish/ /jellyfin-pgsql/plugin/
COPY --from=build /app/jellyfin.PgsqlMigrator /jellyfin-pgsql/jellyfin.PgsqlMigrator
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/database.xml /jellyfin-pgsql/database.xml
COPY docker/jellyfindb.load /jellyfin-pgsql/jellyfindb.load
COPY scripts/migrate-sqlite-to-postgres.sh /jellyfin-pgsql/migrate-sqlite-to-postgres.sh

# Make entrypoint and migration tooling executable
RUN chmod +x /entrypoint.sh /jellyfin-pgsql/migrate-sqlite-to-postgres.sh /jellyfin-pgsql/jellyfin.PgsqlMigrator

ENTRYPOINT ["/entrypoint.sh"]
