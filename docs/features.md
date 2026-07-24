# Features

Operator-facing map of capabilities in this fork: what you get, how to configure it, and which plugins/patches implement it. Env-var tables for Postgres, cache, and SSO remain authoritative in the [README](../README.md).

## PostgreSQL database provider

**What:** Jellyfin stores its system database in PostgreSQL instead of SQLite.

**Where:** [`Jellyfin.Plugin.Pgsql`](../Jellyfin.Plugin.Pgsql/), Docker entrypoint `POSTGRES_*` wiring, [`docker/database.xml`](../docker/database.xml).

**How:** The plugin registers as a custom database provider. Images set connection parameters from environment variables (`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, optional SSL). `Pgsql_COMMAND_TIMEOUT` (default `90`) raises Npgsql’s command timeout for heavy library queries.

**Related:** SQLite→PG migration in [README](../README.md#migrating-from-sqlite-to-postgresql); inherited scale caveats in [known issues](known-issues.md).

## Query cache and optimised Latest

**What:** Cache home Latest/Resume ID lists; optionally replace Latest queries with PostgreSQL `DISTINCT ON` variants.

**Where:** [`Jellyfin.Plugin.Pgsql/Query/`](../Jellyfin.Plugin.Pgsql/Query/); toggles `Pgsql_CACHE_*`, `Pgsql_PG_OPTIMIZE_*`, `REDIS_CONNECTION_STRING` ([README](../README.md#query-cache-and-optimisation-optional-experimental)).

**How:** Cache keys are per user and per view (never shared across users). Failures fall back to stock Jellyfin queries. Default Latest TTL is 120s (visible lag after scans).

**Patches that help home/query load:** [`jellyfin_home_api_performance`](patches.md#jellyfin_home_api_performancepatch), [`jellyfin_unoptimized_query_fixes`](patches.md#jellyfin_unoptimized_query_fixespatch), [`jellyfin_query_split_userdata`](patches.md#jellyfin_query_split_userdatapatch), [`jellyfin_latest_tv_always_series`](patches.md#jellyfin_latest_tv_always_seriespatch).

## Fuzzy search (PostgreSQL)

**What:** Server-side fuzzy / franchise-oriented search via the plugin provider; core SQL search provider is disabled when the plugin is present so results do not double-count.

**Where:** [`Jellyfin.Plugin.Pgsql/Search/`](../Jellyfin.Plugin.Pgsql/Search/); patches [`jellyfin_search_performance`](patches.md#jellyfin_search_performancepatch), [`jellyfin_disable_sql_search_provider`](patches.md#jellyfin_disable_sql_search_providerpatch); web infinite scroll on search ([`jellyfin_web_user_search_infinite_scroll`](patches.md#jellyfin_web_user_search_infinite_scrollpatch)).

**How:** Plugin registers an `ISearchProvider`. ApplicationHost prefers PostgreSQL similarity for “Similar” and excludes `SqlSearchProvider` from search parts.

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

## Playback statistics

**What:** Persist playback activity (including daily rollups / delivery method analytics) and expose user + admin dashboards with charts and CSV export.

**Where:** Server [`jellyfin_playback_statistics`](patches.md#jellyfin_playback_statisticspatch); web [`jellyfin_web_user_playback_stats`](patches.md#jellyfin_web_user_playback_statspatch) (Dashboard → Reports → Playback). Progress write load reduced by [`jellyfin_playback_progress_coalesce`](patches.md#jellyfin_playback_progress_coalescepatch).

## Taste profiles, For You, and taste models

**What:** Per-user taste profiles and precomputed recommendations; home “For You” section; user taste identity UI; admin shadow-eval reports for taste models. Engagement weighting uses completion-aware playback (short abandons are negatives; deep watches/favorites are positives) and For You impression logs so recommended→engage is boosted and recommended→abandon is penalized more strongly. The neural model remains shadow-only (`UseNeuralForServing` off).

**Where:**

- DB entities: [`jellyfin_user_taste_profiles`](patches.md#jellyfin_user_taste_profilespatch), [`jellyfin_user_taste_recommendations`](patches.md#jellyfin_user_taste_recommendationspatch), [`jellyfin_z_user_taste_recommendation_impressions`](patches.md#jellyfin_z_user_taste_recommendation_impressionspatch)
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

**What:** Guide/listings performance, published URL rewrites for Docker, clearing unreachable tuner-origin Paths from PlaybackInfo (so clients use `TranscodingUrl` / LiveStreamFiles), SharedHttpStream for extensionless HTTP M3U origins (e.g. Dispatcharr), rolling stream buffers / keep-alive seconds, configurable probe delay and SharedHttpStream open timeout, non-blocking live-stream open/close (avoids freezing all Live TV on one stalled M3U open), per-channel keyed share-or-create with safe `ConsumerCount`, reverse-close when clients omit `LiveStreamId`, orphaned open-stream sweep, `livetv` item alias, active recordings widget.

**Where:** See [Live TV patch group](patches.md#4-live-tv). Notable upstream refs: [jellyfin#15411](https://github.com/jellyfin/jellyfin/issues/15411) / [PR #17298](https://github.com/jellyfin/jellyfin/pull/17298), [jellyfin#17128](https://github.com/jellyfin/jellyfin/pull/17128), [jellyfin#9813](https://github.com/jellyfin/jellyfin/issues/9813), [jellyfin#17319](https://github.com/jellyfin/jellyfin/issues/17319), [jellyfin#16880](https://github.com/jellyfin/jellyfin/issues/16880), [jellyfin#17177](https://github.com/jellyfin/jellyfin/issues/17177), [jellyfin-web#8072](https://github.com/jellyfin/jellyfin-web/pull/8072). Encoding UI: [`jellyfin_web_live_stream`](patches.md#jellyfin_web_live_streampatch).

## Playback / encoding tooling

**What:** Lazy transcoding pipeline probe exposed to admins; hardware encoder capability API + dashboard; HLS remux restart behaviour; HDR10+ SEI strip on MPEG-TS; Chrome/Opera MKV DirectPlay false-positive fix.

**Where:** [Playback / encoding group](patches.md#3-playback--encoding). Upstream: [jellyfin#13668](https://github.com/jellyfin/jellyfin/issues/13668), [jellyfin#16823](https://github.com/jellyfin/jellyfin/issues/16823), [jellyfin-web#7651](https://github.com/jellyfin/jellyfin-web/issues/7651).

## Parental library images

**What:** Library/collection/splash images respect parental filters so restricted users do not see collage tiles from blocked titles.

**Where:** [`jellyfin_library_image_parental`](patches.md#jellyfin_library_image_parentalpatch).

## TV / webOS UX

**What:** Infinite scroll on library views, TV focus/nav helpers, capped home-row / lazy-load pressure, webOS 5 / older Chromium workarounds, Quick Connect-first login on TV.

**Where:** [TV UX group](patches.md#8-tv--web-ux).

## Library / plugin reliability

**What:** Path-aware media refresh; BaseItem image-info dedupe; person provider-key identity; refuse deleting “disabled” plugins when the name is newly seen; fix plugin ALC so transitive deps (for example Redis) resolve from `.deps.json`.

**Where:** [Library / metadata group](patches.md#5-library--metadata--plugin-loading); favorites-during-progress fix [jellyfin#14981](https://github.com/jellyfin/jellyfin/issues/14981).
