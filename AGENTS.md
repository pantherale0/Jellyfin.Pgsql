# Agent instructions

PostgreSQL adapter for Jellyfin. Core work lives in `Jellyfin.Plugin.Pgsql/`. Jellyfin server and web UI are **git submodules** (`jellyfin/`, `jellyfin-web/`) customized only via patches.

## Hard rules

### 1. Never commit submodule working-tree changes

`jellyfin/` and `jellyfin-web/` must stay clean of committed local edits.

- Do **not** commit modified files inside either submodule.
- Implement all server/web customizations as patch files under `patches/`.
- After making edits to a submodule, export the patch for the edits and always clean the submodules back to their original tag.
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

# Typical workflow after editing a submodule checkout
./scripts/export-patch.sh jellyfin_<name>.patch
./scripts/export-patch.sh jellyfin_web_<name>.patch
```

#### Submodule Patch Export Script (`./scripts/export-patch.sh`)

When creating or updating a patch in `jellyfin/` or `jellyfin-web/`, run:

```bash
# Automatically snapshots edits, isolates dependency baseline, generates full diff, and rebuilds web
./scripts/export-patch.sh jellyfin_web_zzz_livetv_multiview.patch
```

It performs the following steps automatically:
1. **Snapshots Working Edits:** Saves all modified and untracked files currently in `jellyfin/` or `jellyfin-web/`.
2. **Isolates Baseline:** Resets the submodule to release tag (`v12.0-rc3`), removes the target patch file, applies preceding dependency patches (`./scripts/apply-patches.sh <target>`), and commits `baseline_deps`.
3. **Restores & Diffs:** Restores all feature edits onto `baseline_deps`, stages untracked files (`git add -N`), and exports the complete multi-file diff to `patches/<patch_name>`.
4. **Validates & Rebuilds:** Appends a trailing newline `\n` to prevent `git apply` EOF errors, resets the submodule back to clean `v12.0-rc3`, and runs `./scripts/build-web.sh`.

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

### 5. Never auto-commit

Auto-commits are never be allowed.

### 6. Jellyfin API JSON casing (PascalCase by default)

Jellyfin’s default JSON output is **PascalCase** (`SessionId`, `Users`). CamelCase is only used when the client sends:

```http
Accept: application/json; profile="CamelCase"
```

Raw `api.axiosInstance` calls from dashboard patches do **not** get this header automatically (unlike generated SDK methods). Reading `response.data.sessionId` against a PascalCase body silently yields `undefined` and looks like a no-op UI bug.

When adding plugin admin APIs + web clients:

- **Web:** always set `Accept: application/json; profile="CamelCase"` on custom axios calls (same pattern as Emby import / merge helpers).
- **Plugin DTOs:** prefer `[JsonPropertyName("camelCaseName")]` on response properties so payloads stay camelCase even without the Accept profile.
- **Requests:** System.Text.Json property matching is case-insensitive, so camelCase request bodies usually bind; still keep client/server names aligned.
- **Multipart uploads:** do not force `Content-Type: application/json` on `FormData`; let the browser set the multipart boundary.

### 7. API security guardrails (Jellyfin auth model)

Jellyfin has **no fallback authorization policy**. An endpoint without `[Authorize]` (or a more specific policy) is **public**. `BaseJellyfinApiController` does **not** add auth. Always attribute every new controller/action intentionally.

#### Auth attributes (pick the right one)

| Intent | Server patches (`jellyfin/`) | Plugin controllers (`Jellyfin.Plugin.Pgsql/Api/`) |
|---|---|---|
| Any signed-in user | `[Authorize]` | `[Authorize]` |
| Admin only | `[Authorize(Policy = Policies.RequiresElevation)]` | `[Authorize(Roles = "Administrator")]` |
| Public (login/OIDC/etc.) | `[AllowAnonymous]` only when required; keep the surface minimal | Same; rarely needed |

Use `MediaBrowser.Common.Api.Policies` / `Microsoft.AspNetCore.Authorization` as upstream controllers do. Do not invent a parallel auth scheme.

#### User-scoped routes (IDOR prevention)

Any route or query that takes a `userId` (or equivalent) must enforce **self or admin**:

- **Server patches:** call `RequestHelpers.GetUserId(User, userId)` at the start of the action (throws `SecurityException` → 403 for other users). See `Users/{userId}/PlaybackStats` in `jellyfin_playback_statistics.patch`.
- **Plugin:** compare `Jellyfin-UserId` claim to the requested id, or allow `User.IsInRole("Administrator")` (same pattern as `TasteProfileController.CanAccessUser` / Emby import session owner checks).

Admin-wide aggregates belong on a separate elevated controller (e.g. `PlaybackStats` with `RequiresElevation`), not on an unauthenticated or weakly checked user route.

#### Input, uploads, and error responses

- Bound resource usage: request/multipart size limits, concurrent session caps, parameterized SQL (never load an entire imported table then filter in memory).
- Bind ephemeral upload/import sessions to the creating admin (`CreatedByUserId`); reject other callers even if they are also admins.
- Do not build OAuth `redirect_uri` from `Request.Host`; require a configured absolute URI (`JELLYFIN_SSO_OIDC_REDIRECT_URI`).
- Never return IdP/token/userinfo response bodies to clients; log server-side and return generic errors.
- User-influenced strings in HTML/content responses must be encoded or returned as `text/plain` (no raw OIDC `error_description` in HTML).
- Do not expose filesystem paths, internal eval metrics, or other admin-only diagnostics on user-facing APIs.

#### Checklist before shipping a new API

1. Class or action has `[Authorize]` / elevation / `[AllowAnonymous]` by design.
2. Every `userId` path is ownership-checked.
3. Admin mutations stay behind elevation/Administrator.
4. Uploads and heavy reads have size/concurrency/query bounds.
5. Error payloads cannot leak secrets or enable XSS.
6. Server changes live in `patches/`; submodule left clean.

### 8. Keep documentation current with code and patches

Docs are part of the change, not a follow-up. When you add, rename, remove, or meaningfully change behaviour, update the matching docs **in the same work** (same PR/change set as the code/patches). Do not leave stale catalog entries or undocumented user-facing features.

| Change | Update |
|---|---|
| New / changed / removed `patches/*.patch` | [`docs/patches.md`](docs/patches.md) — add, revise, or delete the entry; keep the **What / Why / Where / How / Related** table shape and section grouping |
| User- or operator-visible capability (SSO, cache, taste, Seerr, Emby import, Live TV, playback stats, …) | [`docs/features.md`](docs/features.md) — feature map; cross-link patch anchors |
| Patch routing, apply order, repo layout, Docker/plugin composition | [`docs/architecture.md`](docs/architecture.md) |
| Benefits/drawbacks framing of the fork | [`docs/overview.md`](docs/overview.md) |
| Operational caveats, regressions, tracker items | [`docs/known-issues.md`](docs/known-issues.md) |
| Env vars, compose examples, SSO setup, SQLite migration, release/image usage | Root [`README.md`](README.md) (authoritative for operator how-to) |
| New top-level doc file | [`docs/README.md`](docs/README.md) index table **and** the Documentation table in root `README.md` |

**Patch catalog rules** (`docs/patches.md`):

- Every file under `patches/` must have a catalog entry; removing a patch removes its entry.
- Prefer verified issue/PR links only; otherwise write “No public issue.”
- When a server and web patch are companions, cross-link them under **Related**.
- If apply order / `z_` / `zz_` layering matters, note prerequisites (and mirror any `#` preamble in the patch).

**Features rules** (`docs/features.md`):

- Document what operators get, where it lives (plugin path and/or patch names), how to configure it, and point at `patches.md` anchors.
- Do not duplicate full env-var tables here — link the README section that owns them.
- Purely internal refactors with no operator-visible behaviour need no features entry; still update `patches.md` if a patch file changed.

**Do not** invent docs for speculative work, or expand AGENTS.md with feature narrative (keep agent rules here; product docs under `docs/` + README).

#### Checklist before finishing a change

1. New/updated/removed patches reflected in `docs/patches.md`.
2. Operator-visible behaviour reflected in `docs/features.md` (or explicitly N/A).
3. New env vars / setup steps in root `README.md` when operators must configure them.
4. New caveats or known failures in `docs/known-issues.md` when applicable.
5. Architecture/index tables still accurate if layout or routing changed.

## Project map

| Path | Role |
|---|---|
| `Jellyfin.Plugin.Pgsql/` | Plugin source, EF migrations, PostgreSQL provider |
| `jellyfin/`, `jellyfin-web/` | Upstream submodules (patch targets only) |
| `patches/` | All committed Jellyfin/Jellyfin-web diffs |
| `docs/` | Overview, architecture, features, patch catalog, known issues |
| `scripts/apply-patches.sh` | Applies patches by naming convention |
| `scripts/export-patch.sh` | Snapshots submodule edits into patches & rebuilds web |
| `scripts/start-dev.sh` | Dev stack entrypoint (user-run) |
| `scripts/sync-jellyfin-migrations.sh` | Align plugin migrations with a Jellyfin release |
| `docker/` | Production image build |
| `docker-compose.dev.yaml` | Local OIDC/Keycloak test environment |

## Preferred change locations

- Plugin behavior, migrations, caching → `Jellyfin.Plugin.Pgsql/`
- Server or web UI behavior → edit submodule locally, then refresh the matching `patches/*.patch`; leave submodules clean
- Dev/runtime wiring → `docker-compose.dev.yaml`, `scripts/`, `docker/` (not submodule trees)
- Docs for the above → `docs/` (+ root `README.md` for operator how-to); see hard rule 8
