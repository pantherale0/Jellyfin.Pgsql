import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { afterEach, test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requests = [];
const storage = new Map();
const opened = [];
const windowEvents = new EventTarget();
globalThis.window = {
    location: { href: 'https://jellyfin.example.test/web/', origin: 'https://jellyfin.example.test' },
    setTimeout,
    clearTimeout,
    open: (...args) => opened.push(args),
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents)
};
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
};
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    constructor() { this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getAllResponseHeaders() { return ''; }
    getResponseHeader() { return null; }
    abort() {}
    send() {
        requests.push({ method: this.method, url: this.url, headers: this.headers });
        queueMicrotask(() => {
            this.status = 200;
            this.responseText = '[]';
            this.onload();
        });
    }
};

const host = await import('../src/native-host.ts');
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');

const identity = { deviceId: 'android-device-1', deviceName: 'Pixel 9', appName: 'Jellyfin Android', appVersion: '2.6.3' };
const appHost = (overrides = {}) => ({
    deviceId: () => identity.deviceId,
    deviceName: () => identity.deviceName,
    appName: () => identity.appName,
    appVersion: () => identity.appVersion,
    ...overrides
});

afterEach(() => {
    delete globalThis.NativeShell;
    delete globalThis.window.NativePlayer;
    host.resetHostIdentity();
    requests.length = 0;
    opened.length = 0;
});

test('without a NativeShell every hook is a no-op and identity stays on the browser', async () => {
    assert.equal(host.hasNativeShell(), false);
    assert.equal(await host.initHostIdentity(), null);
    assert.equal(host.hostIdentity(), null);
    assert.equal(host.nativeShellLayout(), null);
    host.notifySignedIn({ Id: 'u' }, 'token');
    host.notifySignedOut();
    host.enableHostFullscreen();
    host.disableHostFullscreen();
    host.updateHostVolume(0.5);
    host.hideHostMediaSession();
    host.openHostClientSettings();
    host.openHostDownloadManager();
    host.exitHostApp();
    assert.equal(host.hostDownload({ url: 'https://jellyfin.example.test/Items/1/Download', itemId: '1', title: 'x', filename: 'x.mkv' }), false);
});

test('host identity reads the AppHost getters after init', async () => {
    const calls = [];
    globalThis.NativeShell = { AppHost: appHost({ init: () => { calls.push('init'); } }) };
    assert.deepEqual(await host.initHostIdentity(), identity);
    assert.deepEqual(calls, [ 'init' ]);
    assert.deepEqual(host.hostIdentity(), identity);
    host.resetHostIdentity();
    assert.equal(host.hostIdentity(), null);
});

test('host identity accepts an async init result when getters are missing', async () => {
    globalThis.NativeShell = { AppHost: { init: async () => ({ ...identity }) } };
    assert.deepEqual(await host.initHostIdentity(), identity);
});

test('host identity times out, rejects invalid values and survives a throwing host', async () => {
    globalThis.NativeShell = { AppHost: appHost({ init: () => new Promise(() => {}) }) };
    assert.equal(await host.initHostIdentity(20), null);

    globalThis.NativeShell = { AppHost: appHost({ deviceId: () => 'bad\nid' }) };
    assert.equal(await host.initHostIdentity(), null);
    globalThis.NativeShell = { AppHost: appHost({ deviceName: () => 'x'.repeat(300) }) };
    assert.equal(await host.initHostIdentity(), null);
    globalThis.NativeShell = { AppHost: appHost({ appName: () => 42 }) };
    assert.equal(await host.initHostIdentity(), null);

    globalThis.NativeShell = { AppHost: appHost({ init: () => { throw new Error('boom'); } }) };
    assert.equal(await host.initHostIdentity(), null);
    globalThis.NativeShell = { AppHost: appHost({ init: () => Promise.reject(new Error('boom')) }) };
    assert.equal(await host.initHostIdentity(), null);
});

test('the Authorization header uses the host identity when present and the browser identity otherwise', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const session = { server: 'https://jellyfin.example.test', token: 'secret', user: { Id: 'user-id', Name: 'User' }, serverId: 'server-id' };

    await new JellyfinApi(session).getCultures();
    const browser = requests.at(-1).headers.Authorization;
    assert.match(browser, /Client="Jellyfin%20UI%20Next"/);
    assert.match(browser, new RegExp(`DeviceId="${storage.get('jellyfin-ui-next-device-id')}"`));
    assert.doesNotMatch(browser, /android-device-1/);

    globalThis.NativeShell = { AppHost: appHost() };
    await host.initHostIdentity();
    await new JellyfinApi(session).getCultures();
    const native = requests.at(-1).headers.Authorization;
    assert.match(native, /Client="Jellyfin%20Android"/);
    assert.match(native, /Device="Pixel%209"/);
    assert.match(native, /DeviceId="android-device-1"/);
    assert.match(native, /Version="2\.6\.3"/);
    assert.match(native, /Token="secret"/);
});

test('supports() defers to the host and only accepts a literal true', () => {
    globalThis.NativeShell = { AppHost: { supports: feature => feature === 'clientsettings' ? true : feature === 'exitmenu' ? 'yes' : false } };
    assert.equal(host.hostSupports('clientsettings'), true);
    assert.equal(host.hostSupports('exitmenu'), false);
    assert.equal(host.hostSupports('filedownload'), false);
    globalThis.NativeShell = { AppHost: { supports: () => { throw new Error('boom'); } } };
    assert.equal(host.hostSupports('filedownload'), false);
});

test('browser defaults mirror Jellyfin Web for desktop and TV', () => {
    for (const feature of [ 'filedownload', 'externallinks', 'fullscreenchange', 'fileinput' ]) {
        assert.equal(host.browserSupports(feature, false), true, feature);
        assert.equal(host.browserSupports(feature, true), false, feature);
    }
    assert.equal(host.browserSupports('sharing', false, true), true);
    assert.equal(host.browserSupports('sharing', false, false), false);
    for (const feature of [ 'clientsettings', 'downloadmanagement', 'exitmenu' ]) assert.equal(host.browserSupports(feature, false), false, feature);
});

test('hostDeviceProfile uses a valid host profile and falls back on malformed or failing hosts', async () => {
    const built = { DirectPlayProfiles: [ { Type: 'Video' } ], TranscodingProfiles: [], Name: 'ui-next' };
    const build = () => ({ ...built });
    assert.deepEqual(await host.hostDeviceProfile(build, '1.0'), built);

    let received;
    globalThis.NativeShell = { AppHost: { getDeviceProfile: (builder, version) => { received = version; return { ...builder(), Name: 'native' }; } } };
    assert.equal((await host.hostDeviceProfile(build, '1.0')).Name, 'native');
    assert.equal(received, '1.0');

    globalThis.NativeShell = { AppHost: { getDeviceProfile: async () => ({ Name: 'broken' }) } };
    assert.equal((await host.hostDeviceProfile(build, '1.0')).Name, 'ui-next');
    globalThis.NativeShell = { AppHost: { getDeviceProfile: () => Promise.reject(new Error('boom')) } };
    assert.equal((await host.hostDeviceProfile(build, '1.0')).Name, 'ui-next');
    globalThis.NativeShell = { AppHost: { getDeviceProfile: () => { throw new Error('boom'); } } };
    assert.equal((await host.hostDeviceProfile(build, '1.0')).Name, 'ui-next');
});

test('hostDeviceProfile falls back when the wrapper never resolves its profile', async () => {
    const built = { DirectPlayProfiles: [ { Type: 'Video' } ], TranscodingProfiles: [], Name: 'ui-next' };
    const build = () => ({ ...built });
    globalThis.NativeShell = { AppHost: { getDeviceProfile: () => new Promise(() => undefined) } };
    let timer;
    const result = await Promise.race([
        host.hostDeviceProfile(build, '1.0', 5),
        new Promise(resolve => { timer = setTimeout(() => resolve('timed out'), 50); })
    ]);
    clearTimeout(timer);

    assert.deepEqual(result, built);
});

test('hooks forward to the host and swallow host failures', () => {
    const calls = [];
    globalThis.NativeShell = {
        AppHost: { exit: () => calls.push([ 'exit' ]), getDefaultLayout: () => 'tv' },
        onLocalUserSignedIn: (user, token) => calls.push([ 'in', user.Id, token ]),
        onLocalUserSignedOut: info => calls.push([ 'out', info.serverId ]),
        enableFullscreen: () => calls.push([ 'fs-on' ]),
        disableFullscreen: () => Promise.reject(new Error('async boom')),
        openClientSettings: () => calls.push([ 'settings' ]),
        openDownloadManager: () => { throw new Error('boom'); },
        updateVolumeLevel: level => calls.push([ 'volume', level ]),
        hideMediaSession: () => calls.push([ 'hide' ])
    };
    host.notifySignedIn({ Id: 'user-id' }, 'token');
    host.notifySignedOut({ serverId: 'server-id' });
    host.enableHostFullscreen();
    host.disableHostFullscreen();
    host.openHostClientSettings();
    host.openHostDownloadManager();
    host.updateHostVolume(0.456);
    host.updateHostVolume(4);
    host.updateHostVolume(Number.NaN);
    host.hideHostMediaSession();
    host.exitHostApp();
    assert.equal(host.nativeShellLayout(), 'tv');
    assert.deepEqual(calls, [
        [ 'in', 'user-id', 'token' ], [ 'out', 'server-id' ], [ 'fs-on' ], [ 'settings' ],
        [ 'volume', 46 ], [ 'volume', 100 ], [ 'hide' ], [ 'exit' ]
    ]);
});

test('openExternalUrl only opens http(s) URLs, through the host when available', () => {
    assert.equal(host.openExternalUrl('javascript:alert(1)'), false);
    assert.equal(host.openExternalUrl('data:text/html,hi'), false);
    assert.equal(host.openExternalUrl('not a url'), false);
    assert.equal(host.openExternalUrl('https://www.imdb.com/title/tt0111161'), true);
    assert.deepEqual(opened, [ [ 'https://www.imdb.com/title/tt0111161', '_blank', 'noopener,noreferrer' ] ]);

    const urls = [];
    globalThis.NativeShell = { openUrl: (url, target) => urls.push([ url, target ]) };
    assert.equal(host.openExternalUrl('javascript:alert(1)'), false);
    assert.equal(host.openExternalUrl('http://example.test/a'), true);
    assert.deepEqual(urls, [ [ 'http://example.test/a', '_blank' ] ]);
    assert.equal(opened.length, 1);
});

test('hostDownload prefers downloadFiles, then downloadFile, else leaves it to the browser', () => {
    const item = { url: 'https://jellyfin.example.test/Items/1/Download?api_key=t', itemId: '1', serverId: 's', title: 'Movie', filename: 'movie.mkv' };
    const seen = [];
    globalThis.NativeShell = { downloadFiles: items => seen.push([ 'many', items ]), downloadFile: one => seen.push([ 'one', one ]) };
    assert.equal(host.hostDownload(item), true);
    assert.deepEqual(seen, [ [ 'many', [ item ] ] ]);

    seen.length = 0;
    globalThis.NativeShell = { downloadFile: one => seen.push([ 'one', one ]) };
    assert.equal(host.hostDownload(item), true);
    assert.deepEqual(seen, [ [ 'one', item ] ]);
    assert.equal(host.hostDownload({ ...item, url: 'javascript:alert(1)' }), false);

    globalThis.NativeShell = {};
    assert.equal(host.hostDownload(item), false);
});

test('hostMediaSessionInfo builds the Jellyfin Web payload in milliseconds', () => {
    const episode = { Id: 'ep', Name: 'Pilot', SeriesName: 'Show', SeasonName: 'Season 1', RunTimeTicks: 36_000_000_000 };
    assert.deepEqual(host.hostMediaSessionInfo(episode, { action: 'timeupdate', positionSeconds: 61.25, durationSeconds: 3600, paused: false, imageUrl: 'https://img' }), {
        action: 'timeupdate', isLocalPlayer: true, itemId: 'ep', title: 'Pilot', artist: 'Show', album: 'Season 1',
        duration: 3_600_000, position: 61_250, imageUrl: 'https://img', canSeek: true, isPaused: false
    });
    const track = host.hostMediaSessionInfo({ Id: 't', Name: 'Song', Album: 'LP', AlbumArtists: [ { Name: 'Band', Id: 'b' } ] }, { action: 'pause', positionSeconds: 10, durationSeconds: Number.NaN, paused: true });
    assert.equal(track.artist, 'Band');
    assert.equal(track.album, 'LP');
    assert.equal(track.duration, 0);
    assert.equal(track.canSeek, false);
    assert.equal(track.isPaused, true);
    assert.equal(track.imageUrl, undefined);

    const live = host.hostMediaSessionInfo({ Id: 'ch', Name: 'Live' }, { action: 'playing', positionSeconds: 5, durationSeconds: Number.POSITIVE_INFINITY, paused: false });
    assert.equal(live.canSeek, false);
    const fallback = host.hostMediaSessionInfo(episode, { action: 'playing', positionSeconds: 9999, durationSeconds: 0, paused: false });
    assert.equal(fallback.duration, 3_600_000);
    assert.equal(fallback.position, 3_600_000);
});

test('UI wiring: identity before render, menu entries, sign-in/out, gated features and player hooks', () => {
    const main = source('main.tsx');
    assert.match(main, /void initHostIdentity\(\)\.finally\(\(\) => render\(<App \/>/);
    assert.match(main, /notifySignedIn\(\{ \.\.\.session\.user, ServerId: session\.serverId \}, session\.token\)/);
    assert.match(main, /notifySignedOut\(\{ serverId: hostSignedIn\.current \}\)/);
    assert.match(main, /hostSupports\('clientsettings'\) && <button[^\n]*openHostClientSettings\(\)/);
    assert.match(main, /hostSupports\('downloadmanagement'\) && <button[^\n]*openHostDownloadManager\(\)/);
    assert.match(main, /hostSupports\('exitmenu'\) && <button[^\n]*exitHostApp\(\)/);

    const api = source('api.ts');
    assert.match(api, /hostDeviceProfile\(\(\) => buildDeviceProfile\(/);
    assert.match(api, /host\?\.appName \|\| CLIENT_NAME/);

    const details = source('detail-sections.tsx');
    assert.match(details, /hostSupports\('externallinks'\)/);
    assert.match(details, /hostSupports\('filedownload'\)/);
    assert.match(details, /hostDownload\(/);
    assert.match(details, /openExternalUrl\(/);

    const metadata = source('metadata-editors.tsx');
    assert.equal((metadata.match(/hostSupports\('fileinput'\)/g) || []).length, 3);
    assert.match(metadata, /hostSupports\('externallinks'\)/);
    assert.match(source('profile.tsx'), /hostSupports\('fileinput'\)/);

    const player = source('player.tsx');
    assert.match(player, /useRef\(hostSupports\('fullscreenchange'\)\)/);
    assert.match(player, /enableHostFullscreen\(\);\s*return \(\) => disableHostFullscreen\(\);/);
    assert.match(player, /updateHostMediaSession\(hostMediaSessionInfo\(/);
    assert.match(player, /hideHostMediaSession\(\)/);
    assert.match(player, /updateHostVolume\(/);
    assert.match(player, /\{fullscreenSupported && <button/);

    assert.match(source('layout-mode.ts'), /import \{ nativeShellLayout \} from '\.\/native-host'/);
});

test('Android playback options start one item at the requested position', () => {
    assert.equal(typeof host.buildAndroidNativePlayOptions, 'function');
    assert.deepEqual(host.buildAndroidNativePlayOptions({ itemId: 'movie-1', startPositionTicks: 12_345 }), {
        ids: [ 'movie-1' ],
        startIndex: 0,
        startPositionTicks: 12_345
    });
});

test('Android native handoff eligibility includes video media and excludes audio, books and entities', () => {
    assert.equal(typeof host.canHandOffToAndroidNativePlayer, 'function');
    assert.equal(host.canHandOffToAndroidNativePlayer({ Type: 'Movie', MediaType: 'Video' }), true);
    assert.equal(host.canHandOffToAndroidNativePlayer({ Type: 'TvChannel' }), true);
    assert.equal(host.canHandOffToAndroidNativePlayer({ Type: 'Audio', MediaType: 'Audio' }), false);
    assert.equal(host.canHandOffToAndroidNativePlayer({ Type: 'Book' }), false);
    assert.equal(host.canHandOffToAndroidNativePlayer({ Type: 'Person' }), false);
});

test('Android playback options preserve queue order and start at the selected entry', () => {
    assert.deepEqual(host.buildAndroidNativePlayOptions({
        itemId: 'episode-2',
        startPositionTicks: 0,
        queue: {
            order: [ { Id: 'episode-1' }, { Id: 'episode-2' }, { Id: 'episode-2' }, { Id: 'episode-3' } ],
            position: 2
        }
    }), {
        ids: [ 'episode-1', 'episode-2', 'episode-2', 'episode-3' ],
        startIndex: 2,
        startPositionTicks: 0
    });
});

test('Android playback options put the selected title before pending queue entries', () => {
    assert.deepEqual(host.buildAndroidNativePlayOptions({
        itemId: 'movie-now',
        startPositionTicks: -1,
        queue: { order: [ { Id: 'movie-next' }, { Id: 'movie-later' } ], position: -1 }
    }), {
        ids: [ 'movie-now', 'movie-next', 'movie-later' ],
        startIndex: 0,
        startPositionTicks: 0
    });
});

test('Android player preferences map Auto to the default cap and apply an explicit cap to both networks', () => {
    assert.deepEqual(host.buildAndroidNativePlayerPreferences(0, 120_000_000), {
        maxStreamingBitrateLocal: 120_000_000,
        maxStreamingBitrateRemote: 120_000_000
    });
    assert.deepEqual(host.buildAndroidNativePlayerPreferences(4_000_000, 120_000_000), {
        maxStreamingBitrateLocal: 4_000_000,
        maxStreamingBitrateRemote: 4_000_000
    });
});

test('Android handoff sends JSON only to an enabled native player', () => {
    const calls = [];
    globalThis.window.NativePlayer = {
        isEnabled() { return this === globalThis.window.NativePlayer; },
        syncSession() { return true; },
        loadPlayer(options, preferences) { calls.push([ options, preferences, this === globalThis.window.NativePlayer ]); }
    };
    const options = { ids: [ 'movie-1' ], startIndex: 0, startPositionTicks: 99 };
    const preferences = { maxStreamingBitrateLocal: 4_000_000, maxStreamingBitrateRemote: 4_000_000 };

    assert.equal(host.dispatchAndroidNativePlayback(options, preferences), 'dispatched');
    assert.deepEqual(calls, [[
        '{"ids":["movie-1"],"startIndex":0,"startPositionTicks":99}',
        '{"maxStreamingBitrateLocal":4000000,"maxStreamingBitrateRemote":4000000}',
        true
    ]]);
});

test('Android handoff falls back when the bridge is missing, malformed, disabled or throws', () => {
    const options = { ids: [ 'movie-1' ], startIndex: 0, startPositionTicks: 0 };
    const preferences = { maxStreamingBitrateLocal: 120_000_000, maxStreamingBitrateRemote: 120_000_000 };
    assert.equal(host.dispatchAndroidNativePlayback(options, preferences), 'unavailable');

    Object.defineProperty(globalThis.window, 'NativePlayer', { configurable: true, get() { throw new Error('bridge unavailable'); } });
    assert.equal(host.dispatchAndroidNativePlayback(options, preferences), 'unavailable');
    delete globalThis.window.NativePlayer;

    globalThis.window.NativePlayer = { isEnabled: () => true };
    assert.equal(host.dispatchAndroidNativePlayback(options, preferences), 'unavailable');

    globalThis.window.NativePlayer = { isEnabled: () => { throw new Error('bridge unavailable'); }, loadPlayer: () => assert.fail('unknown bridge state must not load') };
    assert.equal(host.dispatchAndroidNativePlayback(options, preferences), 'unavailable');

    globalThis.window.NativePlayer = { isEnabled: () => 'true', syncSession: () => true, loadPlayer: () => assert.fail('disabled bridge must not load') };
    assert.equal(host.dispatchAndroidNativePlayback(options, preferences), 'disabled');

    globalThis.window.NativePlayer = { isEnabled: () => true, syncSession: () => true, loadPlayer: () => { throw new Error('bridge failed'); } };
    assert.equal(host.dispatchAndroidNativePlayback(options, preferences), 'failed');
});

test('Android playback waits for a matching native session-ready acknowledgement', async () => {
    const calls = [];
    globalThis.window.NativePlayer = {
        isEnabled: () => true,
        syncSession: (requestId, serverUrl, userId, accessToken) => {
            calls.push([ requestId, serverUrl, userId, accessToken ]);
            queueMicrotask(() => {
                globalThis.window.dispatchEvent(new CustomEvent('jellyfin-native-session-sync', { detail: { requestId: 'stale-request', ready: true } }));
                globalThis.window.dispatchEvent(new CustomEvent('jellyfin-native-session-sync', { detail: { requestId, ready: true } }));
            });
            return true;
        },
        loadPlayer: () => undefined
    };

    assert.equal(typeof host.synchronizeAndroidNativePlayerSession, 'function');
    assert.equal(await host.synchronizeAndroidNativePlayerSession({
        serverUrl: 'https://jellyfin.example.test/web/',
        userId: '018f6bd5-33c5-7abc-8c3f-55f62bc95b13',
        accessToken: 'opaque-access-token'
    }, 50), 'ready');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'https://jellyfin.example.test/web/');
    assert.equal(calls[0][2], '018f6bd5-33c5-7abc-8c3f-55f62bc95b13');
    assert.equal(calls[0][3], 'opaque-access-token');
});

test('Android session sync refuses cross-origin, disabled, rejected and timed-out requests', async () => {
    const session = { serverUrl: 'https://jellyfin.example.test', userId: 'user-id', accessToken: 'secret' };
    const calls = [];
    globalThis.window.NativePlayer = {
        isEnabled: () => true,
        syncSession: (...args) => { calls.push(args); return true; },
        loadPlayer: () => undefined
    };
    assert.equal(await host.synchronizeAndroidNativePlayerSession({ ...session, serverUrl: 'https://other.example.test' }, 20), 'unavailable');
    assert.equal(calls.length, 0);

    globalThis.window.NativePlayer.isEnabled = () => false;
    assert.equal(await host.synchronizeAndroidNativePlayerSession(session, 20), 'disabled');
    assert.equal(calls.length, 0);

    globalThis.window.NativePlayer.isEnabled = () => true;
    globalThis.window.NativePlayer.syncSession = requestId => {
        queueMicrotask(() => globalThis.window.dispatchEvent(new CustomEvent('jellyfin-native-session-sync', { detail: { requestId, ready: false } })));
        return true;
    };
    assert.equal(await host.synchronizeAndroidNativePlayerSession(session, 50), 'rejected');

    globalThis.window.NativePlayer.syncSession = () => true;
    assert.equal(await host.synchronizeAndroidNativePlayerSession(session, 5), 'timeout');
});

test('native player return refresh waits for a hidden or blurred page to become active', () => {
    assert.equal(typeof host.listenForNativePlayerReturn, 'function');
    const windowEvents = new EventTarget();
    const documentEvents = new EventTarget();
    const previous = {
        windowAdd: globalThis.window.addEventListener,
        windowRemove: globalThis.window.removeEventListener,
        documentAdd: globalThis.document.addEventListener,
        documentRemove: globalThis.document.removeEventListener,
        visibilityState: globalThis.document.visibilityState
    };
    globalThis.window.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    globalThis.window.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    globalThis.document.addEventListener = documentEvents.addEventListener.bind(documentEvents);
    globalThis.document.removeEventListener = documentEvents.removeEventListener.bind(documentEvents);
    globalThis.document.visibilityState = 'visible';

    try {
        let returns = 0;
        const stop = host.listenForNativePlayerReturn(() => { returns++; });
        windowEvents.dispatchEvent(new Event('focus'));
        assert.equal(returns, 0);

        globalThis.document.visibilityState = 'hidden';
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        globalThis.document.visibilityState = 'visible';
        documentEvents.dispatchEvent(new Event('visibilitychange'));
        windowEvents.dispatchEvent(new Event('focus'));
        assert.equal(returns, 1);

        windowEvents.dispatchEvent(new Event('blur'));
        windowEvents.dispatchEvent(new Event('focus'));
        assert.equal(returns, 2);
        stop();
    } finally {
        if (previous.windowAdd) globalThis.window.addEventListener = previous.windowAdd;
        else delete globalThis.window.addEventListener;
        if (previous.windowRemove) globalThis.window.removeEventListener = previous.windowRemove;
        else delete globalThis.window.removeEventListener;
        if (previous.documentAdd) globalThis.document.addEventListener = previous.documentAdd;
        else delete globalThis.document.addEventListener;
        if (previous.documentRemove) globalThis.document.removeEventListener = previous.documentRemove;
        else delete globalThis.document.removeEventListener;
        if (previous.visibilityState === undefined) delete globalThis.document.visibilityState;
        else globalThis.document.visibilityState = previous.visibilityState;
    }
});

test('UI video playback hands off before creating a web session or negotiating a browser stream', () => {
    const main = source('main.tsx');
    const playStart = main.indexOf('const play = async (item: MediaItem');
    const nativeHandoff = main.indexOf('dispatchAndroidNativePlayback(', playStart);
    const sessionSync = main.indexOf('await synchronizeAndroidNativePlayerSession(', playStart);
    const sessionStart = main.indexOf('playbackSessions.begin(playbackItem.Id)', playStart);
    const browserNegotiation = main.indexOf('api.play(playbackItem', playStart);

    assert.ok(playStart >= 0, 'main playback handler exists');
    assert.ok(nativeHandoff > playStart, 'native bridge is checked in the playback handler');
    assert.ok(sessionSync > playStart && sessionSync < nativeHandoff, 'native app identity is acknowledged before player launch');
    assert.match(main.slice(sessionSync, nativeHandoff), /serverUrl: session\.server,[\s\S]*userId: session\.user\.Id,[\s\S]*accessToken: session\.token/);
    assert.match(main.slice(sessionSync, nativeHandoff), /nativeSessionSync === 'ready'/, 'the app must accept the session before ExoPlayer starts');
    assert.ok(nativeHandoff < sessionStart, 'native handoff precedes UI Next session ownership');
    assert.ok(sessionStart < browserNegotiation, 'browser negotiation follows the native handoff branch');
    assert.match(main.slice(playStart, nativeHandoff), /!playbackSessions\.active\(\)/, 'an active UI Next player keeps ownership');
    assert.match(main.slice(playStart, nativeHandoff), /canHandOffToAndroidNativePlayer\(playbackItem\)/, 'only native video types are eligible');
    assert.match(main.slice(nativeHandoff, sessionStart), /nativeDispatch === 'dispatched'[\s\S]*?return;/);
    assert.match(main, /listenForNativePlayerReturn\(\(\) => \{[\s\S]*?nativeReturnRefresh\.current\(itemId\)/);
    assert.match(main, /nativeHandoffItemId\.current = playbackItem\.Id;[\s\S]*?dispatchAndroidNativePlayback/);
    assert.match(main, /nativeReturnRefresh\.current = itemId => \{ void applyReportedPlayback\(itemId\); \}/);
});
