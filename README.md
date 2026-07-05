# The Unoffical Postgre SQL adapter for the jellyfin server

This adds postgres SQL support via an plugin to the jellyfin server. There are several steps required to make this work and it is to be considered __HIGHLY__ experimental.

# How to use it

You can use your existing jellyfin compose file and change the image accordingly to: `ghcr.io/jpvenson/jellyfin.pgsql:10.11.6-1`.

You need to add the connection paramters as enviorment variables in your compose file:

```yaml

services:
  jellyfin:
    image: ghcr.io/jpvenson/jellyfin.pgsql:10.11.6-1
    volumes:
        - /path/to/config:/config
        - /path/to/cache:/cache
        - /path/to/media:/media
    environment:
        - POSTGRES_HOST=
        - POSTGRES_PORT=
        - POSTGRES_DB=jellyfin
        - POSTGRES_USER=jellyfin
        - POSTGRES_PASSWORD=jellyfin
      # Optional settings bellow, uncomment if you want to connect using SSL
      # - POSTGRES_SSLMODE=Require
      # - POSTGRES_TRUSTSERVERCERTIFICATE=true
```

# Build

Checkout the Jellyfin submodule.
Use dotnet build to build the plugin.
Place the plugin in the plugin folder of the JF app.
Update the database.xml file to switch to the plugin as its database provider:

```xml
<?xml version="1.0" encoding="utf-8"?>
<DatabaseConfigurationOptions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <DatabaseType>PLUGIN_PROVIDER</DatabaseType>
  <CustomProviderOptions>
    <PluginAssembly>../../../Jellyfin.Plugin.Pgsql/bin/debug/net9.0/Jellyfin.Plugin.Pgsql.dll</PluginAssembly>
    <PluginName>PostgreSQL</PluginName>
    <ConnectionString>CONNECTION_STRING_TO_LOCAL_PGSQL_SERVER</ConnectionString>
  </CustomProviderOptions>
  <LockingBehavior>NoLock</LockingBehavior>
</DatabaseConfigurationOptions>

```

launch your jellyfin server.

# Add migration (manual)

Run `dotnet ef migrations add {MIGRATION_NAME} --project Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj -- --migration-provider Jellyfin-PgSql`

# Release flow

## Automated sync (recommended)

A scheduled GitHub Actions workflow ([`.github/workflows/sync-migrations.yaml`](.github/workflows/sync-migrations.yaml)) runs daily and:

1. Detects new Jellyfin releases and SQLite schema migrations via the GitHub API
2. Bumps NuGet refs, the Docker base image version, and the `jellyfin` submodule gitlink
3. Generates a PostgreSQL EF migration via model diff (SQLite migrations are **not** copied)
4. Post-processes PG-specific fixes and validates against Postgres
5. Opens a PR for human review

Docker image builds are blocked until the sync PR is merged and [`.github/jellyfin-sync-state.json`](.github/jellyfin-sync-state.json) matches the target Jellyfin version.

## Manual sync

Initialize the submodule and run the sync script locally (requires PostgreSQL, `gh`, and `jq`):

```bash
git submodule update --init jellyfin
./scripts/sync-jellyfin-migrations.sh --dry-run --version X.Y.Z   # check first
./scripts/sync-jellyfin-migrations.sh --version X.Y.Z
```

Options: `--force` to re-run when state appears current, `--dry-run` to check drift and NuGet/TFM compatibility without modifying the repo.

Major Jellyfin upgrades (e.g. 12.x) require `net10.0`, Microsoft 10.x, and updated Npgsql packages. These are managed in [`Directory.Build.props`](Directory.Build.props) (`PluginTargetFramework`, `MicrosoftPackageVersion`, etc.) and bumped automatically by the sync script — you do not need to edit the csproj manually.

The pre-flight check validates the full package graph before making any changes.

Then build the EF bundle and container:

```bash
./scripts/validate-migrations.sh
docker build -f docker/Dockerfile --build-arg JELLYFIN_VERSION=X.Y.Z -t jellyfin.pgsql .
```

# Migration Instructions (ADVANCED, UNTESTED)

To migrate your JF install to a custom database (not using the docker image) follow the steps IN THIS ORDER.

1. Download the Jellyfin PGSQL container and configure it to point to an existing empty database and empty config directory. DO NOT USE YOUR EXISTING DATA OR SQLITE LIBRARY CONFIGURE A FULLY CLEAR INSTANCE.
2. Run jellyfin once with it configured to your empty database, this will seed the database and its migration history.
3. Stop your JF instance after its been started once (no need to setup fully though the startup wizzard). If you did not get the setup wizzard you did something wrong!
4. Install the pgloader tool `apt install pgloader` or see https://pgloader.readthedocs.io/en/latest/install.html.
5. Download the [jellyfindb.load](/docker/jellyfindb.load) file
6. Adapt the `jellyfindb.load` file accordingly to point towards your old jellyfin.db and your postgres instance. See https://pgloader.readthedocs.io/en/latest/ref/sqlite.html
7. Use the load file in `jellyfindb.load` to transfer your sqlite db into the postgres db like `pgloader /jellyfin-pgsql/jellyfindb.load`.
8. Move your old Data back to the jellyfin directories
9. Start jellyfin

If you get an error regarding a missing `__EFMigrationsHistory` you did not start jellyfin with a clear state.
