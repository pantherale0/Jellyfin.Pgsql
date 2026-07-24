# Known issues and caveats

Operational and tracker notes for this fork. For benefits/drawbacks framing see [overview](overview.md).

## Experimental status

This project is **highly experimental** and maintained for personal use. Expect breakage on Jellyfin upgrades until patches and migrations are re-validated. Issues and pull requests on [pantherale0/Jellyfin.Pgsql](https://github.com/pantherale0/Jellyfin.Pgsql) are **collaborator-only**; prefer [Discussions](https://github.com/pantherale0/Jellyfin.Pgsql/discussions) for public conversation.

## This fork’s tracker

| Issue | Topic | Notes |
|---|---|---|
| [pantherale0#5](https://github.com/pantherale0/Jellyfin.Pgsql/issues/5) | SSO Mapping config broken | Dashboard SSO mappings hit auth failures (401); addressed in web RBAC/auth handling. |
| [pantherale0#1](https://github.com/pantherale0/Jellyfin.Pgsql/issues/1), [#2](https://github.com/pantherale0/Jellyfin.Pgsql/issues/2), [#4](https://github.com/pantherale0/Jellyfin.Pgsql/issues/4) | Migration sync failures | Auto-opened/updated with label `migration-sync-failure` when the scheduled sync workflow fails. |

Most product features (taste, playback stats, Emby import, Live TV patches, etc.) have **no** dedicated public issue on this fork; behaviour is defined by patches and commits only.

## Operational caveats (this image)

| Caveat | Detail |
|---|---|
| Cache lag | Default Latest TTL is 120s — new media can take up to that long to appear in cached Latest rows ([README](../README.md#query-cache-and-optimisation-optional-experimental)). |
| TV Latest optimisation | Plugin ports Season/Series container logic; **re-check** when syncing to new Jellyfin releases. |
| Command timeout | Stock Jellyfin’s 30s Npgsql default is tight for large remote DBs; this image defaults `Pgsql_COMMAND_TIMEOUT` to `90`. |
| Custom image required | Patched APIs and web UIs are not available if you only drop the plugin DLL into stock Jellyfin. |
| Submodule/patch drift | Every upstream bump can break `git apply`; maintainers must refresh patches. |
| SSO redirect URI | Must be an absolute configured URI (`JELLYFIN_SSO_OIDC_REDIRECT_URI`); do not derive from `Request.Host`. |
| Live TV RBAC categories | M3U `group-title` categories appear in SSO allowlists only after a guide refresh with [`jellyfin_z_livetv_rbac_allowlist`](patches.md#jellyfin_z_livetv_rbac_allowlistpatch). HDHomeRun/XMLTV-only setups typically get EPG Kids/Sports/News categories, not playlist groups. |
| Live TV open timeout | Shared HTTP (M3U) opens use `LiveStreamOpenTimeoutMs` (default 15000) so a stalled upstream fails that tune instead of waiting ~100s on `HttpClient.Timeout`. With [`jellyfin_livetv_stream`](patches.md#jellyfin_livetv_streampatch), that open no longer holds the global live-stream lock (same-channel opens are serialized by `OpenToken`); other channels/users are not frozen. Residual pause/zombie opens without session mappings are closed after a 2-minute grace by the inactive/idle sweeper. Adjust timeout under Dashboard → Playback → Transcoding. |
| SQLite migration | Stop Jellyfin first; target PG database should be empty; one-shot completion marker prevents re-runs ([README](../README.md#migrating-from-sqlite-to-postgresql)). |

## Inherited Postgres ecosystem issues (upstream tracker)

These live on [JPVenson/Jellyfin.Pgsql](https://github.com/JPVenson/Jellyfin.Pgsql) and describe problems that appear with PostgreSQL-backed Jellyfin generally. They are **not** feature tickets for this fork; cited as context for operators and for [overview drawbacks](overview.md#drawbacks). Whether a given item still reproduces on `ghcr.io/pantherale0/jellyfin.pgsql` depends on version and workload — verify on your image tag.

| Upstream issue | Summary | Relevance here |
|---|---|---|
| [JPVenson#35](https://github.com/JPVenson/Jellyfin.Pgsql/issues/35) | `/Items/Latest` 30s timeouts on large libraries | Motivates command timeout + Latest query cache/optimisation in this fork. |
| [JPVenson#43](https://github.com/JPVenson/Jellyfin.Pgsql/issues/43) | Timeout env ignored on old image tags | Use a current pantherale0 image; prefer `Pgsql_COMMAND_TIMEOUT`. |
| [JPVenson#36](https://github.com/JPVenson/Jellyfin.Pgsql/issues/36) | Very high memory during library scan | Extreme library sizes can still OOM; not fully solved by switching DB engines. |
| [JPVenson#34](https://github.com/JPVenson/Jellyfin.Pgsql/issues/34) | Slow homepage/list with hundreds of thousands of rows | Scale motivation for indexes/query patches/cache. |
| [JPVenson#42](https://github.com/JPVenson/Jellyfin.Pgsql/issues/42) | `/Library/VirtualFolders` empty while libraries exist | Dashboard Libraries page edge case on some PG setups. |
| [JPVenson#15](https://github.com/JPVenson/Jellyfin.Pgsql/issues/15), [#19](https://github.com/JPVenson/Jellyfin.Pgsql/issues/19), [#44](https://github.com/JPVenson/Jellyfin.Pgsql/issues/44) | Schema / unique constraint insert failures | Sequence/`varchar` length/`ItemValues`/`UserData` PK races after migration or rescans. |
| [JPVenson#25](https://github.com/JPVenson/Jellyfin.Pgsql/issues/25) | Jellyseerr Devices.`AppVersion` too long | Column length vs Seerr client version strings. |
| [JPVenson#16](https://github.com/JPVenson/Jellyfin.Pgsql/issues/16) | Alphabet letters empty on fresh DB | Index/letter jump UI on empty or freshly migrated libraries. |

## Upstream Jellyfin issues fixed (or mitigated) by patches

These are **Jellyfin** project issues/PRs carried as patches in this repo — see the [patch catalog](patches.md) for what/why/where/how:

| Reference | Patch area |
|---|---|
| [jellyfin#14981](https://github.com/jellyfin/jellyfin/issues/14981) | Favorites lost on progress save |
| [jellyfin#15411](https://github.com/jellyfin/jellyfin/issues/15411) / [PR #17298](https://github.com/jellyfin/jellyfin/pull/17298) | Live TV published URLs in Docker |
| [jellyfin#17128](https://github.com/jellyfin/jellyfin/pull/17128) / [web#8072](https://github.com/jellyfin/jellyfin-web/pull/8072) | Live stream buffer / KeepSeconds (`jellyfin_livetv_stream`) |
| [jellyfin#9813](https://github.com/jellyfin/jellyfin/issues/9813) | Live TV probe delay (`jellyfin_livetv_stream`) |
| [jellyfin#17319](https://github.com/jellyfin/jellyfin/issues/17319) | Live TV global open lock / SharedHttpStream stall (`jellyfin_livetv_stream`) |
| [jellyfin#16880](https://github.com/jellyfin/jellyfin/issues/16880) / [jellyfin#17177](https://github.com/jellyfin/jellyfin/issues/17177) | Live TV stop without `LiveStreamId` / orphaned open streams (`jellyfin_livetv_stream`) |
| [jellyfin#13668](https://github.com/jellyfin/jellyfin/issues/13668) | HLS remux segment restart thrash |
| [jellyfin#16823](https://github.com/jellyfin/jellyfin/issues/16823) | HDR10+ MPEG-TS SEI |
| [jellyfin#15897](https://github.com/jellyfin/jellyfin/issues/15897) | Disabled plugin deletion |
| [jellyfin-web#7651](https://github.com/jellyfin/jellyfin-web/issues/7651) | Chrome/Opera MKV DirectPlay false positive |
