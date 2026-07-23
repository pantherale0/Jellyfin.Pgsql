# Patch catalog

Every file under [`patches/`](../patches/) applied by [`scripts/apply-patches.sh`](../scripts/apply-patches.sh). Naming and apply order: [architecture](architecture.md#patch-routing-and-apply-order).

For each patch: **What** (behaviour), **Why** (motivation), **Where** (key paths), **How** (mechanism), **Related** (issues/PRs/companions). Issue links are only cited when verified; otherwise “no public issue”.

---

## 1. Auth / SSO / security

### `jellyfin_sso.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Adds OIDC/OAuth2 SSO endpoints and login integration, including group RBAC apply (libraries, permissions, block-unrated, Allowed/Blocked tags, Live TV allowlists) and `GET /sso/rbac/livetv` for the dashboard picker. |
| **Why** | Stock Jellyfin has no built-in IdP login; this fork needs forced SSO + RBAC for shared deployments. |
| **Where** | `Jellyfin.Api/Controllers/SSOController.cs` |
| **How** | New controller handles authorize/callback/session flows driven by `JELLYFIN_SSO_OIDC_*` env configuration; matching `sso_rbac.json` groups merge preferences additively on login (blocking Live TV unrated also blocks `LiveTvProgram`). |
| **Related** | Companion web: `jellyfin_web_rbac`, `jellyfin_web_tv_quickconnect_login`. Enforcement/persist: `jellyfin_z_livetv_rbac_allowlist`. README SSO section. Fork [pantherale0#5](https://github.com/pantherale0/Jellyfin.Pgsql/issues/5) (SSO mappings UI auth). |

### `jellyfin_web_rbac.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Dashboard SSO mappings UI for OIDC groups: libraries, permissions, block-unrated, Allowed/Blocked tags, and Live TV channel/category allowlists. |
| **Why** | Admins need a first-class UI to map IdP groups to parental settings (including Live TV exceptions) without editing config files. |
| **Where** | `SSOMappings.tsx`, user `Profile.tsx`, users edit/index routes |
| **How** | Admin pages call `/sso/rbac/config`, `/sso/rbac/libraries`, and `/sso/rbac/livetv` with CamelCase Accept profile. |
| **Related** | Server `jellyfin_sso`, `jellyfin_z_livetv_rbac_allowlist`. [pantherale0#5](https://github.com/pantherale0/Jellyfin.Pgsql/issues/5). |

### `jellyfin_web_tv_quickconnect_login.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | On TV clients, skip forced SSO redirect and open Quick Connect on the login page. |
| **Why** | TV browsers / webOS wrappers cannot complete IdP redirects reliably. |
| **Where** | `controllers/session/login/index.js` |
| **How** | Detect TV client; auto-start Quick Connect instead of OIDC redirect. |
| **Related** | `jellyfin_sso`, `jellyfin_web_quickconnect_modal`. No public issue. |

### `jellyfin_web_quickconnect_modal.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Quick Connect dialog reachable from user menu / settings, not only the dedicated page. |
| **Why** | Phone/desktop approval of TV codes should be one click from a logged-in session. |
| **Where** | `QuickConnectDialog.tsx`, quickConnect routes, `AppUserMenu.tsx` |
| **How** | Modal component + menu entry; simplifies QC page shell. |
| **Related** | `jellyfin_web_tv_quickconnect_login`. No public issue. |

### `jellyfin_security_hardening.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Hardens auth claims and media endpoints so share links cannot elevate; scopes access with share metadata. Requires `[Authorize]` on legacy HLS segment routes. |
| **Why** | Media share tokens must not grant Administrator; stream/image/subtitle routes need share-aware authorization. |
| **Where** | `CustomAuthenticationHandler`, authorization handlers, `Audio`/`Videos`/`Hls`/`Image`/`LiveTv`/`Subtitle`/… controllers, `AuthorizationContext` |
| **How** | Adds `IsMediaShareLink` / `ShareItemId` claims; blocks elevation for share auth; permission checks on media controllers. |
| **Related** | Companion `jellyfin_web_security_hardening`; requires `jellyfin_z_hls_live_playlist_apikey` so Live/EVENT playlists embed `ApiKey` on segment URIs (RFC 3986). No public issue. |

### `jellyfin_web_security_hardening.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Client companions: configuration-page subresource API keys; copy-stream uses expiring share links. |
| **Why** | Plugin config HTML loads scripts/CSS without Authorization headers; embedding session API keys in copyable stream URLs is unsafe. |
| **Where** | `ServerContentPage.tsx`, `itemContextMenu.js`, `viewContainer.js`, `ServerConnections.js`, `utils/dashboard.js` |
| **How** | Rewrites configurationpage URLs with API key query; POST `Items/{id}/ShareLinks` for copy-stream. |
| **Related** | `jellyfin_security_hardening`. No public issue. |

### `jellyfin_userdata_userid.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Strengthens `RequestHelpers.GetUserId` (query/route coalesce; API-key admin treatment) for userdata item routes. |
| **Why** | User-scoped userdata endpoints must enforce self-or-admin consistently, including API-key clients. |
| **Where** | `ItemsController.cs`, `RequestHelpers.cs`, tests |
| **How** | Optional `HttpRequest` coalesces userId; treats API keys like administrators for cross-user access checks. |
| **Related** | AGENTS.md IDOR guidance. No public issue. |

---

## 2. Postgres / query performance

### `jellyfin_unoptimized_query_fixes.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Fixes expensive library/item/TV query shapes and adds supporting indexes. |
| **Why** | Large libraries on Postgres amplify N+1 and unindexed filters that were tolerable on SQLite. |
| **Where** | `LibraryManager`, `ItemsController`, `TVSeriesManager`, `BaseItemRepository.*`, `LinkedChildrenService`, query-index migration |
| **How** | Query rewrites + `AddQueryPerformanceIndexes` migration (mirrored to PG via sync). |
| **Related** | Motivated by scale reports such as upstream [JPVenson#34](https://github.com/JPVenson/Jellyfin.Pgsql/issues/34) / [#35](https://github.com/JPVenson/Jellyfin.Pgsql/issues/35) (context, not a direct fix ticket). |

### `jellyfin_home_api_performance.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Speeds NextUp / TV series home paths; adds UserData playback-position index. |
| **Why** | Home screen NextUp is a hot path on large episode libraries. |
| **Where** | `TVSeriesManager.cs`, `NextUpService.cs`, `UserDataConfiguration`, index migration |
| **How** | Query/batch improvements + index on `(UserId, PlaybackPositionTicks)`-style access. |
| **Related** | Plugin `Query/` NextUp caching. No public issue. |

### `jellyfin_query_split_userdata.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Splits UserData join/load for resume-style ordering queries. |
| **Why** | Combined joins blow up plans under Postgres for resume/latest-adjacent queries. |
| **Where** | `BaseItemRepository.QueryBuilding.cs`, `Querying.cs` |
| **How** | Separate UserData fetch/merge instead of a single heavy join. |
| **Related** | No public issue. |

### `jellyfin_search_performance.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Introduces pluggable search provider interfaces and SQL search improvements. |
| **Why** | Enables the PostgreSQL fuzzy provider and cleaner Items search routing. |
| **Where** | `SearchManager`, `SqlSearchProvider`, `ISearchProvider*`, `ItemsController`, `TranslateQuery` |
| **How** | `ISearchManager`/`ISearchProvider` plumbing; SQL provider kept as fallback unless disabled. |
| **Related** | `jellyfin_disable_sql_search_provider`; plugin `Search/`. No public issue. |

### `jellyfin_disable_sql_search_provider.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Excludes core `SqlSearchProvider` when composing search parts; prefers PostgreSQL similarity provider for Similar. |
| **Why** | Avoid duplicate/conflicting search scorers when the PG plugin is loaded. |
| **Where** | `ApplicationHost.cs` |
| **How** | Filters `GetExports<ISearchProvider>()`; orders Similar providers with “PostgreSQL Similarity” first. |
| **Related** | `jellyfin_search_performance`. No public issue. |

### `jellyfin_playback_progress_coalesce.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Coalesces PlaybackProgress UserData writes (time/seek thresholds). |
| **Why** | Progress spam hammers Postgres during watch sessions. |
| **Where** | `SessionManager.cs` |
| **How** | Skip redundant progress persistence until interval or seek threshold. |
| **Related** | Header comment in patch. No public issue. |

### `jellyfin_latest_tv_always_series.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Latest TV paths consistently return series containers. |
| **Why** | Align Latest TV presentation with series-centric UX and PG Latest optimisations. |
| **Where** | `UserLibraryController.cs`, `BaseItemRepository.Querying.cs` |
| **How** | Adjust Latest TV grouping/container selection. |
| **Related** | Plugin TV Latest optimisation (README trade-off: re-check on upgrades). No public issue. |

---

## 3. Playback / encoding

### `jellyfin_transcoding_pipeline.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Lazy transcoding pipeline probe; exposes Speed/buffer/pipeline on `TranscodingInfo`; strips HW detail for non-admins. |
| **Why** | Admins need visibility into ffmpeg graph stages without probing every session for every client. |
| **Where** | `TranscodeManager`, `TranscodingPipelineProbe`/`Classifier`/`GraphParser`, session WebSocket, models |
| **How** | `EnsureProbed` on admin GetSessions; `RegisterPending` at ffmpeg start. |
| **Related** | Companion `jellyfin_web_transcoding_pipeline`. No public issue. |

### `jellyfin_web_transcoding_pipeline.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Renders transcoding pipeline graph on session/device cards. |
| **Why** | Surface server pipeline probe data in the dashboard. |
| **Where** | `TranscodingPipelineGraph.tsx`, `DeviceCard.tsx`, strings |
| **How** | React graph from pipeline DTO fields. |
| **Related** | `jellyfin_transcoding_pipeline`. No public issue. |

### `jellyfin_hwa_capabilities.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | API to report media encoder / hardware acceleration capabilities. |
| **Why** | Transcoding settings UI needs accurate HW codec lists from the running ffmpeg build. |
| **Where** | `MediaEncoderController.cs`, `HardwareCapabilityResolver`, capability models |
| **How** | Resolves decoder/encoder names from ffmpeg and returns structured capabilities. |
| **Related** | Companion `jellyfin_web_hwa_capabilities`. No public issue. |

### `jellyfin_web_hwa_capabilities.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Dashboard playback/transcoding page consumes HW capability API. |
| **Why** | Make encoder options reflect real hardware instead of static guesses. |
| **Where** | `useMediaEncoderCapabilities.ts`, `transcoding.tsx`, strings |
| **How** | React Query hook + form wiring. |
| **Related** | `jellyfin_hwa_capabilities`. Prerequisite for Live TV keep-seconds UI layering. |

### `jellyfin_hls_remux_segment_restart.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Avoids thrash-restarting ffmpeg near EOF during HLS remux segment requests. |
| **Why** | Clients requesting late segments caused repeated `-ss`/`-start_number` restarts. |
| **Where** | `DynamicHlsController.cs`, `EncodingHelper.cs`, `DynamicHlsPlaylistGenerator.cs` |
| **How** | Smarter restart/playlist logic for remux jobs. |
| **Related** | [jellyfin#13668](https://github.com/jellyfin/jellyfin/issues/13668). |

### `jellyfin_z_hls_live_playlist_apikey.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Appends the request query string (`ApiKey`, etc.) to every URI in Live/EVENT HLS playlists served by `GetLivePlaylistText`. |
| **Why** | After `jellyfin_security_hardening` requires `[Authorize]` on legacy `/Videos/.../hls/...` segments, clients 401 because RFC 3986 relative resolution does not inherit the playlist URL’s query (ffmpeg emits bare `hls/{id}/N.ts` lines). Dynamic `hls1` already forwarded `Request.QueryString`; live did not. |
| **Where** | `HlsHelpers.cs`, `DynamicHlsController.cs`, comments on `HlsSegmentController` segment actions |
| **How** | `AppendQueryStringToPlaylistUris` rewrites media URI lines and `#EXT-X-MAP` URIs; call site passes `Request.QueryString`. Apply-order `z_` so it runs after security hardening. |
| **Related** | `jellyfin_security_hardening`. Upstream context [jellyfin#13984](https://github.com/jellyfin/jellyfin/issues/13984). |

### `jellyfin_hdr10plus_mpegts_sei.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Strips HDR10+ SEI when remuxing to MPEG-TS (beyond Dolby Vision player special-cases). |
| **Why** | Plain/hybrid HDR10+ in MPEG-TS remuxes causes client playback issues. |
| **Where** | `EncodingHelper.cs`, tests |
| **How** | Extend HDR10+ strip conditions for MPEG-TS remux. |
| **Related** | [jellyfin#16823](https://github.com/jellyfin/jellyfin/issues/16823). |

### `jellyfin_web_chrome_mkv_directplay.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Disables false-positive MKV DirectPlay on Chrome/Opera so remux via HLS is chosen when needed. |
| **Why** | Chromium reports MKV support incorrectly; DirectPlay then fails at play time. |
| **Where** | `browserDeviceProfile.js` |
| **How** | Device profile tweak for Chrome/Opera MKV. |
| **Related** | [jellyfin-web#7651](https://github.com/jellyfin/jellyfin-web/issues/7651). |

---

## 4. Live TV

### `jellyfin_livetv_performance.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Guide/listings/tuner path performance; channel StartDate index. |
| **Why** | Large XMLTV / many channels make guide builds and queries expensive on Postgres. |
| **Where** | `GuideManager`, `ListingsManager`, `LiveTvManager`, `XmlTvListingsProvider`, `M3uParser`, BaseItem config + migration |
| **How** | Batching/caching/query tweaks + index migration. |
| **Related** | No public issue. |

### `jellyfin_livetv_published_url.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Rewrites Live TV stream file URLs to published/smart API URLs instead of unreachable Docker bridge IPs. |
| **Why** | Clients outside the container network cannot play tuner buffers advertised with bridge addresses. |
| **Where** | `MediaInfoHelper`, `NetworkManager`, media/audio controllers, tests |
| **How** | Vendored [jellyfin#17298](https://github.com/jellyfin/jellyfin/pull/17298): clone responses and rewrite `/LiveTv/LiveStreamFiles/` via `GetSmartApiUrl`; keep local buffer URL for ffmpeg. |
| **Related** | [jellyfin#15411](https://github.com/jellyfin/jellyfin/issues/15411). |

### `jellyfin_z_livetv_rbac_allowlist.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Persists M3U `group-title` as `LiveTvChannel.ChannelGroup` (plus `ChannelGroup:` tags), adds Live TV allowlist preference kinds, and enforces channel/category exceptions to block-unrated and AllowedTags for Live TV. |
| **Why** | Blocking unrated Live TV hides nearly all channels; operators need group-scoped allowlists for safe kids/shared profiles. |
| **Where** | `BaseItem` (`IsParentalAllowed` made virtual), `LiveTvChannel`, `LiveTvProgram`, `LiveTvParentalAccess`, `GuideManager`, `PreferenceKind`, `BaseItemRepository` access filters |
| **How** | Whitelist by channel id and/or category (M3U group or EPG Kids/Sports/News); SQL expands categories to channel ids; in-memory parental checks bypass unrated + AllowedTags for matches (BlockedTags still apply). Applies after `jellyfin_sso` (`z_` layering). |
| **Related** | `jellyfin_sso`, `jellyfin_web_rbac`. No public issue. |

### `jellyfin_livetv_stream_buffer.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Rolling chunk live stream buffers + `LiveStreamKeepSeconds` encoding option. |
| **Why** | Unbounded buffer growth exhausted disk; streams need bounded retention after client stop. |
| **Where** | `RollingChunkStream.cs`, `LiveStream.cs`, HDHR/HTTP tuner hosts, `EncodingOptions` |
| **How** | Vendored [jellyfin#17128](https://github.com/jellyfin/jellyfin/pull/17128). |
| **Related** | Web UI `jellyfin_web_live_stream_keep_seconds`. Must precede `jellyfin_livetv_stream_probe`. |

### `jellyfin_livetv_stream_probe.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Configurable Live TV probe delay / analyzeduration / probesize. |
| **Why** | Default probe behaviour delays channel start on slow tuners. |
| **Where** | `LiveStreamHelper`, `MediaSourceManager`, `MediaEncoder`, `EncodingOptions`, `MediaSourceInfo` |
| **How** | Encoding options + probe wiring. **Apply after** `jellyfin_livetv_stream_buffer`. |
| **Related** | [jellyfin#9813](https://github.com/jellyfin/jellyfin/issues/9813); web `jellyfin_web_live_stream_probe`. |

### `jellyfin_web_live_stream_keep_seconds.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Encoding settings UI for `LiveStreamKeepSeconds`. |
| **Why** | Expose server buffer retention without editing XML. |
| **Where** | `transcoding.tsx`, strings |
| **How** | Vendored [jellyfin-web#8072](https://github.com/jellyfin/jellyfin-web/pull/8072); layered on HWA capabilities UI. |
| **Related** | [jellyfin#17128](https://github.com/jellyfin/jellyfin/pull/17128); server `jellyfin_livetv_stream_buffer`. |

### `jellyfin_web_live_stream_probe.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Encoding settings UI for Live TV probe options. |
| **Why** | Companion to server probe patch. |
| **Where** | `transcoding.tsx`, strings |
| **How** | Form fields for delay/analyzeduration/probesize. **After** keep_seconds patch. |
| **Related** | [jellyfin#9813](https://github.com/jellyfin/jellyfin/issues/9813). |

### `jellyfin_livetv_getitem_alias.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | `GET Items/{itemId}` accepts alias `livetv` for the Live TV view (string route). |
| **Why** | Clients/bookmarks use a stable Live TV alias instead of a raw GUID. |
| **Where** | `UserLibraryController.cs` |
| **How** | Route `itemId` as string; resolve `livetv` via `ILiveTvManager`. |
| **Related** | No public issue. |

### `jellyfin_web_dashboard_active_recordings.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Dashboard widget listing active Live TV recordings. |
| **Why** | Operators need at-a-glance recording status on the home dashboard. |
| **Where** | `ActiveRecordingsWidget.tsx`, dashboard `index.tsx` |
| **How** | Widget fetches in-progress recordings via `apps/legacy/.../useRecordings` and renders on the dashboard. |
| **Related** | No public issue. |

---

## 5. Library / metadata / plugin loading

### `jellyfin_library_image_parental.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Parental filtering for library/collection/splash collage images; refresh on user parental changes. |
| **Why** | Restricted users could see artwork from titles they cannot play. |
| **Where** | `LibraryImageParentalFilter`, collection image providers, splash post-scan, event notifier, `UserManager` |
| **How** | Filter candidate items by parental rules; notify refresh when ratings change. |
| **Related** | No public issue. |

### `jellyfin_dedupe_baseitem_image_infos.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Deduplicate BaseItem image info rows and enforce a unique index. |
| **Why** | Duplicate image-info rows break uniqueness and waste storage/query time. |
| **Where** | `BaseItemMapper`, `ItemPersistenceService`, image-info configuration, dedupe routine + unique index migration, tests |
| **How** | Mapper/persistence dedupe; migration cleans existing duplicates then adds unique index. |
| **Related** | No public issue. |

### `jellyfin_media_updated_path_refresh.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Path-aware library refresh when media files/folders change (including movie folder cases). |
| **Why** | Narrow refreshes missed parent/folder updates after path moves. |
| **Where** | `FileRefresher.cs`, `LibraryMonitor.cs` |
| **How** | Expand affected paths / refresh targeting for directory updates. |
| **Related** | No public issue. |

### `jellyfin_zz_person_provider_identity.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Person identity keyed by provider IDs (`ProviderKey`) rather than name-only merging. |
| **Why** | Name collisions duplicate or merge distinct people incorrectly. |
| **Where** | `PersonIdentity`, `PeopleRepository`, `PeopleHelper`, NFO saver, people validation task, people migration, DTO mapping |
| **How** | Persist provider key; validation/merge uses identity helper; `zz_` applies last among server patches. |
| **Related** | No public issue. |

### `jellyfin_disabled_plugin_deletion.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Avoid deleting disabled plugins merely because a new plugin name was observed. |
| **Why** | Aggressive cleanup removed plugins unexpectedly. |
| **Where** | `PluginManager.cs` |
| **How** | Guard deletion path for disabled plugins. |
| **Related** | [jellyfin#15897](https://github.com/jellyfin/jellyfin/issues/15897). |

### `jellyfin_plugin_load_context_deps.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Construct `PluginLoadContext` with the plugin assembly path (where `.deps.json` lives), not the directory. |
| **Why** | Directory-based resolver returned null for transitive deps (for example StackExchange.Redis). |
| **Where** | `PluginManager.cs` |
| **How** | Prefer DLL with sibling `.deps.json` as resolver root. |
| **Related** | No public issue. |

### `jellyfin_userdata_favorite_progress.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Prevents favorites (and related userdata) from being clobbered by stale in-memory progress saves; serializes conflicting updates. |
| **Why** | Racing progress writes dropped favorite state. |
| **Where** | `UserDataManager.cs`, tests |
| **How** | Goes beyond upstream cache-first GetUserData ([#15048](https://github.com/jellyfin/jellyfin/pull/15048) on 10.11.z): serialize updates so progress snapshots cannot overwrite newer favorite flags. |
| **Related** | [jellyfin#14981](https://github.com/jellyfin/jellyfin/issues/14981). |

---

## 6. Playback stats / taste / home sections

### `jellyfin_playback_statistics.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Playback activity entities, session instrumentation, user + elevated admin stats APIs. |
| **Why** | Operators want watch-time analytics without third-party plugins that assume SQLite. |
| **Where** | `PlaybackActivity` / `PlaybackActivityDaily`, `PlaybackActivityController`, `ServerPlaybackStatsController`, `SessionManager` |
| **How** | Record activity on playback events; expose authenticated user routes and elevated aggregates. |
| **Related** | Web `jellyfin_web_user_playback_stats`. No public issue. |

### `jellyfin_web_user_playback_stats.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Full playback statistics dashboard (KPIs, heatmaps, delivery/transcode tabs, per-user views). |
| **Why** | Visualize server playback APIs. |
| **Where** | `playbackStatistics/**`, reports drawer/routes, user tab, charting deps in `package.json` |
| **How** | Dashboard feature module calling stats APIs with CamelCase Accept where required. |
| **Related** | `jellyfin_playback_statistics`. No public issue. |

### `jellyfin_user_taste_profiles.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | DB entities for `UserTasteProfile` and `TasteModelEvalRun`. |
| **Why** | Persist taste vectors and admin eval runs in the system DB (synced to PG). |
| **Where** | Entity classes + `JellyfinDbContext` |
| **How** | Schema only; logic lives in the plugin. |
| **Related** | Plugin `Taste/`; web taste patches. No public issue. |

### `jellyfin_user_taste_recommendations.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | DB entity for precomputed `UserTasteRecommendation` rows. |
| **Why** | Home “For You” should read ranked IDs without scoring on every request. |
| **Where** | `UserTasteRecommendation.cs`, `JellyfinDbContext` |
| **How** | Schema for scheduled rebuild output. |
| **Related** | `jellyfin_foryou_home_section`. No public issue. |

### `jellyfin_z_user_taste_recommendation_impressions.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | DB entity for For You serve impressions (`UserTasteRecommendationImpression`). |
| **Why** | Attribute later watches/favorites/abandons to recommendations for engagement-weighted taste training. |
| **Where** | `UserTasteRecommendationImpression.cs`, `JellyfinDbContext` |
| **How** | Schema only; plugin logs on serve and joins during profile/shadow rebuild. Late `z_` so it applies after `jellyfin_user_taste_recommendations`. |
| **Related** | `jellyfin_user_taste_recommendations`; plugin `Taste/`. No public issue. |

### `jellyfin_foryou_home_section.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Adds `ForYou` to `HomeSectionType` and display-preferences handling. |
| **Why** | Home layout needs a first-class section type for taste recommendations. |
| **Where** | `HomeSectionType.cs`, `DisplayPreferencesController.cs` |
| **How** | Enum + API recognition of the new section. |
| **Related** | Web `jellyfin_web_foryou_home`. No public issue. |

### `jellyfin_web_foryou_home.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Renders For You home row and settings option. |
| **Why** | Client home must load taste recommendations section. |
| **Where** | `sections/forYou.ts`, home section constants/settings, strings |
| **How** | Home section module fetching recommendation payload. |
| **Related** | `jellyfin_foryou_home_section`. No public issue. |

### `jellyfin_web_taste_identity.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | User taste page, match indicators on cards, recommended-view hooks. |
| **Why** | Users should see persona/match context; cards show taste affinity affordances. |
| **Where** | taste controllers, `tasteMatch.js`, card/indicator components, user settings routes |
| **How** | Legacy routes + indicators calling taste APIs. |
| **Related** | Plugin taste APIs. No public issue. |

### `jellyfin_web_z_taste_models.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Admin Reports → Taste models shadow-eval UI (late `z_` patch). |
| **Why** | Evaluate recommendation model quality without exposing metrics on user APIs. |
| **Where** | `tasteModels/**`, reports drawer/route |
| **How** | Admin-only dashboard calling `TasteAdminController`. |
| **Related** | Applies after playback-stats drawer patches. No public issue. |

### `jellyfin_z_beyond_your_library_home.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Adds `BeyondYourLibrary` home section enum value (late `z_`). |
| **Why** | Server must recognize the Seerr discover home section. |
| **Where** | `HomeSectionType.cs` |
| **How** | Enum extension only. |
| **Related** | Web `jellyfin_web_seerr_z_beyond_your_library_home`. No public issue. |

---

## 7. Seerr / Emby / admin UI

### `jellyfin_web_seerr_search.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Seerr request results embedded in search UI. |
| **Why** | Request missing titles without leaving Jellyfin search. |
| **Where** | `lib/seerr/*`, `useSeerrSearch.ts`, `SeerrRequestResults.tsx`, `SearchResults.tsx` |
| **How** | Calls Seerr plugin APIs; shows status and request actions. |
| **Related** | `Jellyfin.Plugin.Seerr`. Upstream Devices length context: [JPVenson#25](https://github.com/JPVenson/Jellyfin.Pgsql/issues/25). |

### `jellyfin_web_seerr_z_beyond_your_library_home.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Beyond Your Library home section (Seerr discover). |
| **Why** | Surface out-of-library recommendations on the home screen. |
| **Where** | `beyondYourLibrary.ts`, home sections/settings, strings |
| **How** | Late `z_` web patch stacking on Seerr search + home enums. |
| **Related** | Server `jellyfin_z_beyond_your_library_home`. No public issue. |

### `jellyfin_web_z_user_admin.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | User merge / transfer admin UI. |
| **Why** | Consolidate duplicate accounts (for example after SSO cutover). |
| **Where** | `userAdmin/**`, `users/merge.tsx`, users index |
| **How** | Dashboard pages calling plugin `UserAdminController`. |
| **Related** | No public issue. |

### `jellyfin_web_zz_emby_userdata_import.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Emby userdata import wizard (upload/session/map). |
| **Why** | Migrate watch state from Emby SQLite into Jellyfin/Postgres. |
| **Where** | `embyImport/**`, `import-emby.tsx` |
| **How** | Last web patch (`zz_`); multipart upload to plugin Emby import APIs. |
| **Related** | Plugin `Admin/EmbyImport`. No public issue. |

### `jellyfin_web_library_scan_progress.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Shows library scan/refresh progress on dashboard library cards. |
| **Why** | Operators need per-library scan visibility. |
| **Where** | `LibraryCard.tsx`, `BaseCard.tsx`, `RefreshIndicator.tsx` |
| **How** | Overlay refresh indicator on library cards. |
| **Related** | No public issue. |

### `jellyfin_web_infinite_scroll.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Optional infinite scroll for classic library controllers (movies/shows/music). |
| **Why** | Large libraries paginate poorly on TVs and long lists. |
| **Where** | movies/music/shows controllers, display settings, `userSettings.js` |
| **How** | User setting + scroll helpers loading next pages. |
| **Related** | TV UX stack builds on this. No public issue. |

### `jellyfin_web_user_search_infinite_scroll.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Infinite scroll for modern search results. |
| **Why** | Search hit lists grow large with fuzzy/Seerr combined results. |
| **Where** | `useSearchItems.ts`, `SearchResults.tsx` |
| **How** | React infinite query wiring. |
| **Related** | `jellyfin_web_seerr_search`, TV UX patches. No public issue. |

---

## 8. TV / web UX

### `jellyfin_web_z_tv_ux.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Broad TV UX: focus/nav, remembered users, infinite-scroll helper integration across library views. |
| **Why** | Living-room clients need spatial navigation and fewer full page reloads. |
| **Where** | library controllers, `infiniteScrollHelper.js`, `libraryMenu.js`, login, `rememberedUsers.js` |
| **How** | Late `z_` stacking on infinite scroll + search patches. |
| **Related** | No public issue. |

### `jellyfin_web_z_tv_ux_perf.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | Caps home-row work and lazy-load pressure on TV. |
| **Why** | Low-power TVs choke on many home sections and eager image decode. |
| **Where** | `homesections.js`, `imageLoader.js`, lazy loader, `infiniteScrollHelper.js` |
| **How** | Limit concurrent loads / home section aggressiveness on TV. |
| **Related** | Applies after `jellyfin_web_z_tv_ux`. No public issue. |

### `jellyfin_web_z_tv_ux_webos5.patch`

| | |
|---|---|
| **Target** | `jellyfin-web` |
| **What** | webOS 5 / Chromium 68 workarounds (eager chunks, Seerr/home behaviour, `isTvClient` helper). |
| **Why** | Older webOS browsers fail on modern lazy route/chunk patterns. |
| **Where** | `isTvClient.ts`, Seerr search, beyondYourLibrary, routes, userSettings |
| **How** | Detect webOS5-class clients and adjust loading strategy. |
| **Related** | No public issue. |

---

## Companion pairs (quick reference)

| Server | Web |
|---|---|
| `jellyfin_sso` | `jellyfin_web_rbac`, `jellyfin_web_tv_quickconnect_login`, `jellyfin_web_quickconnect_modal` |
| `jellyfin_z_livetv_rbac_allowlist` | `jellyfin_web_rbac` (Live TV allowlist UI) |
| `jellyfin_security_hardening` | `jellyfin_web_security_hardening` |
| `jellyfin_z_hls_live_playlist_apikey` | (server-only; required by security hardening for Live/EVENT HLS) |
| `jellyfin_transcoding_pipeline` | `jellyfin_web_transcoding_pipeline` |
| `jellyfin_hwa_capabilities` | `jellyfin_web_hwa_capabilities` |
| `jellyfin_livetv_stream_buffer` | `jellyfin_web_live_stream_keep_seconds` |
| `jellyfin_livetv_stream_probe` | `jellyfin_web_live_stream_probe` |
| `jellyfin_playback_statistics` | `jellyfin_web_user_playback_stats` |
| `jellyfin_foryou_home_section` | `jellyfin_web_foryou_home` |
| `jellyfin_user_taste_*` | `jellyfin_web_taste_identity`, `jellyfin_web_z_taste_models` |
| `jellyfin_z_beyond_your_library_home` | `jellyfin_web_seerr_z_beyond_your_library_home` |

## File count

**59** patches: **35** `jellyfin_*.patch` (server), **24** `jellyfin_web*.patch` (web).
