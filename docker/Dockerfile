ARG JELLYFIN_VERSION=12.0-rc7

# Web build stage
FROM node:24-alpine AS web-build
WORKDIR /src

# Install git
RUN apk add --no-cache git

# Copy web submodule, patches, and apply-patches helper
COPY jellyfin-web/ ./jellyfin-web/
COPY patches/ ./patches/
COPY scripts/apply-patches.sh ./scripts/apply-patches.sh

# Apply all jellyfin-web patches and build web client
RUN chmod +x scripts/apply-patches.sh && \
    scripts/apply-patches.sh jellyfin-web && \
    cd jellyfin-web && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-timeout 300000 && \
    npm ci && \
    npm run build:production

# Build stage
# Context hint: project root ../
# sudo docker build -t ghcr.io/jpvenson/jellyfin.pgsql:10.11.0-1 -f ./Dockerfile ../
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
COPY Jellyfin.Plugin.Seerr/ ./Jellyfin.Plugin.Seerr/
COPY jellyfin/ ./jellyfin/
COPY patches/ ./patches/
COPY scripts/apply-patches.sh ./scripts/apply-patches.sh

# Install git and apply all jellyfin server patches
RUN apt-get update && apt-get install -y git && \
    chmod +x scripts/apply-patches.sh && \
    scripts/apply-patches.sh jellyfin && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Restore and publish
RUN dotnet restore Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj
RUN dotnet restore Jellyfin.Plugin.Seerr/Jellyfin.Plugin.Seerr.csproj
RUN dotnet restore jellyfin/Jellyfin.Server/Jellyfin.Server.csproj -r linux-x64 -p:AllowMissingPrunePackageData=true
RUN dotnet publish Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj -c Release --no-restore -o /app/publish
RUN dotnet publish Jellyfin.Plugin.Seerr/Jellyfin.Plugin.Seerr.csproj -c Release --no-restore -o /app/publish-seerr
# Host-shared Jellyfin assemblies must not ship in the plugin folder. PluginManager
# LoadFromAssemblyPath's every DLL into the plugin ALC; a private
# Jellyfin.Database.Implementations makes entity types (e.g. User on GetIsPlayed)
# diverge from the host and fails plugin load with ReflectionTypeLoadException.
RUN rm -f /app/publish/Jellyfin.Database.Implementations.* \
        /app/publish/Jellyfin.CodeAnalysis.* \
        /app/publish-seerr/Jellyfin.Database.Implementations.* \
        /app/publish-seerr/Jellyfin.CodeAnalysis.* \
        /app/publish-seerr/Microsoft.EntityFrameworkCore.* \
        /app/publish-seerr/Polly.*
RUN dotnet publish jellyfin/Jellyfin.Server/Jellyfin.Server.csproj -c Release --no-restore -o /app/jellyfin-server -r linux-x64 --self-contained true -p:AllowMissingPrunePackageData=true
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

# Copy custom compiled Jellyfin web client
COPY --from=web-build /src/jellyfin-web/dist/ /jellyfin/jellyfin-web/

# Copy custom compiled Jellyfin server
COPY --from=build /app/jellyfin-server/ /jellyfin/

# Inject SSO script into index.html
RUN sed -i 's|</body>|<script src="/sso/login-script.js"></script></body>|g' /jellyfin/jellyfin-web/index.html

# Copy the published plugin and config files
COPY --from=build /app/publish/ /jellyfin-pgsql/plugin/
COPY --from=build /app/publish-seerr/ /jellyfin-pgsql/plugin-seerr/
COPY --from=build /app/jellyfin.PgsqlMigrator /jellyfin-pgsql/jellyfin.PgsqlMigrator
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/database.xml /jellyfin-pgsql/database.xml
COPY docker/jellyfindb.load /jellyfin-pgsql/jellyfindb.load
COPY scripts/migrate-sqlite-to-postgres.sh /jellyfin-pgsql/migrate-sqlite-to-postgres.sh

# Make entrypoint and migration tooling executable
RUN chmod +x /entrypoint.sh /jellyfin-pgsql/migrate-sqlite-to-postgres.sh /jellyfin-pgsql/jellyfin.PgsqlMigrator

ENTRYPOINT ["/entrypoint.sh"]
