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

The standard image serves UI Next at `/web`. See the [UI Next guide](ui-next/README.md) for its features, development steps, and security notes. UI Next remains experimental, and support on physical TV and wrapper devices needs testing.

## Contributing, issues, and pull requests

Issues and pull requests on this repository are **locked to collaborators only** (primarily for automated CI/CD, such as migration sync). This is intentional: the project is not set up for open contribution via PRs or issue trackers.

If you want to discuss a bug, idea, or change, please use [GitHub Discussions](https://github.com/pantherale0/Jellyfin.Pgsql/discussions) instead.

## How to use it

Use your existing Jellyfin Compose file and point the image at this repository’s container registry:

`ghcr.io/pantherale0/jellyfin.pgsql:12.3`

Add the connection parameters as environment variables in your compose file:

```yaml
services:
  jellyfin:
    image: ghcr.io/pantherale0/jellyfin.pgsql:12.3
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

Images are built and published automatically on every push to `master`, when a release is cut, or on the daily schedule when a new Jellyfin version tag is needed. See [Release flow](#release-flow) below.

### UI Next image

The normal Jellyfin-version tag and `latest` both serve UI Next at `/web`. For example, use `ghcr.io/pantherale0/jellyfin.pgsql:12.3`. UI Next remains experimental, so test it on target devices before deployment.

In the official Jellyfin Android app, enable ExoPlayer to hand supported video playback to the native player. UI Next verifies that the app uses the same server and user before handing playback over. The Android app then owns the playback controls. On webOS, UI Next uses HTML video and the TV media pipeline when available. Other TV and wrapper behavior remains unverified.

Android native handoff requires a Jellyfin Android build that includes the companion `NativePlayer.syncSession` bridge; unmodified releases fall back to UI Next's browser player.

To confirm a deployment serves the expected frontend, compare the image digest with the profile menu build revision. The menu shows the short commit the image was built from:

```bash
  docker inspect ghcr.io/pantherale0/jellyfin.pgsql:12.3 --format '{{.RepoDigests}}'
```

## Query cache and optimisation (optional, experimental)

The plugin can cache the home-screen queries (Latest and Resume rows), stable library
browse `/Items` pages, and replace Jellyfin's Latest and supported Resume queries with PostgreSQL-optimised
versions. Latest uses `DISTINCT ON`; Resume starts from the user's in-progress items instead of scanning the video library. These features are enabled
by default, fail open (any error falls back to the standard Jellyfin queries), and are
provided strictly as-is.

The cache stores only ordered item ID lists, keyed per user and per view, so results are never
shared across users. With the default TTLs, newly added media can take up to two minutes to
appear in the Latest row.

| Environment variable | Default | Description |
|---|---|---|
| `Pgsql_CACHE_ENABLED` | `true` | Enable query result caching |
| `Pgsql_CACHE_BACKEND` | `Redis` | `Redis`, `Memory` or `Off`. Falls back to `Memory` when no Redis connection string is configured |
| `REDIS_CONNECTION_STRING` | empty | StackExchange.Redis connection string, e.g. `redis.databases.svc.cluster.local:6379` |
| `Pgsql_REDIS_OPERATION_TIMEOUT_MS` | `250` | Redis cache-operation timeout in milliseconds (clamped to 50–5000); a timeout fails open to memory until the health probe recovers |
| `Pgsql_CACHE_LATEST_TTL` | `120` | Latest cache TTL in seconds |
| `Pgsql_CACHE_RESUME_TTL` | `30` | Resume cache TTL in seconds; `0` disables Resume caching |
| `Pgsql_CACHE_BROWSE_TTL` | `60` | Library browse `/Items` page cache TTL in seconds; `0` disables browse caching |
| `Pgsql_PG_OPTIMIZE_LATEST` | `true` | Master switch for PostgreSQL-optimised Latest queries |
| `Pgsql_PG_OPTIMIZE_MOVIES_LATEST` | inherit | Per-type override for movies |
| `Pgsql_PG_OPTIMIZE_TV_LATEST` | inherit | Per-type override for TV shows |
| `Pgsql_PG_OPTIMIZE_MUSIC_LATEST` | inherit | Per-type override for music |
| `Pgsql_PG_OPTIMIZE_RESUME` | `true` | Enable candidate-first Resume selection independently of cache settings; overrides plugin `OptimizeResumeQueries`. Restart after changing this setting |
| `Pgsql_COMMAND_TIMEOUT` | `90` | Database command timeout in seconds (Jellyfin's default of 30 is too tight for heavy library queries on large remote databases) |

Use the in-process `Memory` backend for a single Jellyfin instance; use `Redis` when running
multiple replicas or when the cache should survive container restarts. Redis keeps one shared
multiplexer with background health probes: home APIs only hit Redis when status is `Ready`,
otherwise they fail fast to the memory fallback (no per-request timeout wait). The default
250 ms operation deadline avoids false cache-health flapping under short local Redis stalls while
keeping the first request after a real failure bounded.

Known trade-offs:

- Resume optimisation supports DatePlayed descending requests, including counted pages. It preserves library, parental, tag, and item restrictions through Jellyfin's query helpers, then loads details only for the selected IDs. Search, other sorting, unsupported criteria, and any in-progress folder candidate use the standard repository. An offset beyond the last item still returns the full eligible total when requested.
- The TV Latest optimisation ports Jellyfin's Season/Series container-selection logic into the
  plugin, so its behaviour must be re-checked when syncing against new Jellyfin releases.
- Cached Latest rows can lag behind library scans by up to the configured TTL.

### Active-standby HA (optional)

Opt-in single-writer failover. Off by default. When enabled, this process takes a PostgreSQL advisory lock; only the lock holder is Ready (`GET /health/ready`) and runs library watchers, scheduled tasks, and Live TV recording timers. `GET /health` stays a liveness check (database reachable) so a standby is not killed.

Keep `/config` on one writer (or set `JELLYFIN_SERVER_ID` so both pods share the same SystemId). Redis is **not** used for election; extract Redis from the Jellyfin pod if you want progress overlay across failover.

| Environment variable | Default | Description |
|---|---|---|
| `Pgsql_HA_ENABLED` | `false` | Enable active-standby leadership |
| `Pgsql_HA_LOCK_KEY` | `738462901` | PostgreSQL advisory lock key for leadership |
| `Pgsql_HA_HEARTBEAT_SECONDS` | `5` | Leadership connection heartbeat interval |
| `JELLYFIN_SERVER_ID` | empty | Optional stable server GUID (`device.txt`); use the same value on every replica |

When HA is enabled, point k8s **readiness** at `/health/ready` (not `/health`). In-flight TCP streams still drop; HLS VOD/remux can resume from the next segment request; Live TV returns `LiveStreamFenced` (503) and the client should restart playback.

Every response carries `X-Jellyfin-Ha-Role` (`single`, `leader` or `standby`) and `X-Jellyfin-Leader-Epoch`; both are listed in `Access-Control-Expose-Headers` for cross-origin requests. If a reverse proxy rewrites CORS headers, keep them exposed so a separately hosted UI Next can read them. Administrators can see the role, epoch, instance host name, leader-since time and heartbeat in `GET /Pgsql/Stats`, and in the UI Next admin top bar and Overview "High availability" card. Without readable headers the card falls back to stats and says so.

To build the image locally instead:

```bash
docker build -f docker/Dockerfile --build-arg JELLYFIN_VERSION=12.3 -t jellyfin.pgsql .
```

## Remote YouTube trailers

The plugin resolves remote YouTube trailers with the pinned yt-dlp binary and relays the
bytes through a Jellyfin endpoint that supports seeking and HTTP Range requests.
This consumes Jellyfin server bandwidth. On the UI Next detail page, **Watch trailer**
uses a clapperboard icon and starts the first supported YouTube trailer in metadata order.
Playback stays in UI Next, including on TV clients, and Back or trailer completion returns
to the title. Favorite is a compact heart toggle beside the playback actions.

Trailer playback—both local trailer files and remote YouTube trailers—is deliberately
excluded from resume state, played status, playback statistics, and taste/neural
recommendation inputs.

When YouTube exposes separate adaptive tracks, Jellyfin's configured ffmpeg streams
fragmented MP4 as it receives media. The relay buffers only the MP4 initialization section
to set movie and track durations from yt-dlp metadata, then sends that header before the
fragments. Playback can start while ffmpeg is still receiving the trailer; the server does
not wait for a complete file. Adaptive trailers do not support HTTP byte-range seeking, but
the browser can seek within media it has buffered. Progressive sources retain normal HTTP
Range support.

Adaptive relay limits are four concurrent remuxes, a 1 MiB initialization section, and a
64 MiB output stream per trailer. Adaptive playback requires yt-dlp to report a finite
duration. The server does not write adaptive trailer files to disk.

The published image includes pinned yt-dlp and Deno releases. Deno supplies the JavaScript
runtime yt-dlp needs to solve YouTube player challenges. Standalone plugin installations
must put yt-dlp and Deno 2.3 or later on the Jellyfin process `PATH`; set `Pgsql_YTDLP_PATH`
to an alternate yt-dlp executable when needed. Changes require a restart. Private, age-restricted,
authenticated, and geo-bypassed YouTube playback is not supported.

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
| `JELLYFIN_SSO_UI_RETURN_URLS` | empty | Comma-separated UI addresses allowed to receive a one-time SSO code (e.g. `https://ui.example.com/,https://jellyfin.example.com/jellyfin/web/`). Needed for UI Next on a separate origin or under a custom base path. `https` only (`http` for localhost); a return address matches when scheme, host and port are equal and its path is under the listed path. |

Sign-in must start on the same host as `JELLYFIN_SSO_OIDC_REDIRECT_URI`: the login sets a short-lived `jellyfin_sso_state` cookie that the callback must receive, so starting from a LAN address while the redirect URI uses a public domain fails with "This sign-in was not started in this browser". Sign-ins must also complete within 10 minutes.

UI Next on a separate origin (or a custom base path) uses a one-time code. List its address in `JELLYFIN_SSO_UI_RETURN_URLS`: `/sso/config?returnUrl=` then reports `codeExchange: true`, the callback redirects to that address with `#sso_code=...` (single use, valid 60 seconds), and UI Next redeems it with `POST /sso/exchange` together with a PKCE-style verifier only that tab holds. The token never appears in a URL. A separate UI origin must also be listed in Jellyfin's CORS hosts. Without an allowlisted address, the same-origin callback returns to `<BaseUrl>/web/index.html`; the server serves UI Next there.

Startup environment logging redacts values whose names indicate credentials (including secrets, passwords, tokens, API keys, private keys, and connection strings). This only protects future logs: rotate any credential that appeared in logs produced by an older image.

### How the image is built

Server changes are stored as `jellyfin_*.patch` files in [`patches/`](patches/) and applied to the `jellyfin` submodule by [`scripts/apply-patches.sh`](scripts/apply-patches.sh). Docker builds the patched server and plugins, builds UI Next from `ui-next/`, and sets `JELLYFIN_WEB_DIR=/jellyfin/ui-next`.

## Local Development & Debugging (Fast Loop)

Instead of running full Docker image builds (`start-dev.sh`), use the fast local workflow:

1. **Start Dev Support Services (Postgres & Keycloak detached):**
   ```bash
   ./scripts/start-dev-deps.sh
   ```
2. **VS Code Debugging (Host Server):**
   Press `F5` or select **"Launch Jellyfin Server (Host Debug)"** in VS Code. It automatically builds `Jellyfin.Plugin.Pgsql`, installs it to `dev-env/config/plugins/`, and starts debugging with pre-configured Postgres and OIDC environment variables.
3. **CLI Backend Watch (Auto-restart on C# save):**
   ```bash
   ./scripts/dev-backend.sh
   ```
4. **UI Next dev server (instant HMR on frontend save):**
   ```bash
   npm --prefix ui-next run dev
   ```

## Build (from source)

1. Check out the Jellyfin submodule: `git submodule update --init jellyfin`.
2. Build UI Next with `npm --prefix ui-next ci && npm --prefix ui-next run build`.
3. Build the plugin with `dotnet build` and place it in Jellyfin's plugin folder.
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
dotnet ef migrations add {MIGRATION_NAME} --project Jellyfin.Plugin.Pgsql/Jellyfin.Plugin.Pgsql.csproj --configuration Release -- --migration-provider Jellyfin-PgSql
```

## Release flow

### Automated sync

A scheduled GitHub Actions workflow ([`.github/workflows/sync-migrations.yaml`](.github/workflows/sync-migrations.yaml)) runs daily and:

1. Detects new Jellyfin releases and SQLite schema migrations via the GitHub API
2. Bumps NuGet refs, the Docker base image version, and the `jellyfin` server submodule gitlink
3. Rebases server patches from the previous tag onto the new one (`scripts/rebase-patches.sh`), verifies they apply, builds the four plugin and test projects individually in Release against patched Jellyfin, then leaves the server submodule clean
4. **Only if** Jellyfin’s latest SQLite migration advanced: generates a PostgreSQL `Update_*` via model diff (SQLite migrations are **not** copied), post-processes PG-specific fixes, and validates against Postgres
5. Opens a collaborator-only PR for review and merge

Tag-only bumps (new release tag, same core migration id) skip EF so patch/fork schema is never folded into a stale `Update_*`. Fork schema changes belong in dedicated plugin migrations landed with the patch. Sync still fails the run if the plugin/tests no longer compile against the new Jellyfin APIs.

Docker image builds are blocked until the sync PR is merged and [`.github/jellyfin-sync-state.json`](.github/jellyfin-sync-state.json) matches the target Jellyfin version. After that, every push to `master` rebuilds and republishes the image for the pinned Jellyfin version (overwriting the existing `:tag` and `:latest` on GHCR). The daily schedule still builds when a new Jellyfin version tag does not yet exist in the registry.

When the scheduled sync workflow fails, it automatically opens (or updates) a collaborator-only GitHub issue labeled `migration-sync-failure` with the failure stage, logs, and workflow link.

### Manual sync

Initialize the submodule and run the sync script locally (requires `gh`, `jq`, and Docker Compose when generating `Update_*`). If core SQLite migrations advanced, sync starts `docker-compose.dev.yaml` **postgres** (not the full Jellyfin stack) when nothing is listening, then generates and validates `Update_*`.

```bash
git submodule update --init jellyfin
./scripts/sync-jellyfin-migrations.sh --dry-run --version X.Y.Z   # check first
./scripts/sync-jellyfin-migrations.sh --version X.Y.Z
```

CI already provides Postgres (`POSTGRES_PASSWORD=jellyfin`). Local compose uses `jellyfin_secure_pass`. Override `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_PASSWORD` if your database is not that default.

Options: `--force` to re-run when state appears current, `--dry-run` to check drift and NuGet/TFM compatibility without modifying the repo, and `--skip-rebase` to leave `patches/` unchanged (apply-only, old behaviour).

Standalone patch rebase (same machinery sync uses):

```bash
./scripts/rebase-patches.sh --from v12.0-rc6 --to v12.0-rc7
```

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
    image: ghcr.io/pantherale0/jellyfin.pgsql:12.3
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
  ghcr.io/pantherale0/jellyfin.pgsql:12.3 \
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
