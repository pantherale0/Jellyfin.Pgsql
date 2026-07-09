#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

echo "================================================================="
echo "        Jellyfin OIDC SSO & RBAC Development Environment"
echo "================================================================="

# Pre-flight Check: Host resolution for Keycloak
if ! grep -q "keycloak" /etc/hosts; then
    echo "WARNING: 'keycloak' not found in your /etc/hosts."
    echo "To test OIDC login, both the container and your web browser need"
    echo "to resolve 'keycloak'. Please run the following command:"
    echo "  echo '127.0.0.1 keycloak' | sudo tee -a /etc/hosts"
    echo "-----------------------------------------------------------------"
fi

# Create local directories for container persistence
echo "Creating local persistence directories..."
mkdir -p dev-env/config dev-env/cache dev-env/media/movies dev-env/media/tv

# Start the dev containers
echo "Starting OIDC test environment with Docker Compose..."
docker-compose -f docker-compose.dev.yaml up --build
