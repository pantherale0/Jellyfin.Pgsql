# Features

Operator-facing map of capabilities in this fork: what you get, how to configure it, and which plugins/patches implement it. Env-var tables for Postgres, cache, and SSO remain authoritative in the [README](../README.md).

## PostgreSQL database provider

**What:** Jellyfin stores its system database in PostgreSQL instead of SQLite.

**Where:** [`Jellyfin.Plugin.Pgsql`](../Jellyfin.Plugin.Pgsql/), Docker entrypoint `POSTGRES_*` wiring, [`docker/database.xml`](../docker/database.xml).

**How:** The plugin registers as a custom database provider. Images set connection parameters from environment variables (`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, optional SSL). `Pgsql_COMMAND_TIMEOUT` (default `90`) raises Npgsql’s command timeout for heavy library queries.

**Related:** SQLite→PG migration in [README](../README.md#migrating-from-sqlite-to-postgresql); inherited scale caveats in [known issues](known-issues.md).

## Query cache and optimised Latest

**What:** Cache home Latest/Resume ID lists and stable library browse `/Items` pages; optionally replace Latest queries with PostgreSQL `DISTINCT ON` variants.

**Where:** [`Jellyfin.Plugin.Pgsql/Query/`](../Jellyfin.Plugin.Pgsql/Query/); toggles `Pgsql_CACHE_*`, `Pgsql_PG_OPTIMIZE_*`, `REDIS_CONNECTION_STRING` ([README](../README.md#query-cache-and-optimisation-optional-experimental)).

**How:** Cache keys are per user and per view (never shared across users). Failures fall back to stock Jellyfin queries. Default Latest TTL is 120s; browse pages default to 60s (`Pgsql_CACHE_BROWSE_TTL`). Browse cache stores `(TotalRecordCount, ids[])` for recursive SortName-style library pages.

**Patches that help home/query load:** [`jellyfin_home_api_performance`](patches.md#jellyfin_home_api_performancepatch), [`jellyfin_unoptimized_query_fixes`](patches.md#jellyfin_unoptimized_query_fixespatch), [`jellyfin_query_split_userdata`](patches.md#jellyfin_query_split_userdatapatch), [`jellyfin_z_items_browse_perf`](patches.md#jellyfin_z_items_browse_perfpatch), [`jellyfin_latest_tv_always_series`](patches.md#jellyfin_latest_tv_always_seriespatch), [`jellyfin_zzz_byname_access_semijoin`](patches.md#jellyfin_zzz_byname_access_semijoinpatch), [`jellyfin_zzzz_people_query_perf`](patches.md#jellyfin_zzzz_people_query_perfpatch). Descendant-query memory fixes are stock Jellyfin as of v12.0-rc6 ([jellyfin#17602](https://github.com/jellyfin/jellyfin/issues/17602)).

## Fuzzy search (PostgreSQL)

**What:** Server-side fuzzy / franchise-oriented search via the plugin provider; core SQL search provider is disabled when the plugin is present so results do not double-count.

**Where:** [`Jellyfin.Plugin.Pgsql/Search/`](../Jellyfin.Plugin.Pgsql/Search/); patches [`jellyfin_search_performance`](patches.md#jellyfin_search_performancepatch), [`jellyfin_disable_sql_search_provider`](patches.md#jellyfin_disable_sql_search_providerpatch); web infinite scroll on search ([`jellyfin_web_user_search_infinite_scroll`](patches.md#jellyfin_web_user_search_infinite_scrollpatch)).

**How:** Plugin registers an `ISearchProvider`. ApplicationHost prefers PostgreSQL similarity for “Similar” and excludes `SqlSearchProvider` from search parts. Fuzzy title matching uses only the indexable pg_trgm `<%` operator (`jellyfin_word_similar`) with a per-transaction similarity threshold so `IX_BaseItems_CleanName_trgm` can be used — Levenshtein and function-form `similarity()` are not OR’d into the same filter (those force a sequential scan). Total-count is computed from the page when it is not full; `CountAsync` of the union runs only when the page is full and the client asked for a total. Genre/tag `ILIKE` goes through `jellyfin_ilike`, which inlines to `haystack ILIKE pattern` so GIN trigram indexes on OriginalTitle / Genres / Tags can be used. More Like This scores franchise titles the same way (one batched `<%` / `ILIKE` pass instead of a `word_similarity()` scan per source) and hides already-played candidates with a `UserData` lookup on the short candidate list rather than the rc5 folder-descendant `IsPlayed` SQL.

**People listings:** `/Persons` collapse (one row per provider key or lowercased name) lives in [`jellyfin_zz_person_provider_identity`](patches.md#jellyfin_zz_person_provider_identitypatch). Name-contains search and batched `HasSegments` on media-source builds are in [`jellyfin_zzzz_people_query_perf`](patches.md#jellyfin_zzzz_people_query_perfpatch).

## Single Sign-On (OIDC) and RBAC

**What:** Forced OIDC login for browsers, auto-create users, admin role from IdP groups, parental rating from birthdate claim, and per-group dashboard mappings for libraries, permissions, block-unrated types, Allowed/Blocked tags, and Live TV channel/category allowlists (exceptions when unrated Live TV is blocked).

**Where:**

- Server: [`jellyfin_sso.patch`](patches.md#jellyfin_ssopatch) (`SSOController`), [`jellyfin_z_livetv_rbac_allowlist.patch`](patches.md#jellyfin_z_livetv_rbac_allowlistpatch) (ChannelGroup persist + parental enforcement)
- Web: [`jellyfin_web_rbac.patch`](patches.md#jellyfin_web_rbacpatch) (SSO Mappings UI)
- TV: [`jellyfin_web_tv_quickconnect_login`](patches.md#jellyfin_web_tv_quickconnect_loginpatch), [`jellyfin_web_quickconnect_modal`](patches.md#jellyfin_web_quickconnect_modalpatch)
- Config: `JELLYFIN_SSO_OIDC_*` ([README](../README.md#single-sign-on-sso-with-rbac-via-oauth2oidc))

**How:** When SSO env vars are set, the web client redirects to the IdP. Callback is the configured absolute `JELLYFIN_SSO_OIDC_REDIRECT_URI` (not derived from `Host`). Matching IdP groups merge `sso_rbac.json` additively onto the user. Emergency bypass: `?local=true` on the login URL. TV clients skip forced redirect and open Quick Connect.

**Live TV allowlist:** With “Live TV” under block-unrated, channels without ratings are hidden unless allowlisted by M3U `group-title` category, EPG category (`Kids` / `Sports` / `News`), or individual channel. Whitelisted Live TV also bypasses AllowedTags (BlockedTags still apply). Refresh the Live TV guide after changing M3U groups so categories appear in the UI.

**Related:** Fork issue [pantherale0#5](https://github.com/pantherale0/Jellyfin.Pgsql/issues/5) (SSO mapping config / auth).

## Live TV Multiview

**What:** Experimental desktop/mobile web overlay for watching up to 4 Live TV channels at once (Sky TV 1+3, Quad 2×2, Dual side-by-side). Supports audio-focus switching, in-place slot swap, and a channel picker. Each tile opens a normal Live TV session via `getPlaybackInfo` and plays with raw `hls.js` (not the full html video player stack—no per-tile subtitle/bitrate OSD). Access requires the `EnableLiveTvMultiview` user permission (Dashboard user profile or SSO group mappings in `sso_rbac.json`), the experimental display setting (`chkEnableExperimentalMultiview`), and a non-TV client (`!isTvClient() && !layoutManager.tv` — including LG webOS). Entry points: Live TV → Channels header, item context menu, and the video OSD button (Live TV items only). Tuner exhaustion when adding a channel shows a toast.

**Where:**
- Server: [`jellyfin_livetv_multiview_rbac.patch`](patches.md#jellyfin_livetv_multiview_rbacpatch) (`PermissionKind.EnableLiveTvMultiview`, `UserPolicy`, `UserManager`)
- Web: [`jellyfin_web_zzz_livetv_multiview.patch`](patches.md#jellyfin_web_zzz_livetv_multiviewpatch) (`multiviewManager.js`, `channelPickerModal.js`, `multiview.scss`, `userSettings.js`, `displaySettings`, OSD Multiview button, User Profile checkbox)
- SSO: [`jellyfin_sso.patch`](patches.md#jellyfin_ssopatch), [`jellyfin_web_rbac.patch`](patches.md#jellyfin_web_rbacpatch) (SSO Mappings UI)

**Note:** Permission is enforced in the web UI only; see [known issues](known-issues.md).

## Playback statistics

**What:** Persist playback activity (including daily rollups / delivery method analytics) and expose user + admin dashboards with charts and CSV export.

**Where:** Server [`jellyfin_playback_statistics`](patches.md#jellyfin_playback_statisticspatch); web [`jellyfin_web_user_playback_stats`](patches.md#jellyfin_web_user_playback_statspatch) (Dashboard → Reports → Playback). Progress write load reduced by [`jellyfin_playback_progress_coalesce`](patches.md#jellyfin_playback_progress_coalescepatch).

## Taste profiles, For You, and taste models

**What:** Per-user taste profiles and precomputed recommendations; home “For You” section; user taste identity UI; admin shadow-eval reports for taste models. Engagement weighting uses completion-aware playback (short abandons are negatives; deep watches/favorites are positives) and For You impression logs so recommended→engage is boosted and recommended→abandon is penalized more strongly. Profiles also store year / runtime / parental bands, movie-vs-series share, writers, box-set membership, original language, and production country; live linear scoring (For You, similar, match badges) applies soft penalties outside those bands, boosts writer / collection / language / country overlap, and demotes confirmed For You skips (impressed, no later engagement, after a 14-day confirm window). Shadow neural training uses the same axes, mixes genre-matched hard catalog negatives with random ones, treats confirmed impression skips as weak negatives, and applies recency decay on labeled sample weights. Evaluation uses a time-based holdout (newest 20% of the event span), global Precision@10, per-user Mean Precision@10, and a matured For You impression→engage rate (14-day window). ROC AUC is omitted when the holdout contains only one class (catalog negatives are kept in the train window so they do not leak into eval). When `Pgsql_TASTE_NEURAL_SERVE` is on and a shadow zip loads, the **recommendations refresh task** blends 50% neural with 50% linear into stored For You rows and Because you watched/liked similar lists (up to 12 recently played + 8 liked baselines, franchise-diversified, 16 items each). `GET /Movies/Recommendations` and More Like This read those rows; a title watched after the last rebuild falls back to similarity + linear only. Match badges stay linear on the request path. Neural serving stays **off** by default.

**Where:**

- DB entities: [`jellyfin_user_taste_profiles`](patches.md#jellyfin_user_taste_profilespatch), [`jellyfin_user_taste_recommendations`](patches.md#jellyfin_user_taste_recommendationspatch), [`jellyfin_z_user_taste_recommendation_impressions`](patches.md#jellyfin_z_user_taste_recommendation_impressionspatch), [`jellyfin_zz_user_taste_because_you`](patches.md#jellyfin_zz_user_taste_because_youpatch)
- Home section enum + API: [`jellyfin_foryou_home_section`](patches.md#jellyfin_foryou_home_sectionpatch)
- Plugin logic: [`Jellyfin.Plugin.Pgsql/Taste/`](../Jellyfin.Plugin.Pgsql/Taste/), `TasteProfileController` / `TasteAdminController`
- Web: [`jellyfin_web_foryou_home`](patches.md#jellyfin_web_foryou_homepatch), [`jellyfin_web_taste_identity`](patches.md#jellyfin_web_taste_identitypatch), [`jellyfin_web_z_taste_models`](patches.md#jellyfin_web_z_taste_modelspatch)

## Seerr / Beyond Your Library

**What:** Search results can show Seerr request status and request actions; home “Beyond Your Library” row surfaces discover candidates outside the library (with parental filtering).

**Where:** [`Jellyfin.Plugin.Seerr`](../Jellyfin.Plugin.Seerr/) (plugin config: Seerr URL + API key); [`jellyfin_web_seerr_search`](patches.md#jellyfin_web_seerr_searchpatch); [`jellyfin_z_beyond_your_library_home`](patches.md#jellyfin_z_beyond_your_library_homepatch) + [`jellyfin_web_seerr_z_beyond_your_library_home`](patches.md#jellyfin_web_seerr_z_beyond_your_library_homepatch).

**Note:** Upstream Devices.`AppVersion` length issues with Jellyseerr were discussed on JPVenson ([#25](https://github.com/JPVenson/Jellyfin.Pgsql/issues/25)); use a current image/schema if you hit `varchar(32)` errors.

## Emby userdata import and user merge

**What:** Admins can upload Emby SQLite userdata and map/import progress/favorites; merge/transfer userdata between Jellyfin users.

**Where:** Plugin `Api/EmbyImport*` + `Admin/EmbyImport/`; web [`jellyfin_web_zz_emby_userdata_import`](patches.md#jellyfin_web_zz_emby_userdata_importpatch), [`jellyfin_web_z_user_admin`](patches.md#jellyfin_web_z_user_adminpatch) (Dashboard → Users).

## Live TV hardening

**What:** Guide/listings performance, published URL rewrites for Docker, clearing unreachable tuner-origin Paths from PlaybackInfo (so clients use `TranscodingUrl` / LiveStreamFiles), ignoring unmatched Live TV `MediaSourceId` and AutoOpen fallback to the first tuner source (Wholphin channel-placeholder id → avoid `NoCompatibleStream` / missing `LiveStreamId`), SharedHttpStream for extensionless HTTP M3U origins (e.g. Dispatcharr), `live.m3u8` open-before-ffmpeg-CLI + `Request.LiveStreamId` sync (avoid null-`OpenToken` after premature close), rolling stream buffers / keep-alive seconds, configurable probe delay and SharedHttpStream open timeout, non-blocking live-stream open/close (avoids freezing all Live TV on one stalled M3U open), per-channel keyed share-or-create with safe `ConsumerCount`, reverse-close when clients omit `LiveStreamId`, orphaned open-stream sweep, `livetv` item alias, active recordings widget.

**Where:** See [Live TV patch group](patches.md#4-live-tv). Notable upstream refs: [jellyfin#15411](https://github.com/jellyfin/jellyfin/issues/15411) / [PR #17298](https://github.com/jellyfin/jellyfin/pull/17298), [jellyfin#17128](https://github.com/jellyfin/jellyfin/pull/17128), [jellyfin#9813](https://github.com/jellyfin/jellyfin/issues/9813), [jellyfin#17319](https://github.com/jellyfin/jellyfin/issues/17319), [jellyfin#16880](https://github.com/jellyfin/jellyfin/issues/16880), [jellyfin#17177](https://github.com/jellyfin/jellyfin/issues/17177), [jellyfin-web#8072](https://github.com/jellyfin/jellyfin-web/pull/8072). Encoding UI: [`jellyfin_web_live_stream`](patches.md#jellyfin_web_live_streampatch).

## Playback / encoding tooling

**What:** Lazy transcoding pipeline probe exposed to admins; hardware encoder capability API + dashboard; HLS remux restart behaviour; HDR10+ SEI strip on MPEG-TS; Chrome/Opera MKV DirectPlay false-positive fix; **transcode codec fallback** (parallel AV1/H.264 init race, sequential encoder chain, Activity Log alerts, dashboard toggles).

**Where:** [Playback / encoding group](patches.md#3-playback--encoding). Codec fallback: [`jellyfin_z_transcode_codec_fallback`](patches.md#jellyfin_z_transcode_codec_fallbackpatch) + [`jellyfin_web_z_transcode_codec_fallback`](patches.md#jellyfin_web_z_transcode_codec_fallbackpatch). Upstream: [jellyfin#13668](https://github.com/jellyfin/jellyfin/issues/13668), [jellyfin#16823](https://github.com/jellyfin/jellyfin/issues/16823), [jellyfin-web#7651](https://github.com/jellyfin/jellyfin-web/issues/7651).

**How (codec fallback):** Enabled by default (`EnableTranscodeCodecFallback`, `EnableParallelCodecRace` in Dashboard → Playback → Transcoding). When AV1 encode fails at HLS init, the server races or falls back to H.264 (etc.), 302-redirects the client to the winning playlist, and writes deduplicated Activity Log entries. Devices → playback info shows an `AV1 → H.264 fallback` badge when active.

## Playback error messaging

**What:** Structured playback failure codes from the server and a friendlier web dialog (summary, tip, Try Again / Try with Transcoding). Mid-stream HLS failures expose intent via the `X-Playback-Error-Code` response header; pre-play failures use `PlaybackInfoResponse.errorCode` (+ optional `message`).

**Where:** [`jellyfin_zzz_playback_errors`](patches.md#jellyfin_zzz_playback_errorspatch) + [`jellyfin_web_zzzz_playback_errors`](patches.md#jellyfin_web_zzzz_playback_errorspatch).

**Web behaviour:** Title “Couldn't play this”; localized `PlaybackErrorFriendly.*` strings; one automatic reconnect attempt on `LiveStreamFenced` before showing the dialog.

**Client contract (mobile / third-party):**

| Phase | Source | Action |
|---|---|---|
| Pre-play | `PlaybackInfoResponse.errorCode` (PascalCase default; camelCase with `Accept: application/json; profile="CamelCase"`) | Map code to platform strings; optional `message` is English fallback only |
| Mid-play | `X-Playback-Error-Code` on failed manifest/segment HTTP responses; optional JSON `{ errorCode }` on API errors | Prefer header; fall back to generic network/server error if missing |
| `LiveStreamFenced` | 503 + code | Restart playback (web auto-retries once) |
| `TranscodeFailed` / `TranscodeNotAllowed` | 500 / 403 | Suggest retry or ask admin about transcoding permissions |
| `NotAllowed` | 403 at PlaybackInfo | Policy denial — contact admin |

Extend `@jellyfin/sdk` `PlaybackErrorCode` when bumping Jellyfin tags (new enum values: `TranscodeFailed`, `TranscodeNotAllowed`, `StreamUnavailable`, `LiveStreamFenced`).

## Parental library images

**What:** Library/collection/splash images respect parental filters so restricted users do not see collage tiles from blocked titles.

**Where:** [`jellyfin_library_image_parental`](patches.md#jellyfin_library_image_parentalpatch).

## Active-standby HA (opt-in)

**What:** One writer at a time: PostgreSQL advisory lock, leader-only library watchers/scheduled tasks/recording timers, `/health/ready`, `X-Jellyfin-Leader-Epoch` / `X-Jellyfin-Ha-Role` headers, Live TV `LiveStreamFenced` 503, flush coalesced progress on shutdown, optional Redis progress overlay.

**Where:** Plugin [`Jellyfin.Plugin.Pgsql/Ha/`](../Jellyfin.Plugin.Pgsql/Ha/); patch [`jellyfin_z_ha_leadership`](patches.md#jellyfin_z_ha_leadershippatch). Env: [README](../README.md#active-standby-ha-optional).

**How:** `Pgsql_HA_ENABLED=true`. Fail-closed until the lock is held. EF migrations take a separate blocking advisory lock so two boots cannot interleave DDL. HLS VOD already restarts ffmpeg from the requested segment; Live TV is not retuned.

## TV / webOS UX

**What:** Infinite scroll on library views, TV focus/nav helpers, capped home-row / lazy-load pressure, webOS 5 / older Chromium workarounds, Quick Connect-first login on TV, lighter play-start (simple spinner + deferred webOS fullscreen), and Live TV Multiview fully disabled on webOS / TV clients.

**Where:** [TV UX group](patches.md#8-tv--web-ux); play-start: [`jellyfin_web_zzzz_tv_playback_perf`](patches.md#jellyfin_web_zzzz_tv_playback_perfpatch); Multiview off on TV: [`jellyfin_web_zzz_livetv_multiview`](patches.md#jellyfin_web_zzz_livetv_multiviewpatch).

## Background media QoS (scan / segments / chapters)

**What:** Library scan, media-segment extraction, and chapter-image work yield while playback is active and use more conservative unset concurrency defaults so the server stays usable under load.

**Where:** [`jellyfin_background_media_qos`](patches.md#jellyfin_background_media_qospatch); PG index `IX_MediaSegments_ItemId` (`AddMediaSegmentsItemIdIndex`, restored after the rc5 sync drop by `RestoreMediaSegmentsItemIdIndex`); batched `HasSegments` in [`jellyfin_zzzz_people_query_perf`](patches.md#jellyfin_zzzz_people_query_perfpatch).

**How:** Raise throughput explicitly via `LibraryScanFanoutConcurrency` and/or `ParallelImageEncodingLimit` in server config if overnight jobs should use more cores. Segment extraction skips items that already have provider rows (`forceOverwrite: false`). Extreme scan memory/OOM is unchanged — see [known issues](known-issues.md).

## Library / plugin reliability

**What:** Path-aware media refresh; BaseItem image-info dedupe; person provider-key identity; fix plugin ALC so transitive deps (for example Redis) resolve from `.deps.json`. Disabled-plugin cleanup is stock Jellyfin as of v12.0-rc5 ([jellyfin#15897](https://github.com/jellyfin/jellyfin/issues/15897)). Descendant-query memory fixes are stock as of v12.0-rc6 ([jellyfin#17602](https://github.com/jellyfin/jellyfin/issues/17602)). Automated subtitle download is skipped when “Save subtitles into media folders” targets a read-only media mount ([`jellyfin_subtitle_ro_skip`](patches.md#jellyfin_subtitle_ro_skippatch)) — uncheck that option (save under Jellyfin metadata) or remount RW if you want downloads.

**Where:** [Library / metadata group](patches.md#5-library--metadata--plugin-loading); favorites-during-progress fix [jellyfin#14981](https://github.com/jellyfin/jellyfin/issues/14981).
