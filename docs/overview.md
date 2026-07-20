# Overview

This repository is an **experimental** PostgreSQL adapter for Jellyfin, maintained independently for personal use. It was originally derived from [JPVenson/Jellyfin.Pgsql](https://github.com/JPVenson/Jellyfin.Pgsql) but is no longer tied to that project’s releases, images, or workflow.

Published images live at `ghcr.io/pantherale0/jellyfin.pgsql` (for example `:12.0-rc2`). The image is **not** stock Jellyfin plus a drop-in plugin: it builds Jellyfin server and web from source after applying every patch under [`patches/`](../patches/), then ships [`Jellyfin.Plugin.Pgsql`](../Jellyfin.Plugin.Pgsql/) and [`Jellyfin.Plugin.Seerr`](../Jellyfin.Plugin.Seerr/).

**Status:** highly experimental — use at your own risk.

## What this fork is

| Layer | Role |
|---|---|
| PostgreSQL plugin | EF Core provider, migrations, query cache, fuzzy search, taste/recs, Emby import APIs, admin helpers |
| Seerr plugin | In-server Seerr/Jellyseerr search, request, and “Beyond Your Library” discovery |
| Server patches | SSO/OIDC, Live TV fixes, playback stats schema/APIs, security hardening, query/perf changes |
| Web patches | Dashboard UIs for those features, TV/webOS UX, Seerr/taste/home sections |

Quick start and env-var tables remain in the root [README](../README.md). This `docs/` tree covers **what / why / where / how** for the fork, features, and every patch.

## Benefits

- **PostgreSQL as the system database** — better fit for large libraries and remote/shared DBs than SQLite.
- **Query cache + PG-optimised Latest** — optional Redis or in-process Memory cache for home Latest/Resume rows; `DISTINCT ON` Latest paths that fail open to stock queries (see [README](../README.md#query-cache-and-optimisation-optional-experimental)).
- **Automated SQLite → Postgres migration** — one-shot `MIGRATE_FROM_SQLITE` / pgloader path with backups and a completion marker.
- **Built-in OIDC SSO + RBAC** — forced browser redirect, admin role sync, birthdate → parental rating, group → block-unrated mappings; TV clients use Quick Connect instead of IdP redirects.
- **Large-library oriented patches** — home/NextUp/search/Live TV query work, progress write coalescing, indexes mirrored into the PG provider via migration sync.
- **Product features beyond stock Jellyfin** — playback statistics dashboard, taste profiles / “For You”, Seerr search + Beyond Your Library, Emby userdata import, user merge, HW capability and transcoding pipeline visibility.
- **Upstream bugfixes carried as patches** — favorites/progress races, Live TV published URLs, HLS remux thrash, HDR10+ MPEG-TS, Chrome MKV DirectPlay false positives, and related items (see [patches catalog](patches.md)).
- **Release alignment automation** — scheduled sync of Jellyfin versions and EF migrations; Docker publish gated on sync state.

## Drawbacks

- **Experimental personal fork** — no general support commitment; behaviour can change without a public roadmap.
- **Collaborator-locked issues and PRs** — public discussion is directed to [GitHub Discussions](https://github.com/pantherale0/Jellyfin.Pgsql/discussions); the tracker is primarily for CI (for example migration-sync failures).
- **Not stock Jellyfin** — ~55 patches diverge from upstream. Every Jellyfin bump requires re-applying or refreshing patches; some (especially TV Latest optimisation and large Live TV patches) need manual re-validation.
- **Custom image required for patched features** — installing only the `.dll` plugin into stock Jellyfin does **not** give SSO, playback-stats controllers, home-section enums, or web UIs that live in patches.
- **Third-party client variance** — native apps that ignore the patched web UI still hit patched APIs where applicable, but TV SSO behaviour, share links, and search providers may differ from stock expectations.
- **Cache lag** — with default TTLs, newly added media can take up to ~2 minutes to appear in cached Latest rows.
- **Inherited Postgres-provider pain** — at extreme scale, timeouts, memory during scans, and unique-constraint edge cases still appear in the wider PG-Jellyfin ecosystem (see [known issues](known-issues.md)); this fork mitigates some (command timeout defaults, query cache) but does not claim to eliminate them.
- **Operational complexity** — Postgres (and optionally Redis), OIDC redirect URI configuration, and migration/sync tooling are extra moving parts versus a single SQLite container.

## Related docs

- [Architecture](architecture.md) — how plugins, submodules, and patches compose
- [Features](features.md) — operator-facing feature map
- [Patches](patches.md) — full patch catalog
- [Known issues](known-issues.md) — fork and inherited caveats
