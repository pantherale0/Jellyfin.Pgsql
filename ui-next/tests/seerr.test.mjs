import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const storage = new Map();
beforeEach(() => { requests.length = 0; responses.length = 0; storage.clear(); });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    constructor() { this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
        requests.push({ method: this.method, url: this.url, headers: this.headers, body });
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const main = readSource(new URL('../src/main.tsx', import.meta.url), 'utf8');
const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'User' }, serverId: 'server-id' };
const item = (overrides = {}) => ({ mediaType: 'movie', mediaId: 1, title: 'Film', status: 0, canRequest: true, ...overrides });

test('Seerr items are validated, deduplicated and posters limited to TMDB', async () => {
    const { asSeerrItems } = await import('../src/seerr.ts');
    const parsed = asSeerrItems({ items: [
        { mediaType: 'movie', mediaId: 10, title: ' Arrival ', year: 2016, overview: 'Aliens', posterUrl: 'https://image.tmdb.org/t/p/w185/a.jpg', status: 0, canRequest: true },
        { mediaType: 'movie', mediaId: 10, title: 'Duplicate', status: 0, canRequest: true },
        { mediaType: 'tv', mediaId: 11, title: 'Show', posterUrl: 'https://evil.example/x.jpg', status: 1, canRequest: false },
        { mediaType: 'tv', mediaId: 12, title: 'Insecure poster', posterUrl: 'http://image.tmdb.org/x.jpg', year: 99999 },
        { mediaType: 'book', mediaId: 13, title: 'Wrong type' },
        { mediaType: 'movie', mediaId: -1, title: 'Bad id' },
        { mediaType: 'movie', mediaId: 1.5, title: 'Fractional id' },
        { mediaType: 'movie', mediaId: 14, title: '' },
        { mediaType: 'movie', mediaId: 15, title: 'x'.repeat(1000), overview: 'y'.repeat(5000) },
        'junk', null
    ] });
    assert.deepEqual(parsed.map(entry => entry.mediaId), [ 10, 11, 12, 15 ]);
    assert.deepEqual(parsed[0], { mediaType: 'movie', mediaId: 10, title: 'Arrival', year: 2016, overview: 'Aliens', posterUrl: 'https://image.tmdb.org/t/p/w185/a.jpg', status: 0, canRequest: true });
    assert.equal(parsed[1].posterUrl, undefined);
    assert.equal(parsed[2].posterUrl, undefined);
    assert.equal(parsed[2].year, undefined);
    assert.equal(parsed[2].canRequest, false);
    assert.ok(parsed[3].title.length <= 300 && parsed[3].overview.length <= 2000);
    assert.deepEqual(asSeerrItems({ Items: [] }), []);
    assert.deepEqual(asSeerrItems(null), []);
});

test('search keeps requestable and in-progress titles; discovery keeps requestable only', async () => {
    const { searchVisible, discoverVisible, seerrStatusLabel, SeerrStatus, markRequested } = await import('../src/seerr.ts');
    const items = [
        item({ mediaId: 1, status: SeerrStatus.Unknown, canRequest: true }),
        item({ mediaId: 2, status: SeerrStatus.Pending, canRequest: false }),
        item({ mediaId: 3, status: SeerrStatus.Processing, canRequest: false }),
        item({ mediaId: 4, status: SeerrStatus.PartiallyAvailable, canRequest: true }),
        item({ mediaId: 5, status: SeerrStatus.Available, canRequest: false }),
        item({ mediaId: 6, status: SeerrStatus.Blocklisted, canRequest: false }),
        item({ mediaId: 7, status: SeerrStatus.Deleted, canRequest: false })
    ];
    assert.deepEqual(searchVisible(items).map(entry => entry.mediaId), [ 1, 2, 3, 4 ]);
    assert.deepEqual(discoverVisible(items).map(entry => entry.mediaId), [ 1, 4 ]);
    assert.equal(seerrStatusLabel({ status: SeerrStatus.Pending }), 'Requested');
    assert.equal(seerrStatusLabel({ status: SeerrStatus.Processing }), 'Processing');
    assert.equal(seerrStatusLabel({ status: SeerrStatus.PartiallyAvailable }), 'Partially available');
    assert.equal(seerrStatusLabel({ status: SeerrStatus.Unknown }), null);
    const requested = markRequested(items[0]);
    assert.equal(requested.status, SeerrStatus.Pending);
    assert.equal(requested.canRequest, false);
    assert.equal(seerrStatusLabel(requested), 'Requested');
});

test('taste genres map to at most five TMDB ids, heaviest first', async () => {
    const { mapGenreLabelsToTmdbIds, seerrPersonalization } = await import('../src/seerr.ts');
    assert.deepEqual(mapGenreLabelsToTmdbIds([ 'Sci-Fi', 'Science Fiction', 'Action & Adventure', 'Drama', 'Unknown', 'Comedy', 'Horror', 'War' ]), [ 878, 10759, 18, 35, 27 ]);
    assert.deepEqual(seerrPersonalization(null), { genreIds: [] });
    assert.deepEqual(seerrPersonalization({ HasProfile: false, Genres: [ { Label: 'Drama', Weight: 1 } ] }), { genreIds: [] });
    assert.deepEqual(seerrPersonalization({
        HasProfile: true,
        Genres: [ { Label: 'Comedy', Weight: 0.2 }, { Label: 'Drama', Weight: 0.9 }, { Weight: 1 }, { Label: 'Thriller', Weight: 0.5 } ],
        RatingP25: 6.4
    }), { genreIds: [ 18, 53, 35 ], voteAverageGte: 6.4 });
    assert.equal(seerrPersonalization({ HasProfile: true, Genres: [], RatingP25: 14 }).voteAverageGte, 10);
    assert.equal(seerrPersonalization({ HasProfile: true, Genres: [], RatingP25: 0 }).voteAverageGte, undefined);
    assert.equal(seerrPersonalization({ HasProfile: true, Genres: [], RatingP25: null }).voteAverageGte, undefined);
});

test('request failures use fixed wording by status, never the server text', async () => {
    const { requestErrorMessage } = await import('../src/seerr.ts');
    const { JellyfinRequestError } = await import('../src/api.ts');
    assert.match(requestErrorMessage(new JellyfinRequestError(403, '<b>server says</b>')), /parental controls/);
    assert.match(requestErrorMessage(new JellyfinRequestError(409, 'x')), /already been requested/);
    assert.match(requestErrorMessage(new JellyfinRequestError(429, 'x')), /Too many requests/);
    assert.match(requestErrorMessage(new JellyfinRequestError(503, 'x')), /unavailable/);
    const generic = requestErrorMessage(new JellyfinRequestError(502, 'Upstream exploded: secret'));
    assert.equal(generic, 'The request could not be sent. Try again.');
    assert.equal(requestErrorMessage(new Error('boom')), generic);
});

test('Seerr API helpers call the plugin routes with the CamelCase profile', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    const camel = 'application/json; profile="CamelCase"';

    responses.push({ status: 200, body: JSON.stringify({ enabled: true }) });
    assert.equal(await api.getSeerrStatus(), true);
    assert.equal(requests[0].url, 'https://jellyfin.example.test/Seerr/Status');
    assert.equal(requests[0].headers.Accept, camel);
    responses.push({ status: 200, body: JSON.stringify({ Items: [] }) });
    assert.equal(await api.getSeerrStatus(), false);

    responses.push({ status: 200, body: JSON.stringify({ items: [ item({ mediaId: 5 }) ] }) });
    assert.deepEqual((await api.searchSeerr('  dune  ')).map(entry => entry.mediaId), [ 5 ]);
    const search = new URL(requests[2].url);
    assert.equal(search.pathname, '/Seerr/Search');
    assert.equal(search.searchParams.get('query'), 'dune');

    responses.push({ status: 200, body: JSON.stringify({ items: [] }) });
    await api.discoverSeerr({ mediaType: 'tv', genreIds: [ 18, 35, 53, 27, 28, 99 ], voteAverageGte: 6.5, limit: 99 });
    const discover = new URL(requests[3].url);
    assert.equal(discover.pathname, '/Seerr/Discover');
    assert.equal(discover.searchParams.get('mediaType'), 'tv');
    assert.equal(discover.searchParams.get('genreIds'), '18,35,53,27,28');
    assert.equal(discover.searchParams.get('voteAverageGte'), '6.5');
    assert.equal(discover.searchParams.get('limit'), '24');
    assert.equal(requests[3].headers.Accept, camel);

    responses.push({ status: 200, body: JSON.stringify({ items: [] }) });
    await api.discoverSeerr({ mediaType: 'movie' });
    const plain = new URL(requests[4].url);
    assert.equal(plain.searchParams.has('genreIds'), false);
    assert.equal(plain.searchParams.has('voteAverageGte'), false);
    assert.equal(plain.searchParams.get('limit'), '16');

    responses.push({ status: 200, body: JSON.stringify({ requestId: 7, message: 'Requested' }) });
    await api.requestSeerr('movie', 42);
    assert.equal(requests[5].method, 'POST');
    assert.equal(requests[5].url, 'https://jellyfin.example.test/Seerr/Request');
    assert.deepEqual(JSON.parse(requests[5].body), { mediaType: 'movie', mediaId: 42 });
    assert.equal(requests[5].headers.Accept, camel);

    responses.push({ status: 409, body: JSON.stringify({ message: 'dup' }) });
    await assert.rejects(api.requestSeerr('movie', 42), error => error.status === 409);
});

test('a saved home layout gains Beyond your library before the endless Explore rows', async () => {
    const { normalizeHomePreferences, defaultHomePreferences, sectionOfRail } = await import('../src/discovery.ts');
    const defaults = defaultHomePreferences().order;
    assert.equal(defaults.indexOf('beyond'), defaults.indexOf('explore') - 1);
    const old = defaults.filter(id => id !== 'beyond');
    const moved = [ 'explore', ...old.filter(id => id !== 'explore') ];
    assert.deepEqual(normalizeHomePreferences({ order: old, hidden: [] }).order, defaults);
    const restored = normalizeHomePreferences({ order: moved, hidden: [] }).order;
    assert.equal(restored.indexOf('beyond'), restored.indexOf('explore') - 1, 'inserted before its successor wherever the user moved it');
    assert.equal(sectionOfRail('beyond-movies'), 'beyond');
    assert.equal(sectionOfRail('beyond-shows'), 'beyond');
});

test('Beyond rails are request blocks ordered and hidden like other sections', async () => {
    const { buildHomeFeedBlocks } = await import('../src/home-feed-blocks.ts');
    const { defaultHomePreferences } = await import('../src/discovery.ts');
    const media = id => ({ Id: id, Name: id, Type: 'Movie' });
    const extras = { beyondMovies: [ item({ mediaId: 1 }) ], beyondShows: [ item({ mediaType: 'tv', mediaId: 2 }) ] };
    const blocks = buildHomeFeedBlocks([ media('resume') ], [ media('latest') ], [], [], [], [], [ media('explore') ], [], { ...extras, preferences: defaultHomePreferences() });
    const rails = blocks.filter(block => block.kind !== 'spotlight').map(block => block.id);
    assert.ok(rails.indexOf('beyond-movies') > rails.indexOf('latest'));
    assert.equal(rails.indexOf('beyond-shows'), rails.indexOf('beyond-movies') + 1);
    assert.equal(rails.indexOf('explore-fallback'), rails.indexOf('beyond-shows') + 1);
    const movies = blocks.find(block => block.id === 'beyond-movies');
    assert.equal(movies.kind, 'requests');
    assert.deepEqual(movies.items, []);
    assert.equal(movies.requests[0].mediaId, 1);
    const hidden = buildHomeFeedBlocks([ media('resume') ], [], [], [], [], [], [], [], { ...extras, preferences: { ...defaultHomePreferences(), hidden: [ 'beyond' ] } });
    assert.ok(!hidden.some(block => block.id.startsWith('beyond-')));
    const none = buildHomeFeedBlocks([ media('resume') ], [], [], [], [], [], [], [], { preferences: defaultHomePreferences() });
    assert.ok(!none.some(block => block.id.startsWith('beyond-')));
});

test('main loads Seerr behind the account owner and never blocks library results', () => {
    const load = main.slice(main.indexOf('const loadHome = useCallback('), main.indexOf('}, [ api ]);', main.indexOf('const loadHome = useCallback(')));
    assert.match(load, /api\.getSeerrStatus\(\)\.then\(async enabled => \{\s*if \(!isLoadCurrent\(\)\) return;/);
    assert.match(load, /seerrPersonalization\(await tasteProfilePromise\);/, 'the shared taste profile promise also feeds Seerr personalization');
    assert.match(load, /saveExtra\('beyondMovies'\)\(discoverVisible\(items\)\)\)\.catch\(\(\) => undefined\)/);
    assert.match(load, /saveExtra\('beyondShows'\)\(discoverVisible\(items\)\)\)\.catch\(\(\) => undefined\)/);
    assert.doesNotMatch(load.slice(load.indexOf('getSeerrStatus'), load.indexOf("getResumeItems('Audio')")), /noteDiscoveryFailure/);

    const search = main.slice(main.indexOf('const startSeerrSearch ='), main.indexOf('const runSearch ='));
    assert.match(search, /owner === seerrSearchReq\.current && accountGeneration\.isCurrent\(account\)\) setSeerrSearch\(\{ items: searchVisible\(items\)/);
    assert.match(search, /\.catch\(\(\) => \{\s*if \(owner === seerrSearchReq\.current && accountGeneration\.isCurrent\(account\)\)/);
    assert.match(main, /searchParams\.current = \{ term \};\s*startSeerrSearch\(term\);/);
    assert.match(main, /startSeerrSearch\(genreIds \? '' : term\);/);
    assert.match(main, /const cancelSearch = \(\) => \{\s*searchReq\.current\+\+;\s*seerrSearchReq\.current\+\+;/);

    assert.match(main, /!loading && !seerrSearch\.loading && !seerrSearch\.items\.length && <EmptyState title="No matches found"/);
    assert.match(main, /!loading && !seerrPending && <EmptyState title="No matches found"/);
    assert.match(main, /onRequested=\{seerrRequestedFor\(accountGeneration\.current\(\)\)\}/);
    assert.match(main, /const seerrRequestedFor = \(account: number\) => \(item: SeerrItem\) => \{\s*if \(accountGeneration\.isCurrent\(account\)\)/);
    const signOut = main.slice(main.indexOf('const clearSignedInState ='), main.indexOf('setViews([]);', main.indexOf('const clearSignedInState =')));
    assert.match(signOut, /setSeerrRequested\(\{\}\);\s*setSeerrSheet\(null\);/);
});
