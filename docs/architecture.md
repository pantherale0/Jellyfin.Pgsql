# Architecture

How this repository builds a PostgreSQL-backed Jellyfin image without committing edits into the upstream submodules.

## Repository map

| Path | Role |
|---|---|
| [`Jellyfin.Plugin.Pgsql/`](../Jellyfin.Plugin.Pgsql/) | PostgreSQL EF provider, migrations, query cache, fuzzy search, taste, Emby import, admin APIs |
| [`Jellyfin.Plugin.Seerr/`](../Jellyfin.Plugin.Seerr/) | Seerr/Jellyseerr client plugin (search, request, parental filtering) |
| [`jellyfin/`](../jellyfin/), [`jellyfin-web/`](../jellyfin-web/) | Upstream git submodules — **patch targets only**; keep working trees clean of committed local edits |
| [`patches/`](../patches/) | All server/web customizations as flat `*.patch` files |
| [`scripts/apply-patches.sh`](../scripts/apply-patches.sh) | Routes and applies patches by filename |
| [`scripts/sync-jellyfin-migrations.sh`](../scripts/sync-jellyfin-migrations.sh) | Align plugin EF migrations with a Jellyfin release |
| [`scripts/start-dev.sh`](../scripts/start-dev.sh) | Local OIDC/RBAC stack via `docker-compose.dev.yaml` |
| [`docker/`](../docker/) | Production image build (Dockerfile, entrypoint, migrator) |

Agent-oriented rules (never commit submodule dirt, auth checklist, JSON casing) live in [`AGENTS.md`](../AGENTS.md).

## Patch routing and apply order

[`scripts/apply-patches.sh`](../scripts/apply-patches.sh) takes a target (`jellyfin` or `jellyfin-web`) and applies matching files from `patches/`:

| Filename pattern | Applied to |
|---|---|
| `jellyfin_web*.patch` | `jellyfin-web/` |
| `jellyfin_*.patch` or `jellyfin.patch` | `jellyfin/` (web names excluded) |

**Web is matched first.** A name starting with `jellyfin_web` is never applied to core.

Patches are applied in **lexicographic order** (`ls | sort`). Prefixes encode layering:

- Unprefixed thematic names apply in alphabetical order among themselves.
- `jellyfin_z_*` / `jellyfin_web_z_*` run late so they can edit files already touched by earlier patches.
- `jellyfin_zz_*` / `jellyfin_web_zz_*` run last (for example person identity, Emby import UI).

Some patches document explicit prerequisites in a `#` preamble (for example Live TV probe after stream buffer). Those comments are authoritative when refreshing patches.

```bash
# Used by Docker / CI
./scripts/apply-patches.sh jellyfin
./scripts/apply-patches.sh jellyfin-web

# After editing a clean submodule checkout
git -C jellyfin diff > patches/jellyfin_<name>.patch
git -C jellyfin-web diff > patches/jellyfin_web_<name>.patch
git -C jellyfin checkout -- .
git -C jellyfin-web checkout -- .
```

## Build composition

```mermaid
flowchart LR
  patches[patches/*.patch]
  apply[apply-patches.sh]
  core[jellyfin submodule]
  web[jellyfin-web submodule]
  plugin[Jellyfin.Plugin.Pgsql]
  seerr[Jellyfin.Plugin.Seerr]
  image[ghcr image]
  patches --> apply
  apply --> core
  apply --> web
  core --> image
  web --> image
  plugin --> image
  seerr --> image
```

During `docker build` ([`docker/Dockerfile`](../docker/Dockerfile)):

1. Submodules are checked out at the pinned Jellyfin tag (server and web stay on the **same** feature/release tag).
2. `apply-patches.sh` runs for web (web-build stage) and for server (build stage).
3. Patched sources are compiled; plugins are packaged into the image.
4. Entrypoint wires `POSTGRES_*` / optional Redis / optional SSO env vars and can run SQLite→PG migration.

CI workflows (build, test, publish) apply jellyfin patches the same way.

**Migration sync and patches:** fork schema (playback activity, taste entities, people provider key, indexes, …) belongs in **dedicated** plugin migrations authored with the patch. Sync does **not** use `Update_*` to capture patch schema. On each sync it applies server patches, builds the solution (API surface check), optionally generates `Update_*` when core SQLite migrations advanced, then resets the submodule.

## Plugin modules (high level)

Inside `Jellyfin.Plugin.Pgsql`:

| Area | Responsibility |
|---|---|
| `Database/` | Npgsql provider, connection string / timeout, backups |
| `Migrations/` | PostgreSQL EF migrations (synced from Jellyfin + fork entities) |
| `Query/` | Latest/Resume/NextUp cache and PG-optimised Latest SQL |
| `Search/` | Trigram / franchise-oriented fuzzy search provider |
| `Taste/` | Profile rebuild, scoring, recommendations |
| `Api/` | Taste, Emby import, user admin, plugin stats controllers |
| `Admin/EmbyImport/` | Emby SQLite userdata import pipeline |
| `Playback/` | Playback-reporting import helpers (where applicable) |

`Jellyfin.Plugin.Seerr` talks to an external Seerr/Jellyseerr instance (URL + API key in plugin config) and is consumed by web search / Beyond Your Library patches.

## Migration sync (summary)

A scheduled workflow detects new Jellyfin releases, bumps refs (including **both** `jellyfin` and `jellyfin-web` to the same tag), verifies patches apply, and opens a collaborator-only PR. Docker publish is blocked until sync state matches the target version. Failures open/update issues labeled `migration-sync-failure` (see [known issues](known-issues.md)).

`Update_*` PostgreSQL migrations are generated **only when Jellyfin’s SQLite migration set advances**. Tag-only bumps (same latest core migration id) update version refs and submodule pointers, verify patches, and **build the solution** against patched jellyfin (so new interface members and other API breaks fail sync early), but skip EF. When an `Update_*` is needed, SQLite migrations are **not** copied — EF diffs the patched design-time model against the existing PG snapshot (upstream delta only, assuming fork schema already has dedicated migrations), then post-processes PG-specific fixes and validates against Postgres.

Operator-facing sync and release steps: [README — Release flow](../README.md#release-flow).

## Submodule hygiene

- Do **not** commit modified files inside `jellyfin/` or `jellyfin-web/`.
- Always export diffs to `patches/` and reset submodule trees after editing.
- Bumping Jellyfin versions means advancing **both** submodule pointers to the same tag.
