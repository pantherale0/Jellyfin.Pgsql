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
| Live TV client hang (Wholphin) | After open, classify from logs: `Shared=true` + high `AgeMs` (stale share), `ClearedUnreachableOrigin` (cluster-internal M3U Path stripped), or open without a following `Live TV FirstPull` (client never pulled media). Dispatcharr `/proxy/ts/{id}` uses SharedHttpStream; PlaybackInfo clears unreachable origin Paths so clients must use `TranscodingUrl` / published LiveStreamFiles. See [`jellyfin_livetv_stream`](patches.md#jellyfin_livetv_streampatch) / [`jellyfin_livetv_published_url`](patches.md#jellyfin_livetv_published_urlpatch). |
| Live TV `NoCompatibleStream` (Wholphin) | Wholphin may send `MediaSourceId` = channel item Guid (placeholder) instead of the tuner source id. Without the workaround in [`jellyfin_livetv_published_url`](patches.md#jellyfin_livetv_published_urlpatch), PlaybackInfo returns empty sources / `NoCompatibleStream` in ~tens of ms with no live open. Server logs `Ignoring unmatched Live TV MediaSourceId` when falling back; AutoOpen then uses `MediaSources[0]` so a `LiveStreamId` is returned. Proper fix remains omitting `MediaSourceId` on first Live TV PlaybackInfo in the client. |
| Live TV `live.m3u8` null `OpenToken` | If PlaybackInfo skipped AutoOpen (or the client omitted `LiveStreamId`), `GetLiveHlsStream` used to build ffmpeg `-i` from the tuner origin before open, then `StreamState.Dispose` closed the stream (`ArgumentNullException` on null `OpenToken`). Mitigated by AutoOpen fallback ([`jellyfin_livetv_published_url`](patches.md#jellyfin_livetv_published_urlpatch)), open-before-CLI ([`jellyfin_livetv_stream`](patches.md#jellyfin_livetv_streampatch)), and `Request.LiveStreamId` sync ([`jellyfin_transcoding_pipeline`](patches.md#jellyfin_transcoding_pipelinepatch)). |
| Live TV open timeout | Shared HTTP (M3U) opens use `LiveStreamOpenTimeoutMs` (default 15000) so a stalled upstream fails that tune instead of waiting ~100s on `HttpClient.Timeout`. With [`jellyfin_livetv_stream`](patches.md#jellyfin_livetv_streampatch), that open no longer holds the global live-stream lock (same-channel opens are serialized by `OpenToken`); other channels/users are not frozen. Residual pause/zombie opens without session mappings are closed after a 2-minute grace by the inactive/idle sweeper. Adjust timeout under Dashboard → Playback → Transcoding. |
| Live TV Multiview | Experimental web overlay ([`jellyfin_web_zzz_livetv_multiview`](patches.md#jellyfin_web_zzz_livetv_multiviewpatch)): each tile is a separate Live TV open + `hls.js` player (no per-tile subtitle/bitrate controls). Four simultaneous streams can exhaust tuner/transcode capacity. `EnableLiveTvMultiview` / `Policies.LiveTvMultiview` gates the UI only—LiveStreams APIs are unchanged. Existing users without a permission row need an admin to enable Multiview (`HasPermission` defaults false); new users default enabled. |
| SQLite migration | Stop Jellyfin first; target PG database should be empty; one-shot completion marker prevents re-runs ([README](../README.md#migrating-from-sqlite-to-postgresql)). |
| `Update_12_0-rc4` `PK_LinkedChildren` | rc4 changes `LinkedChildren` PK from `(ParentId, ChildId)` to `(ParentId, SortOrder)`. Production libraries often have many children with `SortOrder` NULL/0, so PostgreSQL error `23505` / `could not create unique index "PK_LinkedChildren"` aborts startup and the plugin restores the pre-migration dump. Images after this fix renumber sort order per parent before adding the PK (no children dropped). Re-pull the image and start once; the restore already left the DB on the previous schema. |
| `Update_12_0-rc5` dropped `IX_MediaSegments_ItemId` | rc5 sync compared the plugin snapshot (which had the QoS `ItemId` index) to the core model (which does not) and emitted a drop. `HasSegments` / `GetSegments` / extraction skip-checks then sequential-scan `MediaSegments` on every media-source build and congest the whole API. Fixed by `RestoreMediaSegmentsItemIdIndex` plus declaring the index in plugin `OnModelCreating` so later `Update_*` syncs keep it. Restart once after pulling an image that includes that migration. |
| `Update_12_0-rc4` dropped `IX_PlaybackActivity_SeriesId_DatePlayed` | Same class of sync drift: the plugin-only `(SeriesId, DatePlayed)` index is not in the core EF model, so rc4 emitted a drop. Taste episode rollup and series-scoped playback reads then scan `PlaybackActivity`. Fixed by `RestorePlaybackActivitySeriesIdDatePlayedIndex` plus declaring the index in plugin `OnModelCreating`. Restart once after pulling an image that includes that migration. |
| Active-standby HA | Off by default (`Pgsql_HA_ENABLED`). `/config` is still single-writer (share `JELLYFIN_SERVER_ID` if pods do not share `device.txt`). In-flight TCP/HLS/Live TV sockets die; Live TV needs a client restart (`LiveStreamFenced`). Sidecar Redis on localhost cannot elect or overlay progress across pods — extract Redis first. When enabling HA, switch k8s readiness from `/health` to `/health/ready`. |
| Movies Recommendations 524 under neural serving | Live `/Movies/Recommendations` used to run ML.NET over unbounded similar-item overlap (Cloudflare origin timeout ~100s). Because you watched/liked lists are now materialized by **Rebuild user taste recommendations** and served from `UserTasteBecauseYouRecommendations`. Titles watched after the last refresh still get a category via similarity + linear only until the next job. |

## Inherited Postgres ecosystem issues (upstream tracker)

These live on [JPVenson/Jellyfin.Pgsql](https://github.com/JPVenson/Jellyfin.Pgsql) and describe problems that appear with PostgreSQL-backed Jellyfin generally. They are **not** feature tickets for this fork; cited as context for operators and for [overview drawbacks](overview.md#drawbacks). Whether a given item still reproduces on `ghcr.io/pantherale0/jellyfin.pgsql` depends on version and workload — verify on your image tag.

| Upstream issue | Summary | Relevance here |
|---|---|---|
| [JPVenson#35](https://github.com/JPVenson/Jellyfin.Pgsql/issues/35) | `/Items/Latest` 30s timeouts on large libraries | Motivates command timeout + Latest query cache/optimisation in this fork. |
| [JPVenson#43](https://github.com/JPVenson/Jellyfin.Pgsql/issues/43) | Timeout env ignored on old image tags | Use a current pantherale0 image; prefer `Pgsql_COMMAND_TIMEOUT`. |
| [JPVenson#36](https://github.com/JPVenson/Jellyfin.Pgsql/issues/36) | Very high memory during library scan | Extreme library sizes can still OOM; not fully solved by switching DB engines. [`jellyfin_background_media_qos`](patches.md#jellyfin_background_media_qospatch) reduces CPU/IO contention during scan/segment/chapter work but does **not** address scan OOM. |
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
| [jellyfin-web#7651](https://github.com/jellyfin/jellyfin-web/issues/7651) | Chrome/Opera MKV DirectPlay false positive |
| [jellyfin#17602](https://github.com/jellyfin/jellyfin/issues/17602) | Home-page / recursive-query memory blow-up (`DescendantQueryHelper` inlined id sets; [`jellyfin_zzzz_descendant_query_memory`](patches.md#jellyfin_zzzz_descendant_query_memorypatch)) |
