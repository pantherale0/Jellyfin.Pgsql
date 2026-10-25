ARG JELLYFIN_VERSION=12.3
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a

# UI Next build stage
FROM node:24-alpine AS ui-next-build
WORKDIR /src/ui-next

ARG UI_NEXT_BUILD=unknown
ENV UI_NEXT_BUILD=${UI_NEXT_BUILD}

COPY ui-next/package.json ui-next/package-lock.json ./
RUN npm ci

COPY ui-next/index.html ./index.html
COPY ui-next/README.md ./README.md
COPY ui-next/tsconfig.json ./tsconfig.json
COPY ui-next/vite.config.ts ./vite.config.ts
COPY ui-next/src/ ./src/
COPY ui-next/tests/ ./tests/
COPY ui-next/e2e/fake-server/ ./e2e/fake-server/

# UI Next tests assert against repository sources outside ui-next/ (server
# contracts, plugin configuration, patches, CI workflow). The paths resolve
# to /src/<path>, so stage those files here before running the suite.
COPY jellyfin/MediaBrowser.Model/System/SystemInfo.cs jellyfin/MediaBrowser.Model/System/PublicSystemInfo.cs /src/jellyfin/MediaBrowser.Model/System/
COPY jellyfin/MediaBrowser.Providers/Plugins/Tmdb/Configuration/PluginConfiguration.cs /src/jellyfin/MediaBrowser.Providers/Plugins/Tmdb/Configuration/PluginConfiguration.cs
COPY Jellyfin.Plugin.Pgsql/Configuration/PluginConfiguration.cs /src/Jellyfin.Plugin.Pgsql/Configuration/PluginConfiguration.cs
COPY Jellyfin.Plugin.Seerr/Configuration/PluginConfiguration.cs /src/Jellyfin.Plugin.Seerr/Configuration/PluginConfiguration.cs
COPY patches/jellyfin_sso.patch patches/jellyfin_zz_last_admin_invariant.patch /src/patches/
COPY .github/workflows/test.yaml .github/workflows/docker.yaml /src/.github/workflows/
COPY .gitmodules /src/.gitmodules
COPY scripts/apply-patches.sh /src/scripts/apply-patches.sh
COPY docker/Dockerfile /src/docker/Dockerfile

RUN npm test && npm run build

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
    --configuration Release \
    --force \
    -- --migration-provider Jellyfin-PgSql

# Shared runtime stage - Jellyfin server and plugins
FROM jellyfin/jellyfin:${JELLYFIN_VERSION} AS runtime
ARG YTDLP_VERSION
ARG YTDLP_SHA256

# Install PostgreSQL 18 client tools for backup/restore functionality
RUN apt-get update && \
    apt-get install -y wget ca-certificates gnupg lsb-release && \
    wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt/ $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && \
    apt-get install -y postgresql-client-18 xmlstarlet pgloader && \
    wget --quiet -O /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" && \
    echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict && \
    chmod 0755 /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy custom compiled Jellyfin server
COPY --from=build /app/jellyfin-server/ /jellyfin/

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

# UI Next is the only web client served by this image.
FROM runtime AS ui-next
COPY --from=ui-next-build /src/ui-next/dist/ /jellyfin/ui-next/
ENV JELLYFIN_WEB_DIR=/jellyfin/ui-next
