#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

echo "================================================================="
echo "       Fast Local Jellyfin + UI Next Dev Server (Host dotnet watch)"
echo "================================================================="

# 1. Ensure support services are running
./scripts/start-dev-deps.sh

# 2. Apply server patches
./scripts/apply-patches.sh jellyfin

# 3. Sync & publish plugins (Pgsql + Seerr) and database.xml
./scripts/sync-dev-plugins.sh

# 4. Build UI Next for the local Jellyfin server
if [ ! -d "ui-next/node_modules" ]; then
    npm --prefix ui-next ci
fi
npm --prefix ui-next run build

echo "Starting Jellyfin Server with dotnet watch..."
export POSTGRES_HOST=localhost
export POSTGRES_DB=jellyfin
export POSTGRES_USER=jellyfin
export POSTGRES_PASSWORD=jellyfin_secure_pass
export JELLYFIN_CACHE_DIR="$(pwd)/dev-env/cache"
export JELLYFIN_SSO_OIDC_AUTHORITY=http://keycloak:8080/realms/jellyfin
export JELLYFIN_SSO_OIDC_CLIENT_ID=jellyfin-client
export JELLYFIN_SSO_OIDC_CLIENT_SECRET=jellyfin_secret
export JELLYFIN_SSO_OIDC_REDIRECT_URI="${JELLYFIN_SSO_OIDC_REDIRECT_URI:-http://localhost:8096/sso/callback}"
export JELLYFIN_SSO_OIDC_SCOPE="openid profile email"
export JELLYFIN_SSO_OIDC_USERNAME_CLAIM=preferred_username
export JELLYFIN_SSO_OIDC_ROLES_CLAIM=groups
export JELLYFIN_SSO_OIDC_ADMIN_ROLE=jellyfin_admin
export JELLYFIN_SSO_OIDC_BIRTHDATE_CLAIM=birthdate
export JELLYFIN_SSO_OIDC_CREATE_USERS=true

dotnet watch --project jellyfin/Jellyfin.Server/Jellyfin.Server.csproj run -p:TreatWarningsAsErrors=false -- \
    --datadir "$(pwd)/dev-env/config" \
    --cachedir "$(pwd)/dev-env/cache" \
    --webdir "$(pwd)/ui-next/dist"
