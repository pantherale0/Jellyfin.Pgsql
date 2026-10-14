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

const detail = await import('../src/detail-model.ts');
const catalog = await import('../src/catalog-model.ts');
const { JellyfinApi } = await import('../src/api.ts');
const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const session = { server: 'https://jf.test', token: 'token', user: { Id: 'me', Name: 'Me' }, serverId: 's' };
const ok = items => ({ status: 200, body: JSON.stringify({ Items: items, TotalRecordCount: items.length }) });
const admin = { Policy: { IsAdministrator: true } };
const viewer = { Policy: { IsAdministrator: false } };

test('PART-06: details expose ratings, tagline, safe links and technical media facts', () => {
    const facts = detail.detailFacts({
        Id: 'm', Name: 'Movie', OfficialRating: 'PG-13', CriticRating: 87.4, Taglines: [ '', 'In space…' ],
        ExternalUrls: [ { Name: 'IMDb', Url: 'https://imdb.com/title/tt1' }, { Name: 'Bad', Url: 'javascript:alert(1)' }, { Name: 'Plain', Url: 'http://x.test' } ],
        MediaSources: [ { Id: 's', Container: 'mkv', Size: 4.5 * 1024 ** 3, Bitrate: 12_400_000, MediaStreams: [
            { Type: 'Video', Width: 3840, Height: 2160, Codec: 'hevc', VideoRangeType: 'HDR10' },
            { Type: 'Audio', DisplayTitle: 'English · EAC3 5.1' },
            { Type: 'Subtitle', Language: 'fre' },
        ] } ],
    });
    assert.equal(facts.officialRating, 'PG-13');
    assert.equal(facts.criticRating, 87);
    assert.equal(facts.tagline, 'In space…');
    assert.deepEqual(facts.links, [ { label: 'IMDb', url: 'https://imdb.com/title/tt1' } ]);
    assert.equal(facts.video, '4K · HEVC · HDR10');
    assert.deepEqual(facts.audio, [ 'English · EAC3 5.1' ]);
    assert.deepEqual(facts.subtitles, [ 'fre' ]);
    assert.equal(facts.container, 'MKV');
    assert.equal(facts.size, '4.5 GB');
    assert.equal(facts.bitrate, '12.4 Mbps');
    assert.equal(detail.formatSize(0), undefined);
});

test('MISS-17: people, genres, studios, tags and artists become openable entities', () => {
    const linked = detail.linkedMetadata({
        Id: 'm', Name: 'Movie', Type: 'Movie',
        People: [ { Id: 'w', Name: 'Writer', Type: 'Writer' }, { Id: 'a', Name: 'Actor', Type: 'Actor', Role: 'Hero', PrimaryImageTag: 't' }, { Id: 'd', Name: 'Director', Type: 'Director' }, { Name: 'No id', Type: 'Actor' } ],
        GenreItems: [ { Id: 'g', Name: 'Drama' } ], Studios: [ { Id: 'st', Name: 'Studio' } ], Tags: [ 'cult', '' ],
    });
    assert.deepEqual(linked.cast.map(person => [ person.Id, person.Overview, person.ImageTags?.Primary ]), [ [ 'a', 'Hero', 't' ] ]);
    assert.deepEqual(linked.crew.map(person => person.role), [ 'Director', 'Writer' ]);
    assert.deepEqual(linked.genres, [ { Id: 'g', Name: 'Drama', Type: 'Genre' } ]);
    assert.deepEqual(linked.studios[0].Type, 'Studio');
    assert.deepEqual(linked.tags, [ { Id: 'tag:cult', Name: 'cult', Type: 'Tag' } ]);
    assert.equal(detail.linkedMetadata({ Id: 'al', Name: 'Album', Type: 'MusicAlbum', GenreItems: [ { Id: 'r', Name: 'Rock' } ] }).genres[0].Type, 'MusicGenre');

    assert.deepEqual([ catalog.itemCapabilities({ Type: 'Tag' }).entity, catalog.itemCapabilities({ Type: 'Tag' }).canFavorite ], [ true, false ]);
    assert.deepEqual(catalog.entityQuery({ Id: 'tag:cult', Name: 'cult', Type: 'Tag' }).Tags, 'cult');
});

test('MISS-10/MISS-15: albums group tracks by disc and child views follow the item type', () => {
    const groups = detail.discGroups([
        { Id: '3', Name: 'C', ParentIndexNumber: 2, IndexNumber: 1 },
        { Id: '2', Name: 'B', ParentIndexNumber: 1, IndexNumber: 2 },
        { Id: '1', Name: 'A', ParentIndexNumber: 1, IndexNumber: 1 },
    ]);
    assert.deepEqual(groups.map(group => [ group.disc, group.tracks.map(track => track.Id) ]), [ [ 1, [ '1', '2' ] ], [ 2, [ '3' ] ] ]);
    assert.equal(detail.discGroups([ { Id: '1', Name: 'A', ParentIndexNumber: 1 } ])[0].disc, null);
    assert.equal(detail.childView({ Type: 'MusicAlbum' }), 'tracks');
    assert.equal(detail.childView({ Type: 'Playlist' }), 'playlist');
    assert.equal(detail.childView({ Type: 'PhotoAlbum' }), 'photos');
    assert.equal(detail.childView({ Type: 'BoxSet' }), 'members');
    assert.equal(detail.childView({ Type: 'Movie' }), null);
    assert.equal(detail.wrapIndex(0, 3, -1), 2);
    assert.equal(detail.wrapIndex(2, 3, 1), 0);
    assert.equal(detail.wrapIndex(0, 0, 1), 0);
});

test('MISS-13/MISS-25/MISS-26: item actions follow server capability flags and user policy', () => {
    const movie = { Id: 'm', Type: 'Movie', CanDelete: true, CanDownload: true };
    assert.deepEqual(detail.itemActions(movie, admin), { download: true, share: true, collection: true, remove: true });
    assert.deepEqual(detail.itemActions({ ...movie, CanDelete: false, CanDownload: false }, viewer), { download: false, share: true, collection: false, remove: false });
    assert.equal(detail.itemActions(movie, { Policy: { EnableCollectionManagement: true } }).collection, true);
    assert.equal(detail.itemActions({ Id: 'tag:x', Type: 'Tag', CanDelete: true }, admin).remove, false);
    assert.equal(detail.itemActions({ Id: 'b', Type: 'BoxSet' }, admin).collection, false);
    assert.deepEqual(detail.withoutItem([ { Id: 'a' }, { Id: 'b' } ], 'a'), [ { Id: 'b' } ]);

    const link = detail.shareLink('https://jf.test/', { Id: 'm 1' }, 'srv');
    assert.equal(link, 'https://jf.test/web/#/details?id=m+1&serverId=srv');
    assert.doesNotMatch(link, /token|api_key|ApiKey/i);
});

test('MISS-19: extras are grouped into trailers, special features by type and additional parts', () => {
    const sections = detail.extrasSections(
        [ { Id: 't', Name: 'Trailer' } ],
        [ { Id: 'b', Name: 'Making of', ExtraType: 'BehindTheScenes' }, { Id: 'd', Name: 'Cut', ExtraType: 'DeletedScene' }, { Id: 'x', Name: 'Other' } ],
        [ { Id: 'p', Name: 'Part 2' } ],
    );
    assert.deepEqual(sections.map(section => [ section.title, section.items.length ]), [ [ 'Trailers', 1 ], [ 'Behind the scenes', 1 ], [ 'Deleted scenes', 1 ], [ 'Extras', 1 ], [ 'Additional parts', 1 ] ]);
    assert.deepEqual(detail.extrasSections([], [], []), []);
});

test('PART-05: series and season played state updates every affected episode', () => {
    const bySeason = { s1: [ { Id: 'e1', Name: 'One', UserData: { Played: false } } ], s2: [ { Id: 'e2', Name: 'Two', UserData: { Played: false } } ] };
    const season = catalog.markEpisodesPlayed(bySeason, [ 's1' ], true);
    assert.equal(season.s1[0].UserData.Played, true);
    assert.equal(season.s2, bySeason.s2);
    const all = catalog.markEpisodesPlayed(season, null, false);
    assert.equal(all.s1[0].UserData.Played, false);
    assert.equal(all.s2[0].UserData.Played, false);
});

test('MISS-11/MISS-18/MISS-19: detail API calls use the documented Jellyfin endpoints', async () => {
    const api = new JellyfinApi(session);
    responses.push(ok([ { Id: 'sim', Name: 'Similar' } ]), ok([]), { status: 200, body: JSON.stringify([ { Id: 't', Name: 'Trailer' } ]) }, ok([]), ok([]), ok([]), ok([]));
    assert.equal((await api.getSimilarItems('m')).length, 1);
    await api.getItemCollections('m');
    assert.equal((await api.getLocalTrailers('m'))[0].Id, 't');
    await api.getSpecialFeatures('m');
    await api.getAdditionalParts('m');
    await api.getChildren('album');
    await api.getPlaylistEntries('pl');
    const paths = requests.map(request => new URL(request.url).pathname);
    assert.deepEqual(paths, [ '/Items/m/Similar', '/Items/m/Collections', '/Items/m/LocalTrailers', '/Items/m/SpecialFeatures', '/Videos/m/AdditionalParts', '/Items', '/Playlists/pl/Items' ]);
    assert.equal(new URL(requests[5].url).searchParams.get('ParentId'), 'album');
    assert.ok(requests.every(request => new URL(request.url).searchParams.get('UserId') === 'me'));

    requests.length = 0;
    responses.push({ status: 200, body: JSON.stringify({ Id: 'new' }) });
    assert.equal((await api.createCollection('Favourites', [ 'a', 'b' ])).Id, 'new');
    await api.addToCollection('c', [ 'a' ]);
    await api.removeFromCollection('c', [ 'a' ]);
    await api.deleteItem('a');
    assert.deepEqual(requests.map(request => `${request.method} ${new URL(request.url).pathname}`), [ 'POST /Collections', 'POST /Collections/c/Items', 'DELETE /Collections/c/Items', 'DELETE /Items/a' ]);
    assert.equal(new URL(requests[0].url).searchParams.get('ids'), 'a,b');
    assert.equal(new URL(requests[0].url).searchParams.get('name'), 'Favourites');

    requests.length = 0;
    responses.push({ status: 200, body: JSON.stringify({ Lyrics: [ { Text: 'la la' } ] }) });
    assert.deepEqual(await api.getLyrics('song'), [ { Text: 'la la' } ]);
    assert.equal(new URL(requests[0].url).pathname, '/Audio/song/Lyrics');
    assert.match(api.downloadUrl('a b'), /^https:\/\/jf\.test\/Items\/a%20b\/Download\?/);
});

test('detail page wires the new sections and library cards offer delete and collection removal', () => {
    const main = source('main.tsx');
    for (const view of [ 'DetailFactsView', 'ItemActionsBar', 'DetailChildren', 'LyricsView', 'LinkedMetadataView', 'DetailExtras', 'RelatedRows' ]) assert.match(main, new RegExp(`<${view} `), `${view} must render on the details page`);
    assert.match(main, /<UserDataActions api=\{api\} item=\{series\}/);
    assert.match(main, /markEpisodesPlayed\(/);
    assert.match(main, /onDeleted=\{removeDeletedItem\}/);

    const sections = source('detail-sections.tsx');
    assert.match(sections, /nav\.share\(/);
    assert.match(sections, /navigator\.clipboard\.writeText/);
    assert.match(sections, /PlaylistItemId/);
    assert.match(sections, /useDialogFocus/);

    const library = source('library.tsx');
    assert.match(library, /api\.deleteItem\(item\.Id\)/);
    assert.match(library, /api\.removeFromCollection\(library\.Id/);
    assert.match(library, /Confirm: delete from server/);
    assert.match(source('library-query.ts'), /MediaStreams,CanDelete/);
});
