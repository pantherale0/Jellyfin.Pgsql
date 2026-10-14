import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requests = [];
const responses = [];
const store = new Map();
const events = [];
beforeEach(() => { requests.length = 0; responses.length = 0; store.clear(); events.length = 0; });
globalThis.window = { location: { href: 'https://jf.test/web/', origin: 'https://jf.test' }, setTimeout, dispatchEvent: event => { events.push(event.type); return true; } };
globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    constructor() { this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    abort() { this.onabort?.(); }
    send(body) {
        requests.push({ method: this.method, url: this.url, headers: this.headers, body });
        const response = responses.shift() || { status: 204, body: '' };
        queueMicrotask(() => { this.status = response.status; this.responseText = response.body; this.onload(); });
    }
};

const discovery = await import('../src/discovery.ts');
const { buildHomeFeedBlocks } = await import('../src/home-feed-blocks.ts');
const { linkedMetadata } = await import('../src/detail-model.ts');
const { routeFor, routeFromState } = await import('../src/app-routes.ts');
const { JellyfinApi } = await import('../src/api.ts');
const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const session = { server: 'https://jf.test', token: 'token', user: { Id: 'me', Name: 'Me' }, serverId: 's' };
const ok = body => ({ status: 200, body: JSON.stringify(body) });
const params = request => new URL(request.url).searchParams;
const movie = id => ({ Id: id, Name: id, Type: 'Movie' });

test('PART-01: home sections can be reordered, hidden and restored per user', () => {
    const defaults = discovery.defaultHomePreferences();
    assert.deepEqual(defaults.hidden, [ 'latest-libraries' ], 'per-library Latest starts hidden so Just added is not duplicated');
    assert.equal(defaults.order[0], 'continue');
    const moved = discovery.moveSection(defaults.order, 'explore', -1);
    assert.equal(moved.indexOf('explore'), defaults.order.indexOf('explore') - 1);
    assert.equal(discovery.moveSection(defaults.order, 'continue', -1), defaults.order);

    const normalized = discovery.normalizeHomePreferences({ order: [ 'latest', 'bogus', 'latest' ], hidden: [ 'on-now', 'nope' ], excludedLatest: [ 'lib', 5 ] });
    assert.equal(normalized.order[0], 'latest');
    assert.equal(normalized.order.length, discovery.HOME_SECTIONS.length, 'unknown sections are dropped and missing ones appended');
    assert.deepEqual(normalized.hidden, [ 'on-now' ]);
    assert.deepEqual(normalized.excludedLatest, [ 'lib' ]);

    discovery.saveHomePreferences('me', { ...defaults, hidden: [] });
    assert.deepEqual(discovery.loadHomePreferences('me').hidden, []);
    assert.deepEqual(discovery.loadHomePreferences('other').hidden, [ 'latest-libraries' ], 'preferences are per user');
    assert.deepEqual(events, [ 'ui-next-home-sections' ]);
    store.set('ui-next-home-sections:me', '{broken');
    assert.deepEqual(discovery.loadHomePreferences('me'), defaults);
});

test('PART-01: the feed adds listening, reading, For You and per-library Latest rails in preference order', () => {
    const library = { Id: 'lib', Name: 'Films', Type: 'CollectionFolder', CollectionType: 'movies' };
    const extras = {
        audioResume: [ { Id: 'song', Name: 'Song', Type: 'Audio' } ],
        bookResume: [ { Id: 'book', Name: 'Book', Type: 'Book' } ],
        forYouMovies: [ { ...movie('fy'), TasteTier: 'high' } ],
        latestByLibrary: [ { library, items: [ movie('new') ] } ],
    };
    const ids = blocks => blocks.filter(block => block.kind === 'rail').map(block => block.id);
    const defaults = buildHomeFeedBlocks([ movie('r') ], [ movie('l') ], [], [], [], [], [], [], extras);
    assert.deepEqual(ids(defaults), [ 'continue', 'continue-listening', 'continue-reading', 'for-you-movies', 'latest' ]);

    const preferences = { order: [ 'latest-libraries', ...discovery.defaultHomePreferences().order.filter(id => id !== 'latest-libraries') ], hidden: [ 'latest', 'continue-reading' ], excludedLatest: [] };
    const custom = buildHomeFeedBlocks([ movie('r') ], [ movie('l') ], [], [], [], [], [], [], { ...extras, preferences });
    assert.deepEqual(ids(custom), [ 'latest-library-lib', 'continue', 'continue-listening', 'for-you-movies' ]);
    assert.equal(custom[0].title, 'Latest in Films');

    assert.deepEqual(ids(buildHomeFeedBlocks([ movie('r') ], [ movie('l') ], [], [], [], [], [], [])), [ 'continue', 'latest' ], 'without extras the feed is unchanged');
    assert.equal(discovery.tasteTierLabel('high'), 'Strong match');
    assert.equal(discovery.tasteTierLabel('mid'), 'Good match');
    assert.equal(discovery.tasteTierLabel(undefined), '');
    assert.deepEqual(discovery.latestLibraries([ library, { Id: 'tv', Name: 'Live', CollectionType: 'livetv' }, { Id: 'x', Name: 'X', CollectionType: 'tvshows' } ], [ 'x' ]).map(view => view.Id), [ 'lib' ]);
    assert.match(source('home-feed.tsx'), /class=\{`home-feed-tier tier-\$\{item\.TasteTier\}`\}/);
});

test('PART-01: resume rows are split by media type and For You keeps the server tier', async () => {
    const api = new JellyfinApi(session);
    responses.push(ok({ Items: [] }), ok({ Items: [] }), ok({ Items: [] }));
    await api.getResumeItems();
    await api.getResumeItems('Audio');
    await api.getResumeItems('Book');
    assert.deepEqual(requests.map(request => params(request).get('MediaTypes')), [ 'Video', 'Audio', 'Book' ]);

    requests.length = 0;
    responses.push(ok({ Items: [ { ItemId: 'a', Tier: 'high' }, { ItemId: 'b', Tier: 'mid' } ] }), ok({ Items: [ movie('b'), movie('a') ] }));
    const forYou = await api.getForYouRecommendations('Movie');
    assert.deepEqual(forYou.map(item => [ item.Id, item.TasteTier ]), [ [ 'a', 'high' ], [ 'b', 'mid' ] ]);

    requests.length = 0;
    responses.push(ok([ movie('n') ]));
    assert.equal((await api.getLatestInLibrary('lib'))[0].Id, 'n');
    assert.equal(new URL(requests[0].url).pathname, '/Items/Latest');
    assert.equal(params(requests[0]).get('ParentId'), 'lib');
});

test('MISS-20: the Favorites page groups favorites across libraries and has its own route', async () => {
    const api = new JellyfinApi(session);
    responses.push(ok({ Items: [ movie('m') ], TotalRecordCount: 30 }), ok({ Items: [ { Id: 'p', Name: 'Actor' } ], TotalRecordCount: 1 }));
    const movies = await api.getFavorites(discovery.FAVORITE_GROUPS.find(group => group.id === 'movies'));
    const people = await api.getFavorites(discovery.FAVORITE_GROUPS.find(group => group.id === 'people'));
    assert.deepEqual(movies, { items: [ movie('m') ], total: 30 });
    assert.equal(people.items[0].Type, 'Person', 'entity responses get a type so they open entity pages');
    assert.equal(new URL(requests[0].url).pathname, '/Items');
    assert.equal(params(requests[0]).get('Filters'), 'IsFavorite');
    assert.equal(params(requests[0]).get('IncludeItemTypes'), 'Movie');
    assert.equal(params(requests[0]).get('Recursive'), 'true');
    assert.equal(new URL(requests[1].url).pathname, '/Persons');
    assert.equal(params(requests[1]).get('IsFavorite'), 'true');
    assert.ok(discovery.FAVORITE_GROUPS.length >= 10);

    assert.deepEqual(routeFor({ view: 'favorites' }), { view: 'favorites' });
    assert.deepEqual(routeFromState({ uiNext: { view: 'favorites' } }), { view: 'favorites' });
    const main = source('main.tsx');
    assert.match(main, /case 'favorites': openFavorites\(\); return;/);
    assert.match(main, /<FavoritesPage api=\{api\}/);
    assert.match(main, /onClick=\{openFavorites\}>Favorites<\/button>/);
    assert.match(main, /case 'favorites': return 'Back to favorites';/);
});

test('MISS-23: search adds typed people, artist, genre and studio sections', async () => {
    const api = new JellyfinApi(session);
    for (let index = 0; index < discovery.ENTITY_SEARCH_SECTIONS.length; index++) responses.push(ok({ Items: [ { Id: `e${index}`, Name: 'Match' } ] }));
    const results = [];
    for (const section of discovery.ENTITY_SEARCH_SECTIONS) results.push(await api.searchEntities(section, 'ma'));
    assert.deepEqual(requests.map(request => new URL(request.url).pathname), [ '/Persons', '/Artists', '/Genres', '/MusicGenres', '/Studios' ]);
    assert.ok(requests.every(request => params(request).get('SearchTerm') === 'ma'));
    assert.deepEqual(results.map(items => items[0].Type), [ 'Person', 'MusicArtist', 'Genre', 'MusicGenre', 'Studio' ]);
    assert.deepEqual(discovery.withEntityType([ { Id: 'x', Name: 'X', Type: 'MusicArtist' }, { Id: '', Name: 'drop' } ], '/Persons'), [ { Id: 'x', Name: 'X', Type: 'MusicArtist' } ]);

    const main = source('main.tsx');
    assert.match(main, /<EntitySearchRows api=\{api\} term=\{search\} onSelect=\{selectItem\} \/>/);
    assert.match(main, /<EntitySearchRows api=\{api\} term=\{draft\} onSelect=\{onSelect\} \/>/);
});

test('MISS-14: music libraries get suggestion rows and songs link to their album and artists', async () => {
    const api = new JellyfinApi(session);
    responses.push(ok([ { Id: 'al', Name: 'Album', Type: 'MusicAlbum' } ]), ok({ Items: [ { Id: 's1', Name: 'Song', Type: 'Audio' } ] }), ok({ Items: [] }), ok({ Items: [] }));
    const rows = await api.getLibrarySuggestions({ Id: 'music', CollectionType: 'music' });
    assert.deepEqual(rows.map(row => row.title), [ 'Latest albums', 'Recently played' ]);
    const sorts = requests.filter(request => new URL(request.url).pathname === '/Items').map(request => params(request).get('SortBy'));
    assert.deepEqual(sorts, [ 'DatePlayed', 'PlayCount', 'Random' ]);

    const linked = linkedMetadata({ Id: 's', Name: 'Song', Type: 'Audio', Album: 'Album', AlbumId: 'al', ArtistItems: [ { Id: 'ar', Name: 'Artist' } ] });
    assert.deepEqual(linked.albums, [ { Id: 'al', Name: 'Album', Type: 'MusicAlbum' } ]);
    assert.deepEqual(linked.artists, [ { Id: 'ar', Name: 'Artist', Type: 'MusicArtist' } ]);
    assert.deepEqual(linkedMetadata({ Id: 'al', Name: 'Album', Type: 'MusicAlbum', Album: 'Album', AlbumId: 'al' }).albums, []);
    assert.match(source('detail-sections.tsx'), /chips\('Album', linked\.albums\)/);
    assert.match(source('library-modes.ts'), /id: 'suggestions', label: 'Suggestions', suggestions: true, square: true/);
});

test('PART-01: the profile menu opens the Home screen editor', () => {
    assert.match(source('main.tsx'), /openProfileScreen\('home'\)\}>Home screen<\/button>/);
    const profile = source('profile.tsx');
    assert.match(profile, /screen === 'home' && <HomeSectionsEditor api=\{api\} userId=\{session\.user\.Id\} \/>/);
    assert.match(source('discovery-views.tsx'), /saveHomePreferences\(userId, next\)/);
});
