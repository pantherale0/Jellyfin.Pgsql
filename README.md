# PostgreSQL adapter for Jellyfin

An experimental Jellyfin database plugin that adds PostgreSQL support. This repository is maintained independently for personal use. It was originally derived from [JPVenson/Jellyfin.Pgsql](https://github.com/JPVenson/Jellyfin.Pgsql) but is no longer tied to that project’s releases, images, or workflow.

**Status:** highly experimental — use at your own risk.

## Documentation

Deep documentation (benefits/drawbacks, architecture, features, full patch catalog, known issues) lives under [`docs/`](docs/README.md):

| Doc | Description |
|---|---|
| [Overview](docs/overview.md) | Fork purpose, benefits, and drawbacks |
| [Architecture](docs/architecture.md) | Plugins, submodules, and how patches are applied |
| [Features](docs/features.md) | Operator feature map (SSO, cache, taste, Seerr, …) |
| [Patches](docs/patches.md) | What / why / where / how for every file in `patches/` |
| [Known issues](docs/known-issues.md) | Fork tracker items and inherited Postgres caveats |

## Contributing, issues, and pull requests

Issues and pull requests on this repository are **locked to collaborators only** (primarily for automated CI/CD, such as migration sync). This is intentional: the project is not set up for open contribution via PRs or issue trackers.

If you want to discuss a bug, idea, or change, please use [GitHub Discussions](https://github.com/pantherale0/Jellyfin.Pgsql/discussions) instead.

## How to use it

Use your existing Jellyfin Compose file and point the image at this repository’s container registry:

`ghcr.io/pantherale0/jellyfin.pgsql:12.0-rc2`

Add the connection parameters as environment variables in your compose file:

```yaml
services:
  jellyfin:
    image: ghcr.io/pantherale0/jellyfin.pgsql:12.0-rc2
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
      # Optional settings below; uncomment to connect using SSL
      # - POSTGRES_SSLMODE=Require
      # - POSTGRES_TRUSTSERVERCERTIFICATE=true
```

Images are built and published automatically when a release is cut or when the scheduled sync workflow completes. See [Release flow](#release-flow) below.

## Query cache and optimisation (optional, experimental)

The plugin can cache the home-screen queries (Latest and Resume rows) and replace Jellyfin's
Latest queries with PostgreSQL-optimised versions (`DISTINCT ON` instead of nested `GROUP BY`
subqueries). Both features are enabled by default, fail open (any error falls back to the
standard Jellyfin queries), and are provided strictly as-is.

The cache stores only ordered item ID lists, keyed per user and per view, so results are never
shared across users. With the default TTLs, newly added media can take up to two minutes to
appear in the Latest row.

| Environment variable | Default | Description |
|---|---|---|
| `Pgsql_CACHE_ENABLED` | `true` | Enable query result caching |
| `Pgsql_CACHE_BACKEND` | `Redis` | `Redis`, `Memory` or `Off`. Falls back to `Memory` when no Redis connection string is configured |
| `REDIS_CONNECTION_STRING` | empty | StackExchange.Redis connection string, e.g. `redis.databases.svc.cluster.local:6379` |
| `Pgsql_CACHE_LATEST_TTL` | `120` | Latest cache TTL in seconds |
| `Pgsql_CACHE_RESUME_TTL` | `30` | Resume cache TTL in seconds; `0` disables Resume caching |
| `Pgsql_PG_OPTIMIZE_LATEST` | `true` | Master switch for PostgreSQL-optimised Latest queries |
| `Pgsql_PG_OPTIMIZE_MOVIES_LATEST` | inherit | Per-type override for movies |
| `Pgsql_PG_OPTIMIZE_TV_LATEST` | inherit | Per-type override for TV shows |
| `Pgsql_PG_OPTIMIZE_MUSIC_LATEST` | inherit | Per-type override for music |
| `Pgsql_COMMAND_TIMEOUT` | `90` | Database command timeout in seconds (Jellyfin's default of 30 is too tight for heavy library queries on large remote databases) |

Use the in-process `Memory` backend for a single Jellyfin instance; use `Redis` when running
multiple replicas or when the cache should survive container restarts.

Known trade-offs:

- The TV Latest optimisation ports Jellyfin's Season/Series container-selection logic into the
  plugin, so its behaviour must be re-checked when syncing against new Jellyfin releases.
- Cached Latest rows can lag behind library scans by up to the configured TTL.

To build the image locally instead:

```bash
docker build -f docker/Dockerfile --build-arg JELLYFIN_VERSION=12.0-rc2 -t jellyfin.pgsql .
```

## Single Sign-On (SSO) with RBAC via OAuth2/OIDC

The custom Docker image supports built-in Single Sign-On (SSO) using OpenID Connect (OIDC) / OAuth2 with Role-Based Access Control (RBAC). 

### How it works
*   **Forced SSO Redirection**: When configured, the browser client automatically redirects users to your OIDC provider for login.
*   **Emergency Bypass**: For emergency local administration (e.g. if the identity provider is offline), you can append `?local=true` to the URL (e.g. `http://jellyfin/web/index.html#!/login.html?local=true`) to bypass the redirect and show the local login form.
*   **Auto-creation & RBAC**: Users successfully authenticated via OIDC are automatically created if they do not exist. If they possess the configured OIDC admin role, they are granted Administrator privileges (and administrative permissions are synced dynamically upon each login).
*   **Parental controls & Permissions from claims**: When a birthdate claim is present, the user's max parental rating is set from their age (Jellyfin rating scores are age-aligned). Ages 18+ are unrestricted. Block-unrated item types, library access, and specific feature permissions (including **Allow Live TV Multiview**) can be assigned per OIDC group in **Dashboard → Users → SSO Mappings**.
*   **Client Compatibility**: Smart TV / webOS wrappers (and other TV browsers) skip forced SSO auto-redirect and open **Quick Connect** automatically on the login page so users can approve a code from a phone or desktop. Native surfaces that do not use the web UI can still pair with an active session via Quick Connect. Ensure Quick Connect is enabled on the server for TV deployments. `?local=true` remains the emergency bypass for non-TV browsers.

### Configuration
Configure the OIDC integration using the following environment variables in your `docker-compose.yaml`:

| Environment variable | Default | Description |
|---|---|---|
| `JELLYFIN_SSO_OIDC_AUTHORITY` | empty | The base URL of your OIDC provider (e.g., `https://keycloak.example.com/realms/master`) |
| `JELLYFIN_SSO_OIDC_CLIENT_ID` | empty | The client ID registered in your OIDC provider |
| `JELLYFIN_SSO_OIDC_CLIENT_SECRET` | empty | The client secret (optional, only if client is confidential) |
| `JELLYFIN_SSO_OIDC_REDIRECT_URI` | _(required when SSO enabled)_ | The OIDC callback URL (e.g. `https://jellyfin.example.com/sso/callback`). Must match the redirect URI registered with your IdP. |
| `JELLYFIN_SSO_OIDC_SCOPE` | `openid profile email groups` | Scopes requested from the identity provider |
| `JELLYFIN_SSO_OIDC_USERNAME_CLAIM` | `preferred_username` | The claim containing the user's Jellyfin username |
| `JELLYFIN_SSO_OIDC_ROLES_CLAIM` | `groups` | The claim containing user groups/roles |
| `JELLYFIN_SSO_OIDC_ADMIN_ROLE` | `jellyfin_admin` | The role/group name that grants Administrator privileges in Jellyfin |
| `JELLYFIN_SSO_OIDC_BIRTHDATE_CLAIM` | `birthdate` | The claim containing the user's date of birth (`YYYY-MM-DD`). Used to set max parental rating from age on each login. Missing/invalid values leave the existing rating unchanged. |
| `JELLYFIN_SSO_OIDC_CREATE_USERS` | `true` | Set to `false` to disable auto-creation of new users |

### How it is Built
To maintain a clean upstream repository, changes to the `jellyfin` server and `jellyfin-web` client are packaged as patches under [`patches/`](patches/):
1. `jellyfin_*.patch` files (e.g. [`patches/jellyfin_sso.patch`](patches/jellyfin_sso.patch)) are applied to the `jellyfin` submodule.
2. `jellyfin_web_*.patch` files (e.g. [`patches/jellyfin_web_rbac.patch`](patches/jellyfin_web_rbac.patch)) are applied to the `jellyfin-web` submodule.
3. During `docker build`, [`scripts/apply-patches.sh`](scripts/apply-patches.sh) scans `patches/` and applies every matching patch before compiling the server and web client from source.

## Build (from source)

1. Check out the Jellyfin submodule: `git submodule update --init jellyfin`
2. Build the plugin: `dotnet build`
3. Place the plugin in Jellyfin’s plugin folder.
4. Update `database.xml` to use the plugin as the database provider:

```xml
<?xml version="1.0" encoding="utf-8"?>
<DatabaseConfigurationOptions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <DatabaseType>PLUGIN_PROVIDER</DatabaseType>
  <CustomProviderOptions>
    <PluginAssembly>../../../Jellyfin.Plugin.Pgsql/bin/debug/net10.0/Jellyfin.Plugin.Pgsql.dll</PluginAssembly>
    <PluginName>PostgreSQL</PluginName>
    <ConnectionString>CONNECTION_STRING_TO_LOCAL_PGSQL_SERVER</ConnectionString>
  </CustomProviderOptions>
  <LockingBehavior>NoLock</LockingBehavior>
</DatabaseConfigurationOptions>
```

5. Start your Jellyfin server.

## Add migration (manual)

```bash
dotnet ef migrations add {MIGRATION_NAME} --project Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj -- --migration-provider Jellyfin-PgSql
```

## Release flow

### Automated sync

A scheduled GitHub Actions workflow ([`.github/workflows/sync-migrations.yaml`](.github/workflows/sync-migrations.yaml)) runs daily and:

1. Detects new Jellyfin releases and SQLite schema migrations via the GitHub API
2. Bumps NuGet refs, the Docker base image version, and both `jellyfin` / `jellyfin-web` submodule gitlinks to the same tag
3. Verifies patches apply, builds the solution against patched jellyfin (catches new API surface even when no schema migration is needed), then leaves submodules clean
4. **Only if** Jellyfin’s latest SQLite migration advanced: generates a PostgreSQL `Update_*` via model diff (SQLite migrations are **not** copied), post-processes PG-specific fixes, and validates against Postgres
5. Opens a collaborator-only PR for review and merge

Tag-only bumps (new release tag, same core migration id) skip EF so patch/fork schema is never folded into a stale `Update_*`. Fork schema changes belong in dedicated plugin migrations landed with the patch. Sync still fails the run if the plugin/tests no longer compile against the new Jellyfin APIs.

Docker image builds are blocked until the sync PR is merged and [`.github/jellyfin-sync-state.json`](.github/jellyfin-sync-state.json) matches the target Jellyfin version.

When the scheduled sync workflow fails, it automatically opens (or updates) a collaborator-only GitHub issue labeled `migration-sync-failure` with the failure stage, logs, and workflow link.

### Manual sync

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

## Migrating from SQLite to PostgreSQL

The recommended approach is the automated migration script. It backs up `jellyfin.db`, applies PostgreSQL EF migrations, copies table data with pgloader (excluding `__EFMigrationsHistory`), archives the SQLite file, and writes a completion marker so it will not run twice.

### Docker (recommended)

1. Point your existing Jellyfin `/config` volume at the container (your `jellyfin.db` should be at `/config/data/jellyfin.db`).
2. Ensure PostgreSQL is reachable via the usual `POSTGRES_*` environment variables.
3. Start the container **once** with migration enabled:

```yaml
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_DB: jellyfin
      POSTGRES_USER: jellyfin
      POSTGRES_PASSWORD: your-password
    volumes:
      - /path/to/postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - /path/to/redis-data:/data

  jellyfin:
    image: ghcr.io/pantherale0/jellyfin.pgsql:12.0-rc2
    depends_on:
      - postgres
      - redis
    environment:
      MIGRATE_FROM_SQLITE: "true"
      POSTGRES_HOST: postgres
      POSTGRES_DB: jellyfin
      POSTGRES_USER: jellyfin
      POSTGRES_PASSWORD: your-password
      Pgsql_CACHE_BACKEND: Redis
      REDIS_CONNECTION_STRING: redis:6379
    volumes:
      - /path/to/existing/config:/config
      - /path/to/cache:/cache
      - /path/to/media:/media
```

4. Watch the container logs for `[migrate]` output. On success:
   - `jellyfin.db` is renamed to `jellyfin.db.pre-pgsql.<timestamp>`
   - A backup is kept at `jellyfin.db.backup.<timestamp>`
   - `.jellyfin-pgsql-migration-complete` prevents re-running
5. Remove `MIGRATE_FROM_SQLITE` (or set it to `false`) and restart normally.

To inspect the planned steps without making changes:

```bash
docker run --rm \
  -e DRY_RUN=true \
  -e POSTGRES_HOST=postgres -e POSTGRES_DB=jellyfin \
  -e POSTGRES_USER=jellyfin -e POSTGRES_PASSWORD=secret \
  -v /path/to/config:/config \
  ghcr.io/pantherale0/jellyfin.pgsql:12.0-rc2 \
  /jellyfin-pgsql/migrate-sqlite-to-postgres.sh --dry-run --sqlite-db /config/data/jellyfin.db
```

### Manual / bare-metal

Requires `pgloader`, `pg_isready`, and an EF migration bundle (`scripts/validate-migrations.sh` builds `docker/jellyfin.PgsqlMigrator`).

```bash
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=jellyfin
export POSTGRES_USER=jellyfin
export POSTGRES_PASSWORD=your-password

./scripts/validate-migrations.sh   # builds schema tooling if needed
./scripts/migrate-sqlite-to-postgres.sh /path/to/jellyfin.db
```

Use `--dry-run` to validate configuration without modifying anything.

### Notes

- Stop Jellyfin before migrating so `jellyfin.db` is not locked.
- The PostgreSQL database should be empty before migration; the script creates the schema via EF migrations.
- If migration fails, your original database remains in the timestamped backup file.
- A reference pgloader config lives at [`docker/jellyfindb.load`](docker/jellyfindb.load); the script generates one dynamically with safer credential handling.

## Upstream

This project builds on ideas and code from [JPVenson/Jellyfin.Pgsql](https://github.com/JPVenson/Jellyfin.Pgsql). That upstream repository is separate; image tags, release cadence, and support channels there do not apply to this fork.
