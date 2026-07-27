#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

echo "================================================================="
echo "     Starting Jellyfin Dev Support Services (Postgres & Keycloak)"
echo "================================================================="

if ! grep -q "keycloak" /etc/hosts; then
    echo "WARNING: 'keycloak' not found in your /etc/hosts."
    echo "To test OIDC login, both the host and browser must resolve 'keycloak'."
    echo "Please run: echo '127.0.0.1 keycloak' | sudo tee -a /etc/hosts"
    echo "-----------------------------------------------------------------"
fi

echo "Creating local persistence directories..."
mkdir -p dev-env/config/plugins/Jellyfin.Plugin.Pgsql dev-env/cache dev-env/media/movies dev-env/media/tv

echo "Starting Postgres and Keycloak detached containers..."
docker-compose -f docker-compose.dev.yaml up postgres keycloak -d

echo "Services started! Postgres is on port 5432 and Keycloak is on port 8080."
