#!/bin/bash

# Clean and create plugins directory, then copy plugin
rm -rf /config/plugins/PostgreSQL
mkdir -p /config/plugins/PostgreSQL
cp -r /jellyfin-pgsql/plugin/* /config/plugins/PostgreSQL/

# Create database.xml if it doesn't exist
if [ ! -f /config/config/database.xml ]; then
    mkdir -p /config/config
    cp /jellyfin-pgsql/database.xml /config/config/database.xml
fi

# Run original Jellyfin entrypoint
exec /jellyfin/jellyfin "$@"
