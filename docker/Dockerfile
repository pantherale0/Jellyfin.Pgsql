ARG JELLYFIN_VERSION=12.0-rc2

# Web build stage
FROM node:24-alpine AS web-build
WORKDIR /src

# Install git
RUN apk add --no-cache git

# Copy web submodule and patch
COPY jellyfin-web/ ./jellyfin-web/
COPY docker/jellyfin_web_rbac.patch ./docker/

# Apply patch and build web client
RUN git apply --directory=jellyfin-web docker/jellyfin_web_rbac.patch && \
    cd jellyfin-web && \
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
COPY jellyfin/ ./jellyfin/
COPY docker/jellyfin_sso.patch ./docker/

# Install git and apply the patch to the jellyfin submodule
RUN apt-get update && apt-get install -y git && \
    git apply --directory=jellyfin docker/jellyfin_sso.patch && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Restore and publish
RUN dotnet restore Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj
RUN dotnet restore jellyfin/Jellyfin.Server/Jellyfin.Server.csproj -r linux-x64 -p:AllowMissingPrunePackageData=true
RUN dotnet publish Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj -c Release --no-restore -o /app/publish
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
COPY --from=build /app/jellyfin.PgsqlMigrator /jellyfin-pgsql/jellyfin.PgsqlMigrator
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/database.xml /jellyfin-pgsql/database.xml
COPY docker/jellyfindb.load /jellyfin-pgsql/jellyfindb.load
COPY scripts/migrate-sqlite-to-postgres.sh /jellyfin-pgsql/migrate-sqlite-to-postgres.sh

# Make entrypoint and migration tooling executable
RUN chmod +x /entrypoint.sh /jellyfin-pgsql/migrate-sqlite-to-postgres.sh /jellyfin-pgsql/jellyfin.PgsqlMigrator

ENTRYPOINT ["/entrypoint.sh"]
