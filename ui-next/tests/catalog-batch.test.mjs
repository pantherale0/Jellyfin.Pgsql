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
beforeEach(() => { requests.length = 0; responses.length = 0; store.clear(); });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/', origin: 'https://jellyfin.example.test' }, setTimeout };
globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send(body) {
        requests.push({ method: this.method, url: this.url, body: body ? JSON.parse(body) : undefined });
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'Viewer' }, serverId: 'server-id' };
const source = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const model = () => import('../src/catalog-model.ts');
const page = (from, count) => Array.from({ length: count }, (_, index) => ({ Id: `item-${from + index}`, Name: `Item ${from + index}` }));

test('CAT-01 search pages report a true total and append without duplicates', async () => {
    const { searchSummary, hasMoreResults, appendPage, SEARCH_PAGE_SIZE } = await model();
    assert.equal(SEARCH_PAGE_SIZE, 40);
    assert.equal(searchSummary(40, 312), 'Showing 40 of 312 titles');
    assert.equal(searchSummary(3, 3), '3 titles');
    assert.equal(searchSummary(1, 1), '1 title');
    assert.equal(searchSummary(0, 0), 'No titles');
    assert.ok(hasMoreResults(40, 312));
    assert.ok(!hasMoreResults(312, 312));
    const merged = appendPage(page(0, 40), page(38, 40));
    assert.equal(merged.length, 78, 'overlapping pages must not duplicate cards');
    const main = source('main.tsx');
    assert.match(main, /searchSummary\(items\.length, searchTotal\)/, 'desktop search shows loaded vs total');
    assert.match(main, /Load more results/, 'search has an explicit accessible continuation');
    assert.match(main, /api\.getItems\('', items\.length, term, undefined, true, SEARCH_PAGE_SIZE, undefined, 1, genreIds\)/, 'load more reuses the active search parameters');
    assert.match(main, /total=\{searchTotal\} loadingMore=\{searchLoadingMore\}/, 'TV search receives totals and paging');
});

test('CAT-02 library bookmarks keep query, view, page and scroll per library', async () => {
    const { saveLibraryBookmark, peekLibraryBookmark, clearLibraryBookmark } = await model();
    saveLibraryBookmark('lib-a', { query: { SortBy: 'DateCreated', Genre: 'Drama' }, view: 'list', sortControl: 'added', startIndex: 120, scrollY: 2400 });
    saveLibraryBookmark('lib-b', { query: {}, view: 'poster', sortControl: 'name', startIndex: -5, scrollY: -10 });
    assert.deepEqual(peekLibraryBookmark('lib-a').query, { SortBy: 'DateCreated', Genre: 'Drama' });
    assert.equal(peekLibraryBookmark('lib-a').startIndex, 120);
    assert.equal(peekLibraryBookmark('lib-b').startIndex, 0, 'negative offsets are clamped');
    assert.equal(peekLibraryBookmark('lib-b').scrollY, 0);
    clearLibraryBookmark('lib-a');
    assert.equal(peekLibraryBookmark('lib-a'), null);
    assert.ok(peekLibraryBookmark('lib-b'));
    clearLibraryBookmark();
    assert.equal(peekLibraryBookmark('lib-b'), null);
    const library = source('library.tsx');
    assert.match(library, /peekLibraryBookmark\(library\.Id\)/, 'LibraryPage initialises from its bookmark');
    assert.match(library, /saveLibraryBookmark\(library\.Id/, 'LibraryPage saves its bookmark on leave');
    const main = source('main.tsx');
    assert.match(main, /if \(origin\.kind === 'library'\) setLibraryRestore\(true\)/, 'returning from details restores the library');
    assert.match(main, /restore=\{libraryRestore\}/);
});

test('CAT-03 series Back returns to the view that opened the series', () => {
    const main = source('main.tsx');
    assert.doesNotMatch(main, /searchReturn/, 'the search-only return flag is replaced by a typed origin');
    assert.match(main, /seriesOrigin\.current = origin \|\| \(view === 'details' \? detailOrigin\.current : null\) \|\| contentOrigin\(\)/);
    assert.match(main, /onBack=\{leaveSeries\}/);
    assert.match(main, /backLabel=\{originLabel\(seriesOrigin\.current/);
    const openSeries = main.slice(main.indexOf('const openSeries = async'), main.indexOf("rememberShowQuery(series.Id, requestedSeason);"));
    assert.doesNotMatch(openSeries, /setItems\(\[\]\)/, 'opening a series must not wipe search results it may return to');
});

test('CAT-04 leaving search cancels in-flight work through one helper', () => {
    const main = source('main.tsx');
    const helper = main.slice(main.indexOf('const cancelSearch = () => {'), main.indexOf('const goHome = () => {'));
    assert.match(helper, /searchReq\.current\+\+/);
    assert.match(helper, /if \(searchInFlight\.current\) \{[\s\S]*setLoading\(false\)/, 'a cancelled search releases the global loading state');
    for (const fn of [ 'const goHome = () => {', 'const openLive = (', 'const resetAndLoadLibrary = async (' ]) {
        const start = main.indexOf(fn);
        assert.match(main.slice(start, start + 400), /cancelSearch\(\)/, `${fn} cancels search`);
    }
});

test('CAT-05 TV genre suggestions query by genre id', () => {
    const main = source('main.tsx');
    assert.match(main, /const genreIds = searchGenre\?\.Id \? \[ searchGenre\.Id \] : undefined;/);
    assert.match(main, /SEARCH_PAGE_SIZE, undefined, 1, genreIds\)\.then/);
});

test('CAT-06 folders list direct children and keep an ancestry trail', async () => {
    const { listsDirectChildren, isContainer, pushTrail, popTrail } = await model();
    assert.ok(listsDirectChildren({ Type: 'Folder' }));
    assert.ok(listsDirectChildren({ Type: 'BoxSet' }));
    assert.ok(listsDirectChildren({ Type: 'CollectionFolder' }), 'a mixed folder library without a type browses folders');
    assert.ok(!listsDirectChildren({ Type: 'CollectionFolder', CollectionType: 'movies' }));
    assert.ok(isContainer({ Type: 'Playlist' }));
    assert.ok(!isContainer({ Type: 'Movie' }));
    const root = { Id: 'root', Name: 'Home videos' };
    const child = { Id: 'child', Name: '2024' };
    const grandchild = { Id: 'grand', Name: 'Summer' };
    let trail = pushTrail([], root, child);
    trail = pushTrail(trail, child, grandchild);
    assert.deepEqual(trail.map(entry => entry.Id), [ 'root', 'child' ]);
    assert.deepEqual(pushTrail(trail, grandchild, root).map(entry => entry.Id), [], 'jumping to an ancestor trims the trail');
    const up = popTrail(trail);
    assert.equal(up.parent.Id, 'child');
    assert.deepEqual(up.trail.map(entry => entry.Id), [ 'root' ]);
    assert.equal(popTrail([]).parent, null);
    assert.match(source('library.tsx'), /const recursive = mode\.recursive \?\? \(!isTvLibrary && !listsDirectChildren\(library\)\)/);
    assert.match(source('main.tsx'), /await openLibrary\(item, \{ child: view === 'library' \}\)/);
});

test('CAT-07 favorite/played changes use returned user data and reconcile filtered lists', async () => {
    const { mergeUserData, applyUserDataChange, playedUserData } = await model();
    const items = [ { Id: 'a', UserData: { IsFavorite: true, Played: false } }, { Id: 'b', UserData: { IsFavorite: true } } ];
    assert.equal(mergeUserData(items, 'missing', { IsFavorite: false }), items, 'unchanged lists keep identity');
    const merged = mergeUserData(items, 'a', { IsFavorite: false });
    assert.equal(merged[0].UserData.IsFavorite, false);
    assert.equal(merged[0].UserData.Played, false, 'merge keeps untouched fields');
    const change = applyUserDataChange(items, 'a', { IsFavorite: false }, 'favorite');
    assert.equal(change.removed, 1, 'unfavoriting under the Favorites filter removes the row');
    assert.deepEqual(change.items.map(item => item.Id), [ 'b' ]);
    assert.equal(applyUserDataChange(items, 'a', { Played: true }, 'unplayed').removed, 1);
    const played = playedUserData({ PlaybackPositionTicks: 900, Played: false }, true, null);
    assert.equal(played.Played, true);
    assert.equal(played.PlaybackPositionTicks, 0, 'local fallback clears progress');
    assert.deepEqual(playedUserData({}, true, { Played: true, PlayCount: 3 }), { Played: true, PlayCount: 3 }, 'server data wins');

    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    responses.push({ status: 200, body: JSON.stringify({ IsFavorite: true, Played: false }) });
    assert.deepEqual(await api.setFavorite('a', true), { IsFavorite: true, Played: false });
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].url, /\/Users\/user-id\/FavoriteItems\/a$/);
    responses.push({ status: 204, body: '' });
    assert.equal(await api.setPlayed('a', false), null);
    assert.equal(requests[1].method, 'DELETE');

    const main = source('main.tsx');
    assert.match(main, /const applyUserData = \(itemId: string/);
    for (const setter of [ 'setResumeItems', 'setNextUpItems', 'setLatestItems', 'setHomeExploreItems', 'setRecommendationGroups', 'setSelected' ]) {
        assert.match(main.slice(main.indexOf('const applyUserData')), new RegExp(`${setter}\\(`), `${setter} is reconciled`);
    }
    const feed = source('home-feed.tsx');
    assert.match(feed, /onUserData\?\.\(item\.Id, userData\)/, 'spotlight favorites propagate to the shared home state');
});

test('CAT-08 episode loading pages beyond the old 1,000/800 caps and the player pages by season', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    const total = 1250;
    for (let start = 0; start < total; start += 100) responses.push({ status: 200, body: JSON.stringify({ Items: page(start, Math.min(100, total - start)), TotalRecordCount: total }) });
    const episodes = await api.getAllSeasonEpisodes('series', 'season');
    assert.equal(episodes.length, total);
    assert.equal(requests.length, 13);
    assert.match(requests[12].url, /StartIndex=1200/);
    const player = source('player.tsx');
    assert.doesNotMatch(player, /getSeriesEpisodes/, 'the player no longer loads a whole series');
    assert.match(player, /api\.getSeasons\(item\.SeriesId\)/);
    assert.match(player, /api\.getAllSeasonEpisodes\(item\.SeriesId, seasonId\)/);
    assert.match(player, /api\.getAdjacentEpisodes\(item\.SeriesId, item\.Id\)/, 'previous/next work across season boundaries');
});

test('CAT-10 detail hydration exposes a loading state alongside retry', () => {
    const main = source('main.tsx');
    assert.match(main, /setDetailLoading\(true\);\s*setView\('details'\)/);
    assert.match(main, /finally \{\s*if \(request === detailRequest\.current && accountGeneration\.isCurrent\(account\)\) setDetailLoading\(false\);/);
    assert.match(main, /Loading full details…/);
});

test('CAT-11 optional home and library failures are tracked independently with retry', () => {
    const main = source('main.tsx');
    assert.match(main, /setHomeExploreError\(messageOf\(error\)\)/, 'explore paging failures are surfaced');
    assert.match(main, /if \(homeExploreError && !retry\) return;/, 'auto-paging stops after a failure until retried');
    assert.match(main, /title="More titles could not load"/);
    assert.match(main, /noteDiscoveryFailure\(\); if \(isAccountCurrent\(\)\) setRecommendationsLoading\(false\)/);
    const library = source('library.tsx');
    assert.match(library, /Retry genres/);
    assert.match(library, /Retry decades/);
    assert.match(library, /setGenreError/);
    assert.match(library, /setYearError/);
});

test('CAT-13 actions follow item capabilities', async () => {
    const { itemCapabilities } = await model();
    assert.deepEqual(
        [ 'Movie', 'Episode', 'Person', 'Genre', 'Photo', 'Folder', 'BoxSet' ].map(type => itemCapabilities({ Type: type }).playable),
        [ true, true, false, false, false, false, false ]
    );
    assert.equal(itemCapabilities({ Type: 'Video', MediaType: 'Video' }).playable, true);
    assert.equal(itemCapabilities({ Type: 'Person' }).canMarkPlayed, false);
    assert.equal(itemCapabilities({ Type: 'Person' }).entity, true);
    assert.equal(itemCapabilities({ Type: 'Movie' }).canMarkPlayed, true);
    assert.equal(itemCapabilities({ Type: 'CollectionFolder' }).canFavorite, false);
    const main = source('main.tsx');
    assert.match(main, /\{capabilities\.playable && \(canResume\(item\)/, 'detail Play is capability-gated');
    assert.match(source('library.tsx'), /itemCapabilities\(/, 'library cards gate quick actions');
});

test('CAT-14 entities list related titles and episodes link to series and neighbours', async () => {
    const { entityQuery, adjacentEpisodes } = await model();
    assert.deepEqual(entityQuery({ Type: 'Person', Id: 'p' }), { PersonIds: 'p' });
    assert.deepEqual(entityQuery({ Type: 'Studio', Id: 's' }), { StudioIds: 's' });
    assert.deepEqual(entityQuery({ Type: 'MusicArtist', Id: 'm' }), { ArtistIds: 'm' });
    assert.equal(entityQuery({ Type: 'Movie', Id: 'x' }), null);
    const list = [ { Id: 'e1' }, { Id: 'e2' }, { Id: 'e3' } ];
    assert.deepEqual(adjacentEpisodes(list, 'e2'), { previous: list[0], next: list[2] });
    assert.deepEqual(adjacentEpisodes(list, 'e1'), { previous: null, next: list[1] });
    assert.deepEqual(adjacentEpisodes(list, 'nope'), { previous: null, next: null });

    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    responses.push({ status: 200, body: JSON.stringify({ Items: [ { Id: 'm1' } ], TotalRecordCount: 41 }) });
    const related = await api.getRelatedItems({ PersonIds: 'p' }, 40, 40);
    assert.equal(related.TotalRecordCount, 41);
    const relatedUrl = new URL(requests[0].url);
    assert.equal(relatedUrl.searchParams.get('PersonIds'), 'p');
    assert.equal(relatedUrl.searchParams.get('StartIndex'), '40');
    assert.equal(relatedUrl.searchParams.get('Recursive'), 'true');
    responses.push({ status: 200, body: JSON.stringify({ Items: list }) });
    assert.deepEqual(await api.getAdjacentEpisodes('series', 'e2'), list);
    assert.match(requests[1].url, /\/Shows\/series\/Episodes\?/);
    assert.equal(new URL(requests[1].url).searchParams.get('AdjacentTo'), 'e2');

    const main = source('main.tsx');
    assert.match(main, /Go to series/);
    assert.match(main, /api\.getRelatedItems\(query, startIndex, SEARCH_PAGE_SIZE\)/);
    assert.match(main, /const openEpisodeSeries = async/);
});
