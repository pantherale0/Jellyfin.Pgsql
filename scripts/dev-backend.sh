#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

echo "================================================================="
echo "       Fast Local Jellyfin Backend Dev Server (Host dotnet watch)"
echo "================================================================="

# Ensure support services are running
./scripts/start-dev-deps.sh

echo "Applying server patches to jellyfin submodule..."
./scripts/apply-patches.sh jellyfin

echo "Building and copying Jellyfin.Plugin.Pgsql..."
dotnet publish --configuration=Debug Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj /property:GenerateFullPaths=true /consoleloggerparameters:NoSummary
mkdir -p dev-env/config/plugins/PostgreSQL dev-env/config/plugins/Jellyfin.Plugin.Pgsql
cp -r ./Jellyfin.Plugin.Pgsql/bin/Debug/net10.0/publish/* dev-env/config/plugins/PostgreSQL/
cp -r ./Jellyfin.Plugin.Pgsql/bin/Debug/net10.0/publish/* dev-env/config/plugins/Jellyfin.Plugin.Pgsql/

echo "Starting Jellyfin Server with dotnet watch..."
export POSTGRES_HOST=localhost
export POSTGRES_DB=jellyfin
export POSTGRES_USER=jellyfin
export POSTGRES_PASSWORD=jellyfin_secure_pass
export JELLYFIN_CACHE_DIR="$(pwd)/dev-env/cache"
export JELLYFIN_SSO_OIDC_AUTHORITY=http://keycloak:8080/realms/jellyfin
export JELLYFIN_SSO_OIDC_CLIENT_ID=jellyfin-client
export JELLYFIN_SSO_OIDC_CLIENT_SECRET=jellyfin_secret
export JELLYFIN_SSO_OIDC_REDIRECT_URI=http://localhost:8096/sso/callback
export JELLYFIN_SSO_OIDC_SCOPE="openid profile email"
export JELLYFIN_SSO_OIDC_USERNAME_CLAIM=preferred_username
export JELLYFIN_SSO_OIDC_ROLES_CLAIM=groups
export JELLYFIN_SSO_OIDC_ADMIN_ROLE=jellyfin_admin
export JELLYFIN_SSO_OIDC_BIRTHDATE_CLAIM=birthdate
export JELLYFIN_SSO_OIDC_CREATE_USERS=true

dotnet watch --project jellyfin/Jellyfin.Server/Jellyfin.Server.csproj run -p:TreatWarningsAsErrors=false -- \
    --datadir "$(pwd)/dev-env/config" \
    --cachedir "$(pwd)/dev-env/cache" \
    --webdir "$(pwd)/jellyfin-web/dist"
