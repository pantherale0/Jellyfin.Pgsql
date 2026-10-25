# Patch catalog

Every file under [`patches/`](../patches/) applied by [`scripts/apply-patches.sh`](../scripts/apply-patches.sh). Naming and apply order: [architecture](architecture.md#patch-routing-and-apply-order).

For each patch: **What** (behaviour), **Why** (motivation), **Where** (key paths), **How** (mechanism), **Related** (issues/PRs/companions). Issue links are only cited when verified; otherwise “no public issue”.

---

## 1. Auth / SSO / security

### `jellyfin_zzzzzz_media_resource_security.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Requires authentication for subtitle streams and video attachments, checks subtitle item visibility, and serves attachments as downloads with `nosniff`. Generated attachment delivery URLs include the caller's escaped `ApiKey` for font loaders that cannot set headers. |
| **Why** | A Plex2Shell-focused review found anonymous subtitle and attachment access, a subtitle library-permission bypass, and media-controlled attachment MIME types that could serve active HTML or SVG under Jellyfin's origin. No complete unauthenticated server-code-execution chain was demonstrated. |
| **Where** | `Jellyfin.Api/Controllers/SubtitleController.cs`, `VideoAttachmentsController.cs`, `Helpers/MediaInfoHelper.cs`, API controller and helper tests. |
| **How** | Controller-level `[Authorize]` protects both subtitle route variants and attachments. Subtitle lookup resolves the effective route/query item ID through `GetItemById<Video>(id, User.GetUserId())` before reading or extracting data. Invisible items return 404. Attachments retain their MIME type for font consumers but send `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. HTTP tests cover absent/junk credentials, permitted captions, hidden items, and media-supplied HTML. A helper test verifies URL token escaping. |
| **Related** | Apply after `jellyfin_zzzzz_device_playback_options.patch` and the existing Live TV patches, which modify `MediaInfoHelper` and its tests. See the [review scope and findings](known-issues.md#plex2shell-focused-security-review). No public issue. |

### `jellyfin_sso.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Adds OIDC/OAuth2 SSO endpoints and login integration, including group RBAC apply (libraries, permissions, block-unrated, Allowed/Blocked tags, Live TV allowlists) and `GET /sso/rbac/livetv` for the UI Next picker. |
| **Why** | Stock Jellyfin has no built-in IdP login; this fork needs forced SSO + RBAC for shared deployments. |
| **Where** | `Jellyfin.Api/Controllers/SSOController.cs`, `Jellyfin.Api/Models/SsoDtos/*` |
| **How** | New controller handles authorize/callback/session flows driven by `JELLYFIN_SSO_OIDC_*` env configuration; matching `sso_rbac.json` groups merge preferences additively on login (blocking Live TV unrated also blocks `LiveTvProgram`). Each OIDC `state` is random, bound to the initiating browser by an HttpOnly SameSite=Lax `jellyfin_sso_state` cookie (constant-time compared on callback), rejected after 10 minutes even if not yet pruned, and capped at 1,000 pending sign-ins (pruning runs at most every 30 seconds; a full store returns 503). The same-origin callback returns to `<BaseUrl>/web/index.html`, which serves UI Next in this image. For UI addresses allowlisted in `JELLYFIN_SSO_UI_RETURN_URLS`, `GET /sso/login?returnUrl=&challenge=` stores the return address and a base64url SHA-256 challenge with the state; the callback then redirects to `returnUrl#sso_code=<code>` (32 random bytes, single use, 60 seconds, at most 1,000 pending) and `POST /sso/exchange {code, verifier}` (anonymous, `no-store`) returns `accessToken`, `userId` and `serverId` only when the verifier hashes to the challenge; every failure gives the same 400. `GET /sso/config?returnUrl=` reports `codeExchange` for allowlisted addresses. |
| **Related** | UI Next provides SSO mappings and Quick Connect. Enforcement/persistence: `jellyfin_z_livetv_rbac_allowlist`. See the README SSO section and [pantherale0#5](https://github.com/pantherale0/Jellyfin.Pgsql/issues/5). |

### `jellyfin_startup_secret_redaction.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Redacts secret-bearing `JELLYFIN_*`, `DOTNET_*`, and `ASPNETCORE_*` environment values from startup logs. |
| **Why** | Stock startup diagnostics log matching environment variables verbatim; custom variables such as `JELLYFIN_SSO_OIDC_CLIENT_SECRET` therefore leaked credentials into ordinary server logs. |
| **Where** | `StartupHelpers.cs`, `StartupHelpersTests.cs` |
| **How** | Names containing password, secret, token, API/private-key, or connection-string markers retain their name but log `[REDACTED]`; tests cover sensitive and safe names. |
| **Related** | Rotate any credential that appeared in logs before this patch. No public issue. |

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

### `jellyfin_zz_last_admin_invariant.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Makes "at least one enabled administrator" atomic for user deletes and policy demotions, and answers violations with 403. |
| **Why** | Upstream counts administrators under a per-user lock (and the policy route uses the in-memory list), so two concurrent deletes or demotions can remove every administrator. Upstream also revokes tokens and removes the user's playlists *before* the guarded delete, so a refused delete still destroys data. |
| **Where** | `UserManager.cs`, `IUserManager.cs`, new `LastAdministratorException.cs`, `UserController.cs`, `UserManagerLastAdministratorTests.cs` |
| **How** | A process-wide `SemaphoreSlim` (taken after the per-user lock) wraps `DeleteUserAsync` and any `UpdatePolicyAsync` that removes admin or disables. Inside it the database recounts *other enabled* administrators and throws `LastAdministratorException` when none remain. New `DeleteUserAsync(userId, beforeDelete)` runs token revocation and playlist removal only after the checks pass (the user must still exist for playlist ownership transfer). `DELETE /Users/{id}` and `POST /Users/{id}/Policy` map the exception to 403. |
| **Related** | Apply order: after `jellyfin_livetv_multiview_rbac.patch` and `jellyfin_library_image_parental.patch` (both edit `UserManager.UpdatePolicyAsync`). UI Next maps the 403 to "There must be at least one administrator." No public issue. |

---

## 2. Postgres / query performance

### `jellyfin_pgsql_migrate_activity_log.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Makes legacy activity-log import avoid SQLite sequence SQL when Jellyfin's active database is PostgreSQL. |
| **Why** | New PostgreSQL installations importing an old `activitylog.db` otherwise execute `UPDATE sqlite_sequence` through Npgsql and fail startup. |
| **Where** | `Jellyfin.Server/Migrations/Routines/20250420070000_MigrateActivityLogDb.cs` |
| **How** | Keeps the sequence reset for SQLite and skips it for Npgsql, where imported entities receive database-generated IDs. |
| **Related** | PostgreSQL provider compatibility fix. No public issue. |

### `jellyfin_pgsql_migrate_rating_levels.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Makes the parental-rating migration compatible with PostgreSQL by materializing distinct rating strings before issuing updates. |
| **Why** | Npgsql permits only one active command per connection; streaming the ratings query while executing updates caused startup to fail with `NpgsqlOperationInProgressException`. |
| **Where** | `Jellyfin.Server/Migrations/Routines/20260910120000_MigrateRatingLevels.cs` |
| **How** | Adds `ToArray()` before the update loop so the query reader is closed before any `ExecuteUpdate` call. |
| **Related** | PostgreSQL provider compatibility fix. No public issue. |

### `jellyfin_pgsql_strip_embedded_linked_children.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Makes the dead serialized-item-key cleanup migration work with both PostgreSQL and SQLite. |
| **Why** | The upstream migration unconditionally used SQLite's `json_remove` and `json_valid`, causing PostgreSQL startup to fail with SQLSTATE `42883`. |
| **Where** | `Jellyfin.Server/Migrations/Routines/20260911120000_StripEmbeddedLinkedChildren.cs` |
| **How** | Selects SQL by EF provider; PostgreSQL validates and converts the text payload to `jsonb`, removes the three top-level keys, and stores it as text, while SQLite retains its existing JSON functions. |
| **Related** | PostgreSQL provider compatibility fix. No public issue. |

### `jellyfin_unoptimized_query_fixes.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Fixes expensive library/item/TV query shapes and adds supporting indexes. |
| **Why** | Large libraries on Postgres amplify N+1 and unindexed filters that were tolerable on SQLite. |
| **Where** | `LibraryManager`, `ItemsController`, `TVSeriesManager`, `BaseItemRepository.QueryBuilding`, `LinkedChildrenService`, query-index migration |
| **How** | Query rewrites (including user-data sort join helpers) + `AddQueryPerformanceIndexes` migration (mirrored to PG via sync). Played/resumable TranslateQuery shapes from earlier forks were superseded by upstream rc4 query rewrites. |
| **Related** | Motivated by scale reports such as upstream [JPVenson#34](https://github.com/JPVenson/Jellyfin.Pgsql/issues/34) / [#35](https://github.com/JPVenson/Jellyfin.Pgsql/issues/35) (context, not a direct fix ticket). Companion: `jellyfin_zzz_byname_access_semijoin`. |

### `jellyfin_zzz_byname_access_semijoin.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Rewrites rc5 people/genre/studio/artist access filtering from nested correlated `EXISTS` to a semi-join over reachable item ids. |
| **Why** | On PostgreSQL the rc5 “names backed by an item the user can access” predicate re-evaluated the full accessible-item set per by-name row and congested search / people / genre listings. |
| **Where** | `BaseItemRepository.QueryBuilding.cs` (`ApplyItemByNameAccessFiltering`) |
| **How** | Project accessible item ids once, then `PeopleBaseItemMap` / `ItemValuesMap` `Contains` (hash semi-join) instead of `Any(Any(Any()))`. |
| **Related** | Applies after other QueryBuilding patches. Companion: `jellyfin_zzzz_people_query_perf`. No public issue. |

### `jellyfin_zzz_playback_errors.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Structured playback error codes: extends `PlaybackErrorCode`, `PlaybackFailedException`, JSON + `X-Playback-Error-Code` header from `ExceptionMiddleware`, `PlaybackInfoResponse.Message`, and transcode/live-stream failure mapping (`TranscodeFailed`, `TranscodeNotAllowed`, `LiveStreamFenced`, etc.). |
| **Why** | Stock failures return plain text 500s or generic client-side `SERVER_ERROR`; operators and users cannot tell transcode denial from HA failover from decode issues. |
| **Where** | `PlaybackErrorCode`, `PlaybackFailedException`, `PlaybackErrorResponse`, `ExceptionMiddleware`, `MediaInfoHelper`, `TranscodeManager`, `TranscodeCodecRaceCoordinator`, `LiveStreamFencedException` |
| **How** | Playback-path exceptions throw `PlaybackFailedException`; middleware returns `{ errorCode }` JSON and sets `X-Playback-Error-Code` for HLS clients. `NotAllowed` when `EnableMediaPlayback` is false at PlaybackInfo time. Applies after `jellyfin_z_ha_leadership` and `jellyfin_z_transcode_codec_fallback` (`zzz_` band). UI Next maps these codes to recovery actions. |
| **Related** | Consolidates HA `LiveStreamFenced` handling into unified middleware. No public issue. |

### `jellyfin_zzzz_people_query_perf.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Batches `HasSegments` for all versions in `GetMediaSources`, and drops `Name.ToUpper().Contains` on `/Persons` name search. |
| **Why** | Item details called `HasSegments` once per media source (new DbContext each time). People name search wrapped `Name` in `upper()`, so `IX_Peoples_Name_trgm` could not be used. Name collapse to one row per identity is already in `jellyfin_zz_person_provider_identity`. |
| **Where** | `IMediaSegmentManager`, `MediaSegmentManager`, `BaseItem.GetMediaSources` / `GetVersionInfo`, `PeopleRepository.TranslateQuery` |
| **How** | One `ItemId IN (...)` lookup, then a set membership check per version. `NameContains` uses `Name.Contains` without `ToUpper()`. Applies in the `zzzz_` band after `zzz_byname`. |
| **Related** | `jellyfin_zz_person_provider_identity`, `jellyfin_background_media_qos` (`IX_MediaSegments_ItemId`). No public issue. |

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

### `jellyfin_z_items_browse_perf.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Speeds recursive library `/Items` browse (e.g. Movie + SortName pages): skip redundant `PresentationUniqueKey` GroupBy when alternates are already excluded, stop forcing `AsSingleQuery` on list hydrations, and skip `LinkedChildEntities` Include for movie/episode-only lists. |
| **Why** | Deep SortName pages were spending ~10s+ on Count+GroupBy over the whole library and cartesian Includes, even with `limit=100`. |
| **Where** | `BaseItemRepository.QueryBuilding.cs`, grouping tests |
| **How** | When `!IncludeOwnedItems`, TranslateQuery’s `PrimaryVersionId IS NULL` already drops alternates — GroupBy is skipped. Keep `AsNoTrackingWithIdentityResolution` (dedupe) but allow `AsSplitQuery` from `jellyfin_query_split_userdata`. MediaSourceCount still uses the batched LinkedChildren probe. |
| **Related** | `jellyfin_dedupe_baseitem_image_infos`, `jellyfin_query_split_userdata`; plugin browse ID-page cache (`Pgsql_CACHE_BROWSE_TTL`). No public issue. |

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
| **Related** | Header comment in patch. HA flush/overlay: `jellyfin_z_ha_leadership`. No public issue. |

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

### `jellyfin_zzzzz_device_playback_options.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Administrator-managed, sparse playback and transcoding options for an exact registered device; dedicated SQLite migration. |
| **Why** | Fix a specific player's codec, HDR/SDR, or decoder quirks without changing other devices or enabling server-wide capabilities. |
| **Where** | `DevicePlaybackOptionsDto`, `DeviceManager`, `DevicesController`, `DevicePlaybackOptionsHelper`, `StreamingHelpers`, `MediaInfoHelper`, `DynamicHlsController`, `TranscodeManager`, SQLite migrations |
| **How** | Admin `PUT /Devices/Options/Playback?id=…` stores a versioned JSON document; `GET /Devices/Options` includes sparse options. Requests find the registered device from the authenticated access token (not a URL/header device id), clone global encoding options and narrow user/server limits. The effective settings are pinned to an HLS/progressive transcode job and reused across later requests and codec fallback. Admin device deletion removes its options. Requires the matching PostgreSQL migration when using the plugin. |
| **Related** | Applied after [`jellyfin_z_transcode_codec_fallback`](#jellyfin_z_transcode_codec_fallbackpatch) and [`jellyfin_transcoding_pipeline`](#jellyfin_transcoding_pipelinepatch). No public issue. |

### `jellyfin_transcoding_pipeline.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Lazy transcoding pipeline probe; exposes Speed/buffer/pipeline on `TranscodingInfo`; strips HW detail for non-admins; syncs `Request.LiveStreamId` after `AcquireResources` opens a live stream. |
| **Why** | Admins need visibility into ffmpeg graph stages without probing every session for every client. When HLS omits `LiveStreamId`, open still happens in `AcquireResources`; without copying the id onto `Request`, `StreamState.Dispose` closes the stream immediately (`ConsumerCount` → 0) and retries hit null `OpenToken`. |
| **Where** | `TranscodeManager`, `TranscodingPipelineProbe`/`Classifier`/`GraphParser`, session WebSocket, models |
| **How** | `EnsureProbed` on admin GetSessions; `RegisterPending` at ffmpeg start; after live open in `AcquireResources`, set `state.Request.LiveStreamId` from the opened media source. |
| **Related** | No public issue. |

### `jellyfin_z_transcode_codec_fallback.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Parallel AV1/H.264 init transcode race, sequential codec fallback chain, HTTP 302 redirect to winning codec playlist, Activity Log notifications, session binding for subsequent segments. |
| **Why** | GPUs may list `av1_nvenc` in ffmpeg `-encoders` but fail at runtime (exit 218 / `-38 Function not implemented` on pre-Ada NVIDIA). Without fallback, HLS init fails hard when `AllowAv1Encoding` is enabled. |
| **Where** | `TranscodeCodecRaceCoordinator`, `TranscodeCodecFallbackChain`, `TranscodeSessionBinding`, `TranscodeFallbackNotifier`, `DynamicHlsController.GetDynamicSegment`, `TranscodeManager.StartFfMpegAttempt`, `EncodingOptions`, `TranscodingInfo` |
| **How** | On fmp4 init (`segmentId == -1`), optionally race AV1 + H.264; first init segment wins; losers killed and artifacts cleaned. If no winner, walk chain `av1 hw → h264 hw → hevc hw → h264 sw → hevc sw → av1 sw`. Redirect client when winning codec differs from URL. Deduped Activity Log entries. |
| **Related** | Requires [`jellyfin_transcoding_pipeline`](#jellyfin_transcoding_pipelinepatch) for pipeline fields on `TranscodingInfo`. [`jellyfin_zzzzzzz_hls_remux_segment_restart`](#jellyfin_zzzzzzz_hls_remux_segment_restartpatch) applies afterward and owns HLS timing and lifecycle fixes; this patch's context is refreshed for that order. No public issue. |

### `jellyfin_hwa_capabilities.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | API to report media encoder / hardware acceleration capabilities. |
| **Why** | Transcoding settings UI needs accurate HW codec lists from the running ffmpeg build. |
| **Where** | `MediaEncoderController.cs`, `HardwareCapabilityResolver`, capability models |
| **How** | Resolves decoder/encoder names from ffmpeg and returns structured capabilities. |
| **Related** | The UI Next Transcoding page reads this API. No public issue. |

### `jellyfin_zzzzzzz_hls_remux_segment_restart.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | HLS generation tracking, correct remux playlist timing, generation-safe transcode cleanup, and bounded segment waits. |
| **Why** | Stream-copy segments follow source keyframes rather than a fixed `hls_time`. Delayed cleanup and queued segment-cleaner callbacks could delete replacement output. Cancelled requests could leave active-request counts elevated and block seeks. |
| **Where** | `DynamicHlsController.cs`, `EncodingHelper.cs`, `TranscodingJob.cs`, `TranscodingSegmentCleaner.cs`, `TranscodeManager.cs`, `DynamicHlsPlaylistGenerator.cs`, HLS/API/media-encoding tests |
| **How** | Preserves upstream keyframe-aware playlists and read-rate pacing only when segment deletion is enabled. Records each job's `-start_number` and excludes fMP4 initialization files from media-index detection. Missing past segments trigger regeneration. Readiness waits stop after 30 seconds or request cancellation and return `StreamUnavailable` for unavailable output. Completion and disconnect release each request once; only successful downloads advance progress. Segment deletion uses recorded segment-ending timestamps. Per-output artifact locks coordinate startup, stop, and cleanup; delayed cleanup checks for replacement jobs, duplicate stops do nothing, and stopped cleaners cannot delete files. |
| **Related** | The original HLS patch is consolidated here in the final `zzzzzzz` band, after [`jellyfin_z_transcode_codec_fallback`](#jellyfin_z_transcode_codec_fallbackpatch), [`jellyfin_zzz_playback_errors`](#jellyfin_zzz_playback_errorspatch), [`jellyfin_zzzzz_device_playback_options`](#jellyfin_zzzzz_device_playback_optionspatch), and [`jellyfin_zzzzzz_media_resource_security`](#jellyfin_zzzzzz_media_resource_securitypatch). [jellyfin#13668](https://github.com/jellyfin/jellyfin/issues/13668); fork [pantherale0#17](https://github.com/pantherale0/Jellyfin.Pgsql/issues/17). No public issue for the cleanup races. |

### `jellyfin_hdr10plus_mpegts_sei.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Strips HDR10+ SEI when remuxing to MPEG-TS (beyond Dolby Vision player special-cases). |
| **Why** | Plain/hybrid HDR10+ in MPEG-TS remuxes causes client playback issues. |
| **Where** | `EncodingHelper.cs`, tests |
| **How** | Extend HDR10+ strip conditions for MPEG-TS remux. |
| **Related** | [jellyfin#16823](https://github.com/jellyfin/jellyfin/issues/16823). |

### `jellyfin_hls_mpegts_audio_compat.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | HLS MPEG-TS audio compatibility: disallow MP3-in-TS; infer AAC for TS; treat `libfdk_aac`/`aac_at` as AAC; prefer remuxing source AC3/EAC3 when DirectPlay supports it; demote AAC behind Dolby for multichannel encode selection. |
| **Why** | MP3 in MPEG-TS is often silent on ExoPlayer ([jellyfin-web#5419](https://github.com/jellyfin/jellyfin-web/issues/5419), [Wholphin#879](https://github.com/damontecres/Wholphin/issues/879)). Clients may list only AAC on the TranscodingProfile while still advertising EAC3 on DirectPlay; video tonemap then re-encodes surround to AAC 5.1, which is silent on many Android TVs ([Wholphin#255](https://github.com/damontecres/Wholphin/issues/255)). |
| **Where** | `StreamBuilder.cs` (`_supportedHlsAudioCodecsTs`, `PreferHlsTsRemuxableSourceAudio`), `EncodingHelper.cs` (`InferAudioCodec`, `ShiftAudioCodecsIfNeeded`, `GetAudioStreamCopyFailureReasons`), `MediaEncoder.cs` (`CanEncodeToAudioCodec`) |
| **How** | After HLS-TS codec filter, if source is multichannel AC3/EAC3 and a DirectPlay profile supports that codec, put it first so StreamBuilder remuxes instead of marking AudioCodecNotSupported. At encode time, shift AAC behind AC3/EAC3 for ≥6ch when Dolby is listed. Do not apply encode bitrate caps when refusing remux of a listed source codec. AAC-only clients (no DirectPlay Dolby) unchanged. |
| **Related** | [jellyfin-web#5419](https://github.com/jellyfin/jellyfin-web/issues/5419), [Wholphin#879](https://github.com/damontecres/Wholphin/issues/879), [Wholphin#255](https://github.com/damontecres/Wholphin/issues/255). |

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

### `jellyfin_livetv_multiview_rbac.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Adds `EnableLiveTvMultiview` permission to `PermissionKind` enum, `UserPolicy` DTO, `UserManager` policy mapping, and default user entity creation. |
| **Why** | Server-side permission backend for Live TV Multiview access and SSO group RBAC policy enforcement. UI Next does not currently expose a Multiview player. |
| **Where** | `PermissionKind.cs`, `UserPolicy.cs`, `UserManager.cs`, `UserEntityExtensions.cs` |
| **How** | Enum value 24 mapped to/from UserPolicy boolean; automatically picked up by SSO `sso_rbac.json` permission parser. |
| **Related** | `jellyfin_sso.patch`. UI Next does not currently expose a Multiview player. |

### `jellyfin_livetv_published_url.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Fork residuals on top of upstream Live TV published-URL rewrite: clear unreachable tuner-origin Paths, ignore unmatched Live TV `MediaSourceId` placeholders, and AutoOpenLiveStream fallback to `MediaSources[0]`. |
| **Why** | Clients outside the container network cannot play tuner buffers advertised with bridge addresses; some clients (e.g. Wholphin) ignore `SupportsDirectPlay=false` and still open `Path`, causing `UnknownHostException` on cluster-internal M3U hosts. Wholphin also sends `MediaSourceId` = channel item Guid (from `LiveTvChannel` placeholder sources) instead of the tuner source id (e.g. M3U path MD5), which filters PlaybackInfo to zero sources before open — and even after ignore-fallback, AutoOpen used to skip when that id matched nothing, so PlaybackInfo returned no `LiveStreamId` and `live.m3u8` failed with null `OpenToken`. |
| **Where** | `MediaInfoHelper`, `MediaInfoController`, tests |
| **How** | Core rewrite landed upstream in [jellyfin#17298](https://github.com/jellyfin/jellyfin/pull/17298) (rc4). This patch keeps `SanitizeLiveStreamClientPath` / `ClearedUnreachableOrigin`, Live TV unmatched-`MediaSourceId` ignore, and AutoOpen fallback. |
| **Related** | [jellyfin#15411](https://github.com/jellyfin/jellyfin/issues/15411); `jellyfin_livetv_stream` (SharedHttpStream / live.m3u8 open-before-CLI); `jellyfin_transcoding_pipeline` (`Request.LiveStreamId` sync). |

### `jellyfin_z_livetv_rbac_allowlist.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Persists M3U `group-title` as `LiveTvChannel.ChannelGroup` (plus `ChannelGroup:` tags), adds Live TV allowlist preference kinds, and enforces channel/category exceptions to block-unrated and AllowedTags for Live TV. |
| **Why** | Blocking unrated Live TV hides nearly all channels; operators need group-scoped allowlists for safe kids/shared profiles. |
| **Where** | `BaseItem` (`IsParentalAllowed` made virtual), `LiveTvChannel`, `LiveTvProgram`, `LiveTvParentalAccess`, `GuideManager`, `PreferenceKind`, `BaseItemRepository` access filters |
| **How** | Whitelist by channel id and/or category (M3U group or EPG Kids/Sports/News); SQL expands categories to channel ids; in-memory parental checks bypass unrated + AllowedTags for matches (BlockedTags still apply). Applies after `jellyfin_sso` (`z_` layering). |
| **Related** | `jellyfin_sso`; UI Next exposes the allowlist settings. No public issue. |

### `jellyfin_z_ha_leadership.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Active-standby HA contracts and wiring: `IInstanceLeadership`, leader-only library monitor / scheduled tasks / recordings / background media work, `/health/ready`, leadership response headers, Live TV `LiveStreamFenced` 503, migration advisory-lock hook, `JELLYFIN_SERVER_ID`, coalesced progress flush, optional progress cache overlay. |
| **Why** | Jellyfin is a single-writer process; two Ready replicas split-brain the library. A Postgres lock plus Ready-only-leader lets a warm standby take traffic after failover. |
| **Where** | `IInstanceLeadership`, `LibraryMonitor`, `TaskManager` / `ScheduledTaskWorker`, `RecordingsHost`, `BackgroundMediaWorkGate`, `Startup`, `ExceptionMiddleware`, `StreamingHelpers`, `SessionManager`, `DeviceId`, `IJellyfinDatabaseProvider` |
| **How** | Default always-leader (HA off). Plugin supplies Postgres advisory lock when `Pgsql_HA_ENABLED=true`. Fail-closed until the lock is held. `LeaderEpochMiddleware` sets `X-Jellyfin-Ha-Role` (`single` / `leader` / `standby`) and `X-Jellyfin-Leader-Epoch` on every response and, when the request carries an `Origin`, appends both to `Access-Control-Expose-Headers` (keeping any existing value) so separately hosted web clients can read them. Applies after unprefixed playback/Live TV patches (`z_` layer). |
| **Related** | Plugin `Jellyfin.Plugin.Pgsql/Ha/`; admin-only HA block in `/Pgsql/Stats` (role, epoch, instance, leader-since, heartbeat). UI Next admin diagnostics consume both ([features](features.md#active-standby-high-availability)). Progress overlay extends `jellyfin_playback_progress_coalesce`. `LiveStreamFenced` middleware unified by [`jellyfin_zzz_playback_errors`](patches.md#jellyfin_zzz_playback_errorspatch). No public issue. |

### `jellyfin_livetv_stream.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Live TV stream hardening: rolling chunk buffers (`LiveStreamKeepSeconds`), configurable probe delay/analyzeduration/probesize, non-blocking live-stream open/close (global lock no longer held across network I/O), per-channel keyed open lock + `ConsumerCount` ownership in `MediaSourceManager`, reverse-close when stop omits `LiveStreamId`, 2-minute orphaned open-stream sweeper, `LiveStreamOpenTimeoutMs` for M3U `SharedHttpStream` connect/first-byte, dispose of streams that fail to open, structured diagnostic logging for open/share/FirstPull, SharedHttpStream for extensionless HTTP origins, and `live.m3u8` open-before-ffmpeg-CLI so `-i` uses the post-open buffer Path. |
| **Why** | Unbounded buffers exhausted disk; default probe delayed starts; one stalled M3U open held the process-global live-stream lock and froze all Live TV until restart ([jellyfin#17319](https://github.com/jellyfin/jellyfin/issues/17319)); unlocking without a per-channel lock allowed same-channel double-opens and racy `ConsumerCount`; stop without `LiveStreamId` / pause zombies leaked tuner connections ([jellyfin#16880](https://github.com/jellyfin/jellyfin/issues/16880), [jellyfin#17177](https://github.com/jellyfin/jellyfin/issues/17177)); client hangs (e.g. Wholphin) need clear share vs fresh vs no-pull signals; Dispatcharr-style `/proxy/ts/{id}` URLs have no file extension so stock M3U host skipped SharedHttpStream and left cluster-internal Path in PlaybackInfo; `GetLiveHlsStream` built ffmpeg args before `AcquireResources`, baking the tuner origin into `-i` and then closing the just-opened stream (`ArgumentNullException` on null `OpenToken` retries). |
| **Where** | `RollingChunkStream.cs`, `LiveStream.cs`, `SharedHttpStream.cs`, `M3UTunerHost.cs`, `BaseTunerHost.cs`, HDHR host, `LiveStreamHelper`, `MediaSourceManager`, `SessionManager`, `DefaultLiveTvService`, `LiveTvController` / `VideosController` / `DynamicHlsController` FirstPull + live HLS open, `ILiveStream`/`IMediaSourceManager`, `EncodingHelper`/`MediaEncoder` probesize, `EncodingOptions`, `MediaSourceInfo`, tests |
| **How** | Combines [jellyfin#17128](https://github.com/jellyfin/jellyfin/pull/17128), [jellyfin#9813](https://github.com/jellyfin/jellyfin/issues/9813), and #17319: snapshot/register under `_liveStreamLocker` only; `Open`/`Close` network work outside the global lock; `AsyncKeyedLocker` on `OpenToken` for share-or-create; MediaSourceManager owns `ConsumerCount++` (service share path does not); `CloseLiveStreamsForSessionAsync` on empty-`LiveStreamId` stop / disconnect; inactive/idle timers sweep orphans older than 2 minutes via `GetOpenLiveStreams`; linked open CT + `CancelAfter(LiveStreamOpenTimeoutMs)` (default 15000, `0` disables deadline); `Close()` on failed tuner open. Diagnostics: INF `Live stream open decision` (`Shared`/`Reason`/`AgeMs`/`PathHost`/…), SharedHttpStream connect/first-byte/timeout timings, reverse-close/orphan fields, and `Live TV FirstPull` on LiveStreamFiles / video stream / HLS master when a live stream is served. Extensionless HTTP M3U paths use SharedHttpStream so Path becomes `/LiveTv/LiveStreamFiles/` for published-URL rewrite. `GetLiveHlsStream` opens (when needed) before `GetCommandLineArguments` / `StartFfMpeg`. |
| **Related** | `jellyfin_livetv_published_url` (path sanitize / AutoOpen fallback); `jellyfin_transcoding_pipeline` (`Request.LiveStreamId` sync). |

### `jellyfin_livetv_getitem_alias.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | `GET Items/{itemId}` accepts alias `livetv` for the Live TV view (string route). |
| **Why** | Clients/bookmarks use a stable Live TV alias instead of a raw GUID. |
| **Where** | `UserLibraryController.cs` |
| **How** | Route `itemId` as string; resolve `livetv` via `ILiveTvManager`. Rebased for rc4 sync `GetItem` + `IProviderManager` injection. |
| **Related** | No public issue. |

## 5. Library / metadata / plugin loading

### `jellyfin_background_media_qos.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Caps background scan/segment/chapter work and yields while clients are playing so the API stays responsive. |
| **Why** | Library scan, media-segment extraction, and chapter-image ffmpeg work saturated CPU/IO/DB and made the server sluggish. |
| **Where** | `BackgroundMediaWorkGate`, `LimitedConcurrencyLibraryScheduler`, `MediaSegmentExtractionTask`, `MediaSegmentManager`, `ChapterManager`, `ChapterImagesTask`, `MediaEncoder`, `ImageProcessor`, `ApplicationHost` |
| **How** | Shared gate delays under `NowPlayingItem` and limits concurrency (from `ParallelImageEncodingLimit` or `ProcessorCount/4`); unset scan fanout uses `ProcessorCount/2`; segment task skips providers that already have rows and bulk-inserts; chapter task pages and skips videos that already have images; chapter extract (task + in-scan) goes through the gate; unset image-encoding pools default to `ProcessorCount/4`. Companion PG index: `IX_MediaSegments_ItemId` (`AddMediaSegmentsItemIdIndex`). `Update_12_0-rc5` dropped that index as false drift; `RestoreMediaSegmentsItemIdIndex` puts it back and plugin `OnModelCreating` now owns it so later syncs keep it. |
| **Related** | No public issue. Does not fix scan OOM ([JPVenson#36](https://github.com/JPVenson/Jellyfin.Pgsql/issues/36)). |

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
| **How** | Mapper/persistence dedupe; migration cleans existing duplicates then adds unique index. Image saves lock the parent item through delete-and-reinsert, so a concurrent item deletion cannot race into a foreign-key failure. |
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

### `jellyfin_subtitle_ro_skip.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Skips automated subtitle downloads when “Save subtitles into media folders” would write to a read-only media path. |
| **Why** | RO library mounts (common in k8s) cause OpenSubtitles downloads to succeed then fail on save, burning daily quota and flooding logs. |
| **Where** | `SubtitleDownloader.cs`, `SubtitleMediaFolderWritability.cs` |
| **How** | Before provider search, when `isAutomated` and `SaveSubtitlesWithMedia`, probe-create a temp file in `ContainingFolderPath` (cached per directory for the process). If not writable, return without downloading and log one warning per folder. Manual downloads and libraries that save under internal metadata are unchanged. |
| **Related** | No public issue. See [features](features.md#background-media-work-and-plugin-reliability) and [known issues](known-issues.md). |

### `jellyfin_omdb_json_exception.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Catch `JsonException` and `HttpRequestException` when reading or deserializing OMDb API data. |
| **Why** | OMDb API responses can contain malformed JSON (e.g. unescaped quotes), causing unhandled `JsonException` during metadata scanning. |
| **Where** | `MediaBrowser.Providers/Plugins/Omdb/OmdbProvider.cs` |
| **How** | Wrap `GetRootObject` and `GetSeasonRootObject` deserialization in try/catch, delete corrupt cache files on disk if present, and return `null` gracefully. |
| **Related** | No public issue. |

### `jellyfin_zz_person_provider_identity.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Person identity keyed by provider IDs (`ProviderKey`) rather than name-only merging. |
| **Why** | Name collisions duplicate or merge distinct people incorrectly. |
| **Where** | `PersonIdentity`, `PeopleRepository`, `PeopleHelper`, NFO saver, people validation task, people migration, DTO mapping |
| **How** | Persist provider key; validation/merge uses identity helper; `/Persons` collapse is a `GroupBy`/`Min(Id)` semi-join. `zz_` applies before `zzz_` / `zzzz_` follow-ups. |
| **Related** | Companion listing/search tweaks: `jellyfin_zzzz_people_query_perf`. No public issue. |

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
| **Related** | UI Next Playback statistics page. No public issue. |

### `jellyfin_trailer_history.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Keeps local trailer playback out of UserData history and playback-statistics rows while retaining active-session lifecycle behavior. |
| **Why** | Trailer watches must not create resume/play-count state or become taste/neural recommendation signals. |
| **Where** | `Emby.Server.Implementations/Session/SessionManager.cs` |
| **How** | Skips playback start/progress/stop persistence when the resolved library item is a `Trailer`; applies after `jellyfin_playback_statistics` so its insert path is covered too. |
| **Related** | The plugin trailer relay remains available through its API; UI Next currently exposes local trailers only. [pantherale0#15](https://github.com/pantherale0/Jellyfin.Pgsql/issues/15). |

### `jellyfin_user_taste_profiles.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | DB entities for `UserTasteProfile` and `TasteModelEvalRun` (including time-split and For You engage-rate columns). |
| **Why** | Persist taste vectors and admin eval runs in the system DB (synced to PG). |
| **Where** | Entity classes + `JellyfinDbContext` |
| **How** | Schema only; logic lives in the plugin. |
| **Related** | Plugin `Taste/` and UI Next taste screens. No public issue. |

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

### `jellyfin_zz_user_taste_because_you.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | DB entity for precomputed Because you watched/liked similar rows (`UserTasteBecauseYouRecommendation`). |
| **Why** | Movies Recommendations must not run neural inference on each request (Cloudflare 524). |
| **Where** | `UserTasteBecauseYouRecommendation.cs`, `JellyfinDbContext` |
| **How** | Schema for the recommendations refresh job; `zz_` so it applies after `jellyfin_z_user_taste_recommendation_impressions`. |
| **Related** | `jellyfin_user_taste_recommendations`; plugin `Taste/` + `Similar/`. No public issue. |

### `jellyfin_foryou_home_section.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Adds `ForYou` to `HomeSectionType` and display-preferences handling. |
| **Why** | Home layout needs a first-class section type for taste recommendations. |
| **Where** | `HomeSectionType.cs`, `DisplayPreferencesController.cs` |
| **How** | Enum + API recognition of the new section. |
| **Related** | UI Next's For You home section. No public issue. |

### `jellyfin_z_beyond_your_library_home.patch`

| | |
|---|---|
| **Target** | `jellyfin` |
| **What** | Adds `BeyondYourLibrary` home section enum value (late `z_`). |
| **Why** | Server must recognize the Seerr discover home section. |
| **Where** | `HomeSectionType.cs` |
| **How** | Enum extension only. |
| **Related** | UI Next's Beyond Your Library rows. No public issue. |

---
