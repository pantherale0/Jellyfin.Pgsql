# Features

This page maps the operator-facing features in the fork to the plugin, UI Next, and server patches that implement them. The root [README](../README.md) owns configuration and setup instructions.

## UI Next web client

**What:** UI Next is the only web client in the standard image. The Jellyfin-version and `latest` tags serve it at `/web`.

**Where:** Client source, tests, and translations live in [`ui-next/`](../ui-next/). The [`Dockerfile`](../docker/Dockerfile) builds UI Next and sets `JELLYFIN_WEB_DIR=/jellyfin/ui-next`.

**What it includes:** UI Next supports password, OIDC, and Quick Connect sign-in. It includes home and library browsing, search, details, video and music playback, Live TV, DVR, playlists, favorites, and metadata editing. Seerr requests and taste features are also available. The administrator workspace covers users, libraries, playback, Live TV, metadata, infrastructure, activity, and system settings. Its System page edits per-device playback overrides, and Playback shows active transcoding pipelines when the server reports them. The [UI Next guide](../ui-next/README.md) lists current capabilities, development steps, security notes, and compatibility limits.

UI Next prefetches full item details for the active home recommendation. Poster cards start a prefetch after 200 ms of pointer hover or when keyboard or TV focus enters. Opening a title uses ready data or joins the request while the detail view loads.

The administrator workspace includes its own Metadata manager. The image does not include Jellyfin Web, and the custom Jellyfin Web patch stack has been removed. See the [confirmed UI Next gaps](#features-not-yet-in-ui-next) below.

**How to configure it:** See [UI Next image](../README.md#ui-next-image), [SSO](../README.md#single-sign-on-sso-with-rbac-via-oauth2oidc), and the [UI Next guide](../ui-next/README.md).

### Features not yet in UI Next

This non-exhaustive list covers confirmed gaps against the removed fork-specific Jellyfin Web patches. It does not compare UI Next with every feature in stock Jellyfin Web.

- **Live TV Multiview player:** UI Next can display and edit the server's Multiview permission, but it cannot play several Live TV channels at once. The server permission and APIs remain available to clients that implement Multiview.
- **Remote YouTube trailer playback:** The trailer plugin can resolve and relay public YouTube trailers, but UI Next lists local trailers only. It has no action to start remote trailer playback. See [Remote YouTube trailers](#remote-youtube-trailers).

## PostgreSQL database provider

**What:** Jellyfin stores its system database in PostgreSQL instead of SQLite.

**Where:** [`Jellyfin.Plugin.Pgsql`](../Jellyfin.Plugin.Pgsql/), Docker entrypoint `POSTGRES_*` wiring, and [`docker/database.xml`](../docker/database.xml).

**How:** The plugin registers as a custom database provider. Images set connection parameters from environment variables. `Pgsql_COMMAND_TIMEOUT` raises Npgsql's command timeout for heavy library queries.

**Related:** The README covers [SQLite-to-PostgreSQL migration](../README.md#migrating-from-sqlite-to-postgresql). See [known issues](known-issues.md) for scale caveats.

## Query cache and PostgreSQL query optimization

**What:** The plugin can cache home Latest and Resume ID lists and stable library `/Items` pages. It can also replace supported Latest and Resume queries with PostgreSQL-specific selectors.

**Where:** [`Jellyfin.Plugin.Pgsql/Query/`](../Jellyfin.Plugin.Pgsql/Query/). Configure the `Pgsql_CACHE_*`, `Pgsql_PG_OPTIMIZE_*`, and `REDIS_CONNECTION_STRING` settings in the [README](../README.md#query-cache-and-optimisation-optional-experimental).

**How:** Cache keys include the user and query boundaries. Redis failures fall back to the in-process memory cache. Supported Resume requests select candidates from positive playback-progress rows before loading item details; unsupported filters use Jellyfin's core query.

Server query patches include [`jellyfin_home_api_performance`](patches.md#jellyfin_home_api_performancepatch), [`jellyfin_unoptimized_query_fixes`](patches.md#jellyfin_unoptimized_query_fixespatch), [`jellyfin_query_split_userdata`](patches.md#jellyfin_query_split_userdatapatch), and the [library browse performance patch](patches.md#jellyfin_z_items_browse_perfpatch). See the [README query section](../README.md#query-cache-and-optimisation-optional-experimental) for limits and trade-offs.

## PostgreSQL fuzzy search

**What:** The plugin adds PostgreSQL-backed fuzzy and franchise-oriented search. Jellyfin's SQL search provider is disabled when the plugin provider is active, avoiding duplicate results.

**Where:** [`Jellyfin.Plugin.Pgsql/Search/`](../Jellyfin.Plugin.Pgsql/Search/), [`jellyfin_search_performance`](patches.md#jellyfin_search_performancepatch), and [`jellyfin_disable_sql_search_provider`](patches.md#jellyfin_disable_sql_search_providerpatch). UI Next provides the search interface.

**How:** The plugin registers an `ISearchProvider` and uses `pg_trgm` indexes for supported title and metadata matches.

## Single Sign-On and RBAC

**What:** OIDC login can create users, assign administrator access from IdP roles, set parental ratings from birthdate claims, and apply per-group library, permission, tag, and Live TV policies.

**Where:** [`jellyfin_sso`](patches.md#jellyfin_ssopatch), [`jellyfin_z_livetv_rbac_allowlist`](patches.md#jellyfin_z_livetv_rbac_allowlistpatch), and [`jellyfin_startup_secret_redaction`](patches.md#jellyfin_startup_secret_redactionpatch). UI Next provides the sign-in flow and SSO mapping editor.

**How:** The server uses the configured absolute `JELLYFIN_SSO_OIDC_REDIRECT_URI`. UI Next uses the one-time code flow for allowlisted separate origins and same-origin callback credentials otherwise. It also offers Quick Connect and password sign-in. The root [README SSO section](../README.md#single-sign-on-sso-with-rbac-via-oauth2oidc) documents setup.

## Playback statistics

**What:** The server records playback activity and daily rollups, then exposes user and administrator statistics APIs. UI Next provides playback statistics views.

**Where:** [`jellyfin_playback_statistics`](patches.md#jellyfin_playback_statisticspatch) and [`jellyfin_playback_progress_coalesce`](patches.md#jellyfin_playback_progress_coalescepatch).

## Remote YouTube trailers

**What:** The plugin resolves public YouTube trailers with a pinned `yt-dlp` binary and relays them through Jellyfin. Trailer playback does not affect resume state, played status, playback statistics, or taste recommendations.

**Where:** Plugin `Trailers/` and `TrailerController`; [`jellyfin_trailer_history`](patches.md#jellyfin_trailer_historypatch). UI Next currently lists local trailers only.

**Limits:** Adaptive-only streams use Jellyfin's configured ffmpeg and do not support byte-range seeking. Remote trailer playback uses server bandwidth. See [README configuration](../README.md#remote-youtube-trailers).

## Taste profiles and recommendations

**What:** The plugin builds per-user taste profiles and recommendations for UI Next's For You and similar-title views. Administrators can inspect taste-model evaluation results.

**Where:** [`Jellyfin.Plugin.Pgsql/Taste/`](../Jellyfin.Plugin.Pgsql/Taste/), UI Next's profile and home views, and the server schema patches [`jellyfin_user_taste_profiles`](patches.md#jellyfin_user_taste_profilespatch), [`jellyfin_user_taste_recommendations`](patches.md#jellyfin_user_taste_recommendationspatch), and [`jellyfin_zz_user_taste_because_you`](patches.md#jellyfin_zz_user_taste_because_youpatch).

**How:** The plugin stores user profiles and scheduled recommendation results. Neural serving is off by default. See the taste settings in the plugin and UI Next administrator workspace.

## Seerr and Beyond Your Library

**What:** UI Next can show Seerr request status and request actions in search, and can add personalized Beyond Your Library rows to the home feed.

**Where:** [`Jellyfin.Plugin.Seerr`](../Jellyfin.Plugin.Seerr/) and UI Next's `seerr.ts` and `seerr-views.tsx`. The server's [`jellyfin_z_beyond_your_library_home`](patches.md#jellyfin_z_beyond_your_library_homepatch) adds the home-section type.

**How:** Configure the Seerr URL and API key in the plugin. The key stays on the server. UI Next hides Seerr controls when the gateway is disabled or unavailable.

## Emby userdata import and user merge

**What:** Administrators can upload Emby SQLite userdata, preview mappings, and import or transfer progress and favorites. UI Next requires a server-signed preview token before a transfer can run.

**Where:** Plugin `Api/EmbyImport*` and `Admin/EmbyImport/`; UI Next administrator workspace under Users & access.

## Live TV hardening

**What:** Server patches improve guide queries, published URLs, tuner lifecycle, HLS stream opening, and recovery from stalled sources. UI Next includes On Now, Guide, Channels, and DVR views.

**Where:** See the [Live TV patch group](patches.md#4-live-tv). The UI Next guide documents the client behavior and its browser playback path.

## Playback and transcoding

**What:** Server patches add transcoding diagnostics, hardware capability reporting, codec fallback, playback error codes, device-specific playback settings, and HLS lifecycle fixes. UI Next includes a player with device-memory-based HLS.js VOD buffer targets and up to ten minutes of lookahead. Its seek bar distinguishes buffered from played media. After three confirmed stalls in 60 seconds, the player attempts up to two lower-bitrate renegotiations. When a movie ends without a queued title, the player offers similar titles to play next. Live TV follows the available playlist rather than buffering ten minutes ahead. UI Next also includes an administrator Transcoding page and a stage graph for active transcoding sessions.

UI Next prefers HLS.js for HLS playback and falls back to native HLS when HLS.js is unsupported. It uses HLS.js for Live TV EVENT playlists when supported, even when `canPlayType()` reports `maybe`. During transcoded HLS VOD playback, UI Next requests the segment at the seek position with its timeline offset. Jellyfin's dynamic HLS controller uses that offset to restart ffmpeg at the target segment.

**Where:** See the [Playback and encoding patch group](patches.md#3-playback--encoding), including [`jellyfin_transcoding_pipeline`](patches.md#jellyfin_transcoding_pipelinepatch), [`jellyfin_z_transcode_codec_fallback`](patches.md#jellyfin_z_transcode_codec_fallbackpatch), and [`jellyfin_zzzzzzz_hls_remux_segment_restart`](patches.md#jellyfin_zzzzzzz_hls_remux_segment_restartpatch).

**Limits:** The graph follows the server's ordered stage list and edge labels; it does not infer branch connections. Pipeline details are unavailable when the server cannot report them. See [known issues](known-issues.md) for client compatibility and transcoding caveats.

## Media resource security

**What:** Subtitle streams and video attachments require authentication and respect library visibility. Attachments download instead of opening as active documents under Jellyfin's origin.

**Where:** [`jellyfin_zzzzzz_media_resource_security`](patches.md#jellyfin_zzzzzz_media_resource_securitypatch). UI Next supplies tokens for subtitle requests.

## Active-standby high availability

**What:** PostgreSQL advisory locking selects one Jellyfin writer. Standby instances fail readiness checks, while leader epochs and role headers let clients detect failover.

**Where:** Plugin [`Jellyfin.Plugin.Pgsql/Ha/`](../Jellyfin.Plugin.Pgsql/Ha/) and [`jellyfin_z_ha_leadership`](patches.md#jellyfin_z_ha_leadershippatch). UI Next shows role and readiness information in the administrator workspace.

**How to configure it:** Set `Pgsql_HA_ENABLED=true`. See [README HA settings](../README.md#active-standby-ha-optional) and [known issues](known-issues.md).

## UI Next TV and accessibility behavior

**What:** UI Next supports keyboard and remote navigation, responsive TV layouts, Quick Connect, a D-pad guide, focus management for dialogs, and TV-specific playback controls.

**Where:** [`ui-next/`](../ui-next/) and its [end-to-end tests](../ui-next/README.md#end-to-end-tests). The tests emulate a webOS user agent; they do not verify a physical TV or wrapper.

## Background media work and plugin reliability

**What:** Server patches limit background scan, segment, and chapter-image work during playback. Other patches fix library refresh, metadata identity, image-info duplicates, plugin dependency loading, and automated subtitle downloads on read-only media mounts.

**Where:** [`jellyfin_background_media_qos`](patches.md#jellyfin_background_media_qospatch), [`jellyfin_media_updated_path_refresh`](patches.md#jellyfin_media_updated_path_refreshpatch), [`jellyfin_zz_person_provider_identity`](patches.md#jellyfin_zz_person_provider_identitypatch), [`jellyfin_dedupe_baseitem_image_infos`](patches.md#jellyfin_dedupe_baseitem_image_infospatch), [`jellyfin_plugin_load_context_deps`](patches.md#jellyfin_plugin_load_context_depspatch), and [`jellyfin_subtitle_ro_skip`](patches.md#jellyfin_subtitle_ro_skippatch).

See [known issues](known-issues.md) for remaining limits.
