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
const store = new Map();
beforeEach(() => { requests.length = 0; responses.length = 0; store.clear(); });
globalThis.window = { location: { href: 'https://jf.test/web/', origin: 'https://jf.test' }, setTimeout };
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

const query = await import('../src/library-query.ts');
const modes = await import('../src/library-modes.ts');
const catalog = await import('../src/catalog-model.ts');
const { recommendationTitle } = await import('../src/home-feed-blocks.ts');
const { JellyfinApi } = await import('../src/api.ts');
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');
const session = { server: 'https://jf.test', token: 'token', user: { Id: 'me', Name: 'Me' }, serverId: 's' };
const ok = body => ({ status: 200, body: JSON.stringify(body) });
const params = request => new URL(request.url).searchParams;
const library = type => ({ Id: 'lib', Name: 'Lib', Type: 'CollectionFolder', CollectionType: type });

test('PART-02/MISS-21: library types offer Jellyfin Web style modes', () => {
    const ids = type => modes.libraryModes(library(type)).map(mode => mode.id);
    assert.deepEqual(ids('tvshows'), [ 'shows', 'suggestions', 'upcoming', 'episodes' ]);
    assert.deepEqual(ids('movies'), [ 'movies', 'suggestions' ]);
    assert.deepEqual(ids('music'), [ 'albums', 'suggestions', 'albumartists', 'artists', 'songs' ]);
    assert.deepEqual(ids('books'), [ 'books', 'folders' ]);
    assert.deepEqual(ids('photos'), [ 'folders', 'photos', 'videos' ]);
    assert.deepEqual(ids('musicvideos'), [ 'videos', 'folders' ]);
    assert.deepEqual(ids(undefined), [ 'all' ]);
    assert.deepEqual(modes.libraryModes({ Id: 'b', Type: 'BoxSet' }).map(mode => mode.id), [ 'all' ]);

    const tv = modes.libraryModes(library('tvshows'));
    assert.deepEqual(modes.currentMode(tv, '').itemTypes, [ 'Series' ], 'the default keeps the existing Series listing');
    assert.equal(modes.currentMode(tv, 'upcoming').source, 'upcoming');
    assert.equal(modes.currentMode(tv, 'episodes').recursive, true);
    assert.equal(modes.currentMode(tv, 'nope').id, 'shows');
    const music = modes.libraryModes(library('music'));
    assert.equal(modes.currentMode(music, 'albumartists').source, 'albumArtists');
    assert.ok(music.every(mode => mode.square));
});

test('PART-04: card art follows the layout and falls back to available images', () => {
    assert.equal(modes.cardImageType({ ImageTags: { Primary: 'p', Thumb: 't' } }, 'thumb'), 'Thumb');
    assert.equal(modes.cardImageType({ ImageTags: { Primary: 'p' }, BackdropImageTags: [ 'b' ] }, 'thumb'), 'Backdrop');
    assert.equal(modes.cardImageType({ ImageTags: { Primary: 'p' } }, 'thumb'), 'Primary');
    assert.equal(modes.cardImageType({ ImageTags: { Banner: 'x', Thumb: 't' } }, 'banner'), 'Banner');
    assert.equal(modes.cardImageType({ ImageTags: { Thumb: 't' } }, 'poster'), 'Primary');
    const values = query.librarySortOptions.map(([ value ]) => value);
    for (const sort of [ 'Random:Ascending', 'DatePlayed:Descending', 'PlayCount:Descending', 'OfficialRating:Ascending', 'CommunityRating:Descending' ]) assert.ok(values.includes(sort), sort);
    const css = source('style.css');
    assert.match(css, /\.library-grid-items\.library-view-thumb \{ --library-poster-ratio: \.5625;/);
    assert.match(css, /\.library-grid-items\.library-view-banner \{ --library-poster-ratio: \.185;/);
    assert.match(css, /\.library-grid-items\.library-art-square \{ --library-poster-ratio: 1; \}/);
});

test('PART-03: favorites combine with watch state and multi-value filters map to server parameters', () => {
    const base = query.defaultLibraryQuery();
    let next = { ...base, WatchStatus: 'unplayed', Favorite: true, Genre: query.toggleValue(query.toggleValue('', 'Drama'), 'Comedy'), Decade: '1990|2000', Tags: 'cult', Ratings: 'PG|PG-13', SeriesStatus: 'Ended', Features: [ 'subtitles', 'special' ], Availability: 'missing' };
    const mapped = query.mapLibraryQuery(next, { Years: query.decadeYears(next.Decade) });
    assert.equal(mapped.Filters, 'IsUnplayed,IsFavorite');
    assert.equal(mapped.Genres, 'Drama|Comedy');
    assert.equal(mapped.Tags, 'cult');
    assert.equal(mapped.OfficialRatings, 'PG|PG-13');
    assert.equal(mapped.SeriesStatus, 'Ended');
    assert.equal(mapped.HasSubtitles, 'true');
    assert.equal(mapped.HasSpecialFeature, 'true');
    assert.equal(mapped.HasTrailer, undefined);
    assert.equal(mapped.IsMissing, 'true');
    assert.equal(mapped.Years.split(',').length, 20);
    assert.equal(query.activeFilterCount(next), 2 + 2 + 1 + 2 + 1 + 1 + 1 + 2 + 1);
    assert.equal(query.toggleValue('Drama|Comedy', 'Drama'), 'Comedy');
    assert.equal(query.decadeYears(''), undefined);
    assert.equal(query.libraryFilters({ ...base, WatchStatus: 'favorite' }), 'IsFavorite', 'restored bookmarks with the old Favorites watch status still filter');
    assert.equal(query.libraryFilters({ ...base, WatchStatus: 'played' }), 'IsPlayed');
    assert.equal(query.libraryFilters(base), undefined);

    const items = [ { Id: 'a', UserData: { Played: false, IsFavorite: true } } ];
    assert.equal(catalog.applyUserDataChange(items, 'a', { Played: false, IsFavorite: false }, 'unplayed', true).removed, 1, 'unfavoriting leaves a favorites-only list');
    assert.equal(catalog.applyUserDataChange(items, 'a', { Played: true, IsFavorite: true }, 'played', true).removed, 0);
    assert.equal(catalog.matchesWatchFilter({ UserData: { Played: false } }, 'played'), false);
});

test('MISS-21/PART-02: list endpoints follow the library mode', async () => {
    const api = new JellyfinApi(session);
    for (let index = 0; index < 4; index++) responses.push(ok({ Items: [], TotalRecordCount: 0 }));
    const q = query.defaultLibraryQuery();
    await api.getItems('lib', 0, undefined, undefined, true, 80, { Query: q, Source: 'upcoming' });
    await api.getItems('lib', 0, undefined, undefined, true, 80, { Query: q, Source: 'albumArtists' });
    await api.getItems('lib', 0, undefined, undefined, true, 80, { Query: q, Source: 'artists' });
    await api.getItems('lib', 0, undefined, [ 'Episode' ], true, 80, { Query: { ...q, Availability: 'unaired' } });
    assert.deepEqual(requests.map(request => new URL(request.url).pathname), [ '/Shows/Upcoming', '/Artists/AlbumArtists', '/Artists', '/Items' ]);
    assert.ok(requests.every(request => params(request).get('ParentId') === 'lib'));
    assert.equal(params(requests[3]).get('IncludeItemTypes'), 'Episode');
    assert.equal(params(requests[3]).get('IsUnaired'), 'true');
});

test('PART-03/MISS-22: filter facets and library-local suggestions use the documented endpoints', async () => {
    const api = new JellyfinApi(session);
    responses.push(ok({ Tags: [ 'cult', '', 'cult', 'anime' ], OfficialRatings: [ 'PG-13', 'G' ] }));
    assert.deepEqual(await api.getLibraryFilters('lib', [ 'Movie' ]), { tags: [ 'anime', 'cult' ], ratings: [ 'G', 'PG-13' ] });
    assert.equal(new URL(requests[0].url).pathname, '/Items/Filters');
    assert.equal(params(requests[0]).get('IncludeItemTypes'), 'Movie');

    requests.length = 0;
    responses.push(ok({ Items: [ { Id: 'r', Name: 'Resume' } ] }), ok([ { Id: 'l', Name: 'Latest' } ]), ok([ { RecommendationType: 0, BaselineItemName: 'Heat', Items: [ { Id: 'x', Name: 'Ronin' } ] } ]));
    const rows = await api.getLibrarySuggestions(library('movies'));
    assert.deepEqual(rows.map(row => row.title), [ 'Continue watching', 'Latest', 'Because you watched Heat' ]);
    assert.deepEqual(requests.map(request => new URL(request.url).pathname).sort(), [ '/Items/Latest', '/Movies/Recommendations', '/UserItems/Resume' ]);
    assert.ok(requests.every(request => params(request).get('ParentId') === 'lib'));

    requests.length = 0;
    responses.push(ok({ Items: [] }), ok({ Items: [ { Id: 'n', Name: 'Next' } ] }), { status: 500, body: '' });
    const tvRows = await api.getLibrarySuggestions(library('tvshows'));
    assert.deepEqual(tvRows.map(row => row.title), [ 'Next up' ], 'a failing row is skipped instead of failing the tab');
    assert.ok(requests.some(request => new URL(request.url).pathname === '/Shows/NextUp'));
    assert.equal(recommendationTitle({ RecommendationType: 3, BaselineItemName: 'Pacino' }), 'Starring Pacino');
});

test('library page wires modes, scoped title search, chips and suggestions', () => {
    const page = source('library.tsx');
    assert.match(page, /class="library-mode-tabs"/);
    assert.match(page, /aria-label=\{`Search \$\{library\.Name\}`\}/);
    assert.match(page, /reset\(\{ \.\.\.query, Title: titleDraft \}\), 350/);
    assert.match(page, /chips\('Genres', 'Genre'/);
    assert.match(page, /chips\('Tags', 'Tags'/);
    assert.match(page, /<LibrarySuggestions api=\{api\}/);
    assert.match(page, /Source: source/);
    assert.match(page, /\[ 'thumb', 'Thumb' \], \[ 'banner', 'Banner' \]/);
});
