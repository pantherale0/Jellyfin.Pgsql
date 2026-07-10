# Agent instructions

PostgreSQL adapter for Jellyfin. Core work lives in `Jellyfin.Plugin.Pgsql/`. Jellyfin server and web UI are **git submodules** (`jellyfin/`, `jellyfin-web/`) customized only via patches.

## Hard rules

### 1. Never commit submodule working-tree changes

`jellyfin/` and `jellyfin-web/` must stay clean of committed local edits.

- Do **not** commit modified files inside either submodule.
- Implement all server/web customizations as patch files under `patches/`.
- After editing a submodule for development, export a patch and restore the submodule to a clean checkout before committing the parent repo.
- Submodule pointer updates (same feature/release tag on both) are allowed when intentionally bumping Jellyfin versions.

### 2. Patch naming and routing

Patches live in a flat `patches/` directory. `scripts/apply-patches.sh` routes them by filename:

| Pattern | Target | Examples |
|---|---|---|
| `jellyfin_web*.patch` | `jellyfin-web/` | `jellyfin_web_rbac.patch` |
| `jellyfin_*.patch` (and `jellyfin.patch`) | `jellyfin/` | `jellyfin_sso.patch` |

**Web is matched first.** A name starting with `jellyfin_web` is never applied to core, even though it also matches `jellyfin_*`.

```bash
# Apply (used by Docker builds)
./scripts/apply-patches.sh jellyfin
./scripts/apply-patches.sh jellyfin-web

# Typical workflow after editing a clean submodule checkout
git -C jellyfin diff > patches/jellyfin_<name>.patch
git -C jellyfin-web diff > patches/jellyfin_web_<name>.patch
git -C jellyfin checkout -- .
git -C jellyfin-web checkout -- .
```

### 3. Do not build Docker automatically

Never run `docker build`, `docker compose up --build`, or equivalent unless the user explicitly asks.

When a local image or stack is needed, **prompt the user** to run:

```bash
./scripts/start-dev.sh
```

That script starts the OIDC/RBAC dev environment via `docker-compose.dev.yaml`.

### 4. Keep `jellyfin` and `jellyfin-web` on the same feature branch / tag

Both submodules must track the **same** Jellyfin release (e.g. both at `v12.0-rc2`). Do not advance one without the other.

- Migration / version drift between plugin and core: `./scripts/sync-jellyfin-migrations.sh` (prefer `--dry-run` first).
- GitHub workflows sync and publish automatically; do not reinvent that flow locally unless asked.

```bash
./scripts/sync-jellyfin-migrations.sh --dry-run
./scripts/sync-jellyfin-migrations.sh --version 12.0-rc2
```

## Project map

| Path | Role |
|---|---|
| `Jellyfin.Plugin.Pgsql/` | Plugin source, EF migrations, PostgreSQL provider |
| `jellyfin/`, `jellyfin-web/` | Upstream submodules (patch targets only) |
| `patches/` | All committed Jellyfin/Jellyfin-web diffs |
| `scripts/apply-patches.sh` | Applies patches by naming convention |
| `scripts/start-dev.sh` | Dev stack entrypoint (user-run) |
| `scripts/sync-jellyfin-migrations.sh` | Align plugin migrations with a Jellyfin release |
| `docker/` | Production image build |
| `docker-compose.dev.yaml` | Local OIDC/Keycloak test environment |

## Preferred change locations

- Plugin behavior, migrations, caching → `Jellyfin.Plugin.Pgsql/`
- Server or web UI behavior → edit submodule locally, then refresh the matching `patches/*.patch`; leave submodules clean
- Dev/runtime wiring → `docker-compose.dev.yaml`, `scripts/`, `docker/` (not submodule trees)
