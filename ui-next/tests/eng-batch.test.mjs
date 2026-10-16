import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requests = [];
const responses = [];
const held = [];
let holdResponses = false;
const store = new Map();
beforeEach(() => { requests.length = 0; responses.length = 0; held.length = 0; holdResponses = false; store.clear(); });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/', origin: 'https://jellyfin.example.test' }, setTimeout };
globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    abort() { this.onabort?.(); }
    respond(response) {
        this.status = response.status;
        this.responseText = response.body;
        this.onload();
    }
    send() {
        requests.push({ method: this.method, url: this.url });
        if (holdResponses) { held.push(this); return; }
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => this.respond(response));
    }
};

const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'Viewer' }, serverId: 'server-id' };
const root = path => new URL(`../${path}`, import.meta.url);
const source = file => readSource(root(`src/${file}`), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('ENG-01 legacy bundles polyfill by usage and shim the unguarded DOM APIs', async () => {
    const config = readFileSync(root('vite.config.ts'), 'utf8');
    assert.match(config, /modernPolyfills: true/, 'older modern targets get usage-detected polyfills');
    assert.match(config, /polyfills: true/, 'legacy bundle polyfills are usage-detected, not a fixed list');
    assert.doesNotMatch(config, /polyfills: \[/, 'no hand-picked core-js module list');
    assert.match(source('main.tsx'), /^import '\.\/legacy-shims';/, 'shims load before any app module');

    const { installLegacyShims, AbortControllerShim } = await import('../src/legacy-shims.ts');
    const scope = {};
    const parent = { tag: 'section', parentElement: null, matches: selector => selector === 'section' };
    const proto = { webkitMatchesSelector() { return false; } };
    installLegacyShims(scope, proto);
    assert.equal(scope.AbortController, AbortControllerShim);
    const child = { parentElement: parent, matches: () => false };
    assert.equal(proto.closest.call(child, 'section'), parent, 'closest walks ancestors');
    assert.equal(proto.closest.call(child, 'nav'), null);
    assert.equal(proto.matches, proto.webkitMatchesSelector, 'matches falls back to the prefixed form');
    const native = class {};
    const modern = { AbortController: native };
    installLegacyShims(modern);
    assert.equal(modern.AbortController, native, 'native implementations are never replaced');

    const controller = new AbortControllerShim();
    const seen = [];
    const listener = () => seen.push('listener');
    controller.signal.onabort = () => seen.push('onabort');
    controller.signal.addEventListener('abort', listener);
    controller.signal.addEventListener('abort', listener);
    controller.abort();
    controller.abort();
    assert.ok(controller.signal.aborted);
    assert.deepEqual(seen, [ 'onabort', 'listener' ], 'abort fires once per listener');
    assert.match(source('api.ts'), /function abortError\(\): Error/, 'AbortError creation survives a non-constructible DOMException');
    assert.match(source('build.ts'), /typeof fetch !== 'function'/);
});

test('ENG-03 queued work ages into the interactive lane and is dropped after its deadline', async () => {
    const { effectivePriority, QUEUE_AGEING_MS, QUEUE_DEADLINE_MS, JellyfinApi } = await import('../src/api.ts');
    assert.equal(effectivePriority(1, 0, QUEUE_AGEING_MS - 1), 1);
    assert.equal(effectivePriority(1, 0, QUEUE_AGEING_MS), 2, 'bulk work cannot starve behind sustained clicks');
    assert.equal(effectivePriority(0, 0, QUEUE_AGEING_MS), 2);
    assert.equal(effectivePriority(3, 0, 0), 3);

    const api = new JellyfinApi(session);
    holdResponses = true;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        const busy = [ 0, 1, 2, 3 ].map(index => api.request(`/Busy/${index}`));
        const queued = api.request('/Queued', {}, false, 1);
        const outcome = queued.then(() => 'resolved', error => error.message);
        await settle();
        assert.equal(held.length, 4, 'the fifth request waits for a slot');
        now += QUEUE_DEADLINE_MS + 1;
        held[0].respond({ status: 200, body: '{}' });
        assert.equal(await outcome, 'The Jellyfin server took too long to respond.');
        assert.ok(!requests.some(request => request.url.endsWith('/Queued')), 'expired work never starts');
        held.slice(1).forEach(xhr => xhr.respond({ status: 200, body: '{}' }));
        await Promise.all(busy);
    } finally {
        Date.now = realNow;
    }
});

test('ENG-04 request options only promise what the transport implements', () => {
    const api = source('api.ts');
    const init = api.slice(api.indexOf('export interface ApiRequestInit'), api.indexOf('}', api.indexOf('export interface ApiRequestInit')));
    assert.match(init, /headers\?: Record<string, string>/);
    assert.match(init, /body\?: string \| FormData/);
    assert.doesNotMatch(init.slice(init.indexOf('{')), /HeadersInit|BodyInit|RequestInit/);
});

test('ENG-06/07 slow navigation commits only while its intent and account are current', async () => {
    const { AccountGeneration } = await import('../src/account-generation.ts');
    const { NavigationOwner } = await import('../src/navigation-owner.ts');
    const account = new AccountGeneration();
    const navigation = new NavigationOwner(account);
    const first = navigation.begin();
    assert.ok(navigation.isCurrent(first));
    const second = navigation.begin();
    assert.ok(!navigation.isCurrent(first), 'a newer intent wins');
    navigation.retire();
    assert.ok(!navigation.isCurrent(second), 'another route choice retires pending intents');
    const third = navigation.begin();
    account.begin();
    assert.ok(!navigation.isCurrent(third), 'an account change retires intents too');

    const main = source('main.tsx');
    assert.match(main, /const playbackSession = playbackSessions\.begin\(playbackItem\.Id\);/, 'playback negotiation owns a session');
    assert.match(main, /if \(!playbackSessions\.commit\(playbackSession, result\)\) \{\s+await api\.releasePlayback\(result\);\s+return;\s+\}\s+setPlayerItem/, 'slow PlaybackInfo is released instead of opening the player after another choice');
    assert.match(main, /if \(navigation\.isCurrent\(intent\) && series\.Type === 'Series'\) void openSeries\(series, item\.IndexNumber/, 'Season-to-Series lookup checks ownership');
    assert.match(main, /if \(!navigation\.isCurrent\(intent\) \|\| series\.Type !== 'Series'\) return;/, 'episode-to-series lookup checks ownership');
    assert.match(main, /useLayoutEffect\(\(\) => \{\n\s+if \(retiredRouteIdentity\.current === currentRouteIdentity\) return;[\s\S]{0,120}navigation\.retire\(\);/, 'every route change retires pending intents centrally');
});

test('ENG-08 the library initial load restarts on API identity without pagination deps', () => {
    const library = source('library.tsx');
    assert.doesNotMatch(library, /eslint-disable/);
    assert.match(library, /\}, \[ api, library\.Id, query, view, selectedYears \]\);/, 'a new account/API restarts the load');
    assert.match(library, /previousLoad\.current\.api === api && previousLoad\.current\.libraryId === library\.Id/, 'an API change is a full reset, not a view switch');
    assert.match(library, /void loadRef\.current\(/, 'the latest loader runs through a ref');
});

test('ENG-09 virtual row geometry reads the same values CSS uses to size rows', async () => {
    const { libraryGeometry } = await import('../src/library-geometry.ts');
    const style = values => ({ getPropertyValue: name => values[name] ?? '' });
    assert.deepEqual(libraryGeometry(style({ '--library-list-row': ' 104px', '--library-poster-ratio': ' 1.4' })), { listRow: 104, posterRatio: 1.4 });
    assert.deepEqual(libraryGeometry(style({})), { listRow: 92, posterRatio: 1.5 }, 'unset properties fall back to the stylesheet defaults');
    assert.deepEqual(libraryGeometry(style({ '--library-list-row': 'auto', '--library-poster-ratio': '0' })), { listRow: 92, posterRatio: 1.5 });
    const css = source('style.css');
    assert.match(css, /\.library-grid-items \{ --library-list-row: 92px; --library-poster-ratio: 1\.5;/);
    assert.match(css, /aspect-ratio: 1 \/ var\(--library-poster-ratio, 1\.5\)/);
    assert.match(css, /grid-auto-rows: var\(--library-list-row\)/);
    assert.doesNotMatch(css, /grid-auto-rows: 92px/);
    const library = source('library.tsx');
    assert.doesNotMatch(library, /return 92 \+ gapY|width \* 1\.5/, 'no duplicated layout constants in the virtualizer');
});

test('ENG-10 scheduler comments describe only what the code guarantees', () => {
    const api = source('api.ts');
    assert.match(api, /Plain <img> elements \(home feed cards, live thumbnails\) are fetched\n\/\/ by the browser and are not counted here/);
    assert.match(api, /the parse itself still occupies the main thread/);
});

test('ENG-12 tests run in the documented runtime, in CI and before the image build', () => {
    const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs e2e/fake-server/*.test.mjs');
    assert.equal(pkg.engines.node, '>=22.18');
    const workflow = readFileSync(new URL('../../.github/workflows/test.yaml', import.meta.url), 'utf8');
    assert.match(workflow, /ui-next:\n\s+runs-on: ubuntu-latest\n\s+defaults:\n\s+run:\n\s+working-directory: ui-next/);
    assert.match(workflow, /run: npm ci[\s\S]*run: npx tsc --noEmit[\s\S]*run: npm test/);
    const dockerfile = readFileSync(new URL('../../docker/Dockerfile', import.meta.url), 'utf8');
    assert.match(dockerfile, /npm test/);
    assert.match(readFileSync(root('README.md'), 'utf8'), /Node\.js 22\.18\+[\s\S]*registerHooks/);
});

test('ENG-13 the served build identifies itself and stale bundles are flagged', async () => {
    const { clientVersion, isStaleBundle } = await import('../src/build.ts');
    assert.equal(clientVersion('0123456789abcdef0123'), '0.1.0+0123456789ab');
    assert.equal(clientVersion('dev'), '0.1.0');
    assert.equal(clientVersion('unknown'), '0.1.0');
    assert.ok(isStaleBundle({ revision: 'bbb' }, 'aaa'));
    assert.ok(!isStaleBundle({ revision: 'aaa' }, 'aaa'));
    assert.ok(!isStaleBundle({ revision: 'unknown' }, 'aaa'), 'unidentified builds never nag');
    assert.ok(!isStaleBundle({ revision: 'bbb' }, 'dev'));
    assert.ok(!isStaleBundle(null, 'aaa'));
    assert.match(readFileSync(root('vite.config.ts'), 'utf8'), /fileName: 'build\.json'/);
    const main = source('main.tsx');
    assert.match(main, /fetchServedBuild\(\)\.then\(served => \{ if \(active\) setStaleBuild\(isStaleBundle\(served\)\); \}\)/);
    assert.match(main, /A newer UI Next build is being served/);
    assert.match(source('api.ts'), /CLIENT_VERSION = clientVersion\(\)/);
});

test('ENG-14 item payloads are normalized once at the API boundary', async () => {
    const { asItemResponse, asMediaItem } = await import('../src/api-contracts.ts');
    assert.deepEqual(asItemResponse(null), { Items: [] });
    assert.deepEqual(asItemResponse({ Items: 'nope', TotalRecordCount: 'many' }), { Items: [] });
    assert.deepEqual(asItemResponse({ Items: [ { Id: 'a' }, null, { Name: 'no id' }, { Id: '' } ], TotalRecordCount: 9.7, StartIndex: -1 }), { Items: [ { Id: 'a' } ], TotalRecordCount: 9 });
    assert.equal(asItemResponse({ Items: [ { Id: 'a' }, { Id: 'b' } ], TotalRecordCount: 1 }).TotalRecordCount, 2, 'a total never undercounts the page');
    assert.throws(() => asMediaItem({ Name: 'missing id' }), /unexpected format/);

    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    responses.push({ status: 200, body: '{"TotalRecordCount":3}' });
    const list = await api.getItems('parent');
    assert.deepEqual(list.Items, [], 'views always receive an array');
    responses.push({ status: 200, body: '{"Name":"no id"}' });
    await assert.rejects(api.getItem('item'), /unexpected format/);
    const source_ = source('api.ts');
    assert.doesNotMatch(source_, /<ItemResponse>\(/, 'every list request goes through the contract');
});

test('ENG-15 the dormant library editor and its creation-endpoint helpers are gone', () => {
    assert.ok(!existsSync(root('src/admin/pages/admin-libraries-edit.tsx')));
    assert.doesNotMatch(source('admin/admin-dashboard.tsx'), /admin-libraries-edit|LibraryEdit/);
    assert.doesNotMatch(source('admin/admin-api.ts'), /updateLibrary\w*\(|saveLibraryOptions/);
});
