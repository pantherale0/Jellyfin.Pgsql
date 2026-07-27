#!/bin/bash
set -e

# Change directory to the repository root
cd "$(dirname "$0")/.."

echo "================================================================="
echo "       Syncing & Installing Local Dev Plugins & Config"
echo "================================================================="

# Ensure directories exist
mkdir -p dev-env/config/config \
         dev-env/config/plugins/PostgreSQL \
         dev-env/config/plugins/Seerr \
         dev-env/cache

# 1. Initialize database.xml with local host settings
cat << 'EOF' > dev-env/config/config/database.xml
<?xml version="1.0" encoding="utf-8"?>
<DatabaseConfigurationOptions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <DatabaseType>PLUGIN_PROVIDER</DatabaseType>
  <CustomProviderOptions>
    <PluginAssembly>Jellyfin.Plugin.Pgsql.dll</PluginAssembly>
    <PluginName>PostgreSQL</PluginName>
    <ConnectionString>Password=jellyfin_secure_pass;User ID=jellyfin;Host=localhost;Port=5432;Database=jellyfin</ConnectionString>
  </CustomProviderOptions>
  <LockingBehavior>NoLock</LockingBehavior>
</DatabaseConfigurationOptions>
EOF

# 2. Build and publish Jellyfin.Plugin.Pgsql
echo "Building & installing Jellyfin.Plugin.Pgsql..."
dotnet publish Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj \
    -c Debug \
    -o dev-env/config/plugins/PostgreSQL \
    /property:GenerateFullPaths=true \
    /consoleloggerparameters:NoSummary

# Strip host-shared assemblies so ALC type loading doesn't conflict
rm -f dev-env/config/plugins/PostgreSQL/Jellyfin.Database.Implementations.* \
      dev-env/config/plugins/PostgreSQL/Jellyfin.CodeAnalysis.*

# 3. Build and publish Jellyfin.Plugin.Seerr
echo "Building & installing Jellyfin.Plugin.Seerr..."
dotnet publish Jellyfin.Plugin.Seerr/Jellyfin.Plugin.Seerr.csproj \
    -c Debug \
    -o dev-env/config/plugins/Seerr \
    /property:GenerateFullPaths=true \
    /consoleloggerparameters:NoSummary

# Strip host-shared assemblies for Seerr plugin
rm -f dev-env/config/plugins/Seerr/Jellyfin.Database.Implementations.* \
      dev-env/config/plugins/Seerr/Jellyfin.CodeAnalysis.* \
      dev-env/config/plugins/Seerr/Microsoft.EntityFrameworkCore.* \
      dev-env/config/plugins/Seerr/Polly.*

echo "Dev plugins & database.xml synced successfully!"
