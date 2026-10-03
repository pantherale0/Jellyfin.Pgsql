# Jellyfin UI Next

An experimental, lightweight Jellyfin web client prototype built with Preact and Vite. The app is kept separate from the `jellyfin-web/` submodule so it can be measured and developed independently before any replacement or bundling decisions are made.

## Current prototype

- Jellyfin username/password sign-in
- Separate **Continue with SSO** and **Continue with Quick Access** sign-in routes, with username/password sign-in as a fallback
- Quick Access uses Jellyfin Quick Connect on desktop and TV; TV web wrappers open on this route by default, while SSO is offered on non-TV clients only
- Profile menu with modal Quick Connect authorization, playback and subtitle preferences, taste profile, remembered-user switching, sign-out, and administrator dashboard links; TV menus show only Switch user and Sign out
- Home page opens with a personalized movie + TV hero and library chips, followed by a rhythmic feed of horizontal carousels and cinematic spotlight breakouts. The feed includes continue watching, just added, On Now, Jellyfin recommendation groups, and paged “Explore your library” rails so scrolling can continue when recommendation groups are empty. Matching data can add BoxSet collection, director recommendation (4+ items), highly-rated (8+) unwatched movie (older than six months), or resumed TV-episode spotlights. Spotlights use backdrop imagery, compact metadata, Play/Resume, favorite/watchlist, and Details actions. The feed virtualizes to the current block plus one neighbor on either side and uses measured spacers, a 600px intersection margin, lazy rail images, and explicit spotlight background release when blocks leave the render window.
- Spotlight/feed blocks use a three-block render window with measured-height placeholders, a 600px observer margin, lazy rail images, and image clearing when offscreen spotlights unmount; TV directional navigation can move between spotlight actions and the next rail.
- Mobile hamburger navigation with a left-side library drawer
- Home sections load independently and expose section-specific retry when an endpoint times out
- Library browsing, basic search, item details, and a fullscreen direct-play player with custom on-screen controls
- Library browsing has a compact sticky counter/filter/sort bar, a right-edge `#` / `A`–`Z` scrubber with active-letter tracking and a drag bubble for title sorting, a transient scroll-position marker for other sorts, and grid/list views. The responsive filter popover contains genre/resolution/decade/watch-status controls; the grid removes page headings and uses 2:3 posters with virtualized rows. On TV, the right-edge rail is hidden and ArrowUp from the control bar opens a horizontal letter picker; numeric T9 keys continue to jump by title. Scrollbar chrome is hidden while native scrolling remains enabled. It requests filtered `/Items` pages of 80 and retains a sliding window of at most three pages while a fixed-height catalog canvas keeps visible rows plus a two-row buffer in the DOM. Alphabet dragging updates only the bubble until release; a jump locates the boundary with logarithmic, single-item `SortName` lookups, caches that offset for the current query, then fetches one ordinary page and positions it once. Superseded lookups and pages are cancelled, stale responses are ignored, and subsequent paging uses the same absolute catalog coordinates. This also avoids alphabet-boundary cache collisions on older plugin versions. Library posters request `maxWidth=300` at `quality=80` (list thumbnails use 160px). List rows load director names separately near the viewport so expensive full-page `People` hydration cannot block the catalog. Favorite and played state can be changed from card actions.
- TV shows open into a continuous episode explorer: series header, sticky season navigation, and a unified scroll feed across seasons. Season deep links use `?show=<seriesId>&season=<seasonNumber>` and those parameters are removed when you leave the show; episodes are paged and neighboring seasons are prefetched while the current season plus adjacent seasons are retained in memory. On very large series, unloaded season space uses measured spacers to preserve scroll position.
- Responsive layouts and directional-key focus movement for TV remotes. In a show, arrows move between episodes; arrows on the season list scroll the feed to that season.
- Live TV, when the server has a Live TV library, opens into On Now, Guide, Channels, and DVR. On Now groups what is airing. The guide is a virtualized channel-and-time grid on wide screens and a Now/Next list on small screens. Guide data is requested in four-hour windows. Channel favorites are saved on the Jellyfin account, and channel order is saved in this browser. DVR lists scheduled timers, series rules, and recordings. Watching a channel uses the fullscreen player; HLS is played natively when the browser supports it and with hls.js otherwise.
- No UI component library; CSS and Preact only

Playback fills the viewport with a custom on-screen display on the direct-play stream. Episode playback shows the series and episode code in the title, and an episodes tray can jump to another episode without leaving the player. The bar includes previous and next episode, 10-second skip, play/pause, text subtitles with a timing offset, audio tracks when the browser exposes them, playback speed, picture fit, and fullscreen. The volume slider is a desktop hover control and is hidden on small screens and TV remotes. While seeking, the timeline shows a timestamp and a trickplay thumbnail when the server has generated tiles, plus intro and credits markers when media segments exist. Controls fade after a few seconds of playback. Playback start, progress about every 10 seconds, and stop are reported to the Jellyfin session, including when the page is closed, so resume position and played state stay on the server. Changing the bitrate, burning in image subtitles, HLS adaptation, and picture-in-picture are not implemented yet. Do not use this preview as a replacement for the existing web UI.

## Develop

Requires Node.js 18+ and npm.

```sh
npm install
npm run dev
```

For a development-only backend picker, run `npm run dev:debug` and open the displayed dev-site address ending in `/debug.html`. Enter the Jellyfin base URL (for example `http://localhost:8096` or `https://media.example.net`). The launcher opens the app with the backend prefilled and the app returns to its normal URL after successful sign-in. `?server=...` can also be supplied directly to the app URL. The debug page is excluded from production builds.

To route the app's standard API proxy to a local backend, set the proxy target when starting Vite:

```sh
JELLYFIN_BACKEND_URL=https://media.example.net npm run dev:debug
```

To set the Jellyfin server for the app and skip entering its address on the sign-in screen, provide `VITE_JELLYFIN_SERVER_URL` when starting the dev server:

```sh
VITE_JELLYFIN_SERVER_URL=https://media.example.net npm run dev
```

This value prefills all sign-in flows (including SSO and Quick Connect), hides the editable server field, and is also used as the Vite API proxy target unless `JELLYFIN_BACKEND_URL` is set. Without it, the app keeps its normal saved-server and login-screen behavior. If an existing saved session belongs to a different server, it is not reused.

Vite proxies selected Jellyfin API paths to `http://localhost:8096` for local development. Change those targets in `vite.config.ts` when running the local server elsewhere. The development-only SSO probe checks the exact backend selected in `/debug.html` through Vite, so SSO availability detection does not require CORS. Login and Quick Connect requests use the entered server URL directly; a different-origin backend must allow the dev UI origin in Jellyfin CORS settings for those flows. Production use requires HTTPS except when the UI and server share an origin or for localhost development.

For HTTP backend testing, use the development server only. The app displays a warning because HTTP sends credentials and tokens without transport encryption. Use HTTPS for a real server. Cross-origin backends must allow the dev UI origin in Jellyfin CORS settings.

```sh
npm run build
npm run preview
```

The build is static and is emitted to `dist/`. It is not wired into the Jellyfin image or served at `/web/` yet. Wrapper launch behavior, media playback integration, older TV engines, and performance on physical devices must be tested before choosing a deployment path.

## Security notes

- Passwords are sent directly to the configured Jellyfin server and cleared after sign-in; they are not stored.
- The selected server, Jellyfin access token, user, and server ID are stored in `localStorage` so the login survives browser restarts; sign-out revokes the current token and records a signed-out marker so the revoked session is not restored. Earlier `sessionStorage` sessions are migrated once.
- Up to eight remembered user sessions per server are stored locally to support device-local user switching. **Switch user** keeps the old server token valid; **Sign out** revokes the current token and removes it from remembered users. Anyone with access to this browser profile can use remembered sessions, so clear browser storage on shared or untrusted devices.
- A generated device ID is stored in `localStorage` and reused on later launches. If browser storage is blocked, the app uses one stable in-memory ID for the current page session.
- Server addresses must use HTTPS, except localhost during development.
- Jellyfin API, image, login, and Quick Connect requests use the modern `Authorization: MediaBrowser ...` header. The direct-play video element uses Jellyfin's `api_key` query parameter because native media elements cannot attach custom authorization headers; playback URLs are sensitive and should not be copied or shared.
- UI Next probes `/sso/config` and `/QuickConnect/Enabled` on the selected server. **Continue with SSO** is shown only on non-TV clients when SSO is enabled; **Continue with Quick Access** starts Jellyfin Quick Connect, which must be approved from another signed-in device. TV web wrappers start on Quick Access and do not offer SSO. Username/password sign-in remains available as a fallback, and `?local=true` opens that route directly. The existing Jellyfin SSO callback ends at `/web/`, so successful SSO does not transfer a Jellyfin token back into a separately hosted UI Next page. Cross-origin login and Quick Connect requests require Jellyfin CORS to allow the UI origin.
- The profile menu offers server-backed Quick Connect authorization, playback and subtitle user preferences, the Pgsql taste profile, remembered-user switching, sign-out, and admin dashboard links; there is no generic Profile link. Quick Connect opens in a modal; TVs see only Switch user and Sign out. Playback/subtitle/taste screens make cross-origin API calls and require Jellyfin CORS to allow the UI origin.

## Compatibility and current gaps

Vite emits a modern bundle plus a syntax-transpiled legacy bundle (currently targeting Chrome 38+, Safari 10+, and Firefox 45+), with the legacy bundle selected by `@vitejs/plugin-legacy`. That is a best-effort web-engine target, not a guarantee for every TV browser. The TV layout supports directional arrows, common Back key codes, and basic media keys; it does not yet consume wrapper-specific JavaScript bridges or Jellyfin's registered device playback profile. Older webOS/Tizen models must be tested in their actual browser/wrapper. The `ui-next` client name/device identity is distinct from Jellyfin Web, so wrappers that special-case the existing client identity or inject native-shell APIs need explicit integration work.

The player fills the viewport with a custom on-screen display on a direct stream: series and episode titles, an episode tray, previous and next episode, text subtitles, playback speed, trickplay thumbnails, and intro or credits markers when the server provides them. It reports playback start, progress, and stop to the signed-in Jellyfin session. Live TV HLS plays in the video element when the browser can play it, and through hls.js when it cannot. It does not yet implement bitrate changes, image-subtitle burn-in, picture-in-picture, or a full transcode workflow. Wrapper compatibility should be considered unverified until these are implemented and tested on named target wrappers/devices.
