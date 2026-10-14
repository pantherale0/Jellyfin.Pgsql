import assert from 'node:assert/strict';
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
beforeEach(() => { requests.length = 0; responses.length = 0; });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
globalThis.localStorage = { getItem: () => null, setItem: () => undefined };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send(body) {
        requests.push({ method: this.method, url: this.url, body });
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const { JellyfinApi } = await import('../src/api.ts');
const { createAdminApi } = await import('../src/admin/admin-api.ts');
const options = await import('../src/admin/library-options.ts');
const session = {
    server: 'https://jellyfin.example.test', token: 'token',
    user: { Id: 'user-id', Name: 'Admin' }, serverId: 'server-id'
};
const adminApi = () => createAdminApi(new JellyfinApi(session));

test('MISS-28 saved fetcher order wins and newly available fetchers follow in server order', () => {
    const ordered = options.orderPlugins(
        [{ Name: 'TheMovieDb' }, { Name: 'The Open Movie Database' }, { Name: 'NewProvider' }],
        ['The Open Movie Database', 'TheMovieDb'],
    );
    assert.deepEqual(ordered.map(p => p.Name), ['The Open Movie Database', 'TheMovieDb', 'NewProvider']);
});

test('MISS-28 type fetchers fall back to server defaults until the library stores a choice', () => {
    const available = { Type: 'Movie', MetadataFetchers: [{ Name: 'TheMovieDb', DefaultEnabled: true }, { Name: 'OMDb', DefaultEnabled: false }] };
    assert.deepEqual(options.readTypeFetchers(available, {}, 'Metadata'), [
        { name: 'TheMovieDb', enabled: true },
        { name: 'OMDb', enabled: false },
    ]);
    const stored = { TypeOptions: [{ Type: 'Movie', MetadataFetchers: ['OMDb'], MetadataFetcherOrder: ['OMDb', 'TheMovieDb'] }] };
    assert.deepEqual(options.readTypeFetchers(available, stored, 'Metadata'), [
        { name: 'OMDb', enabled: true },
        { name: 'TheMovieDb', enabled: false },
    ]);
});

test('MISS-28 writing type fetchers keeps other type options and fields intact', () => {
    const base = { TypeOptions: [{ Type: 'Movie', ImageFetchers: ['Fanart'], ImageOptions: [{ Type: 'Backdrop', Limit: 3 }] }, { Type: 'BoxSet', MetadataFetchers: ['TheMovieDb'] }] };
    const next = options.writeTypeFetchers(base, 'Movie', 'Metadata', [{ name: 'B', enabled: false }, { name: 'A', enabled: true }]);
    const movie = next.TypeOptions.find(row => row.Type === 'Movie');
    assert.deepEqual(movie.MetadataFetchers, ['A']);
    assert.deepEqual(movie.MetadataFetcherOrder, ['B', 'A']);
    assert.deepEqual(movie.ImageFetchers, ['Fanart'], 'image fetchers for the type are preserved');
    assert.deepEqual(movie.ImageOptions, [{ Type: 'Backdrop', Limit: 3 }], 'image options for the type are preserved');
    assert.deepEqual(next.TypeOptions.find(row => row.Type === 'BoxSet'), { Type: 'BoxSet', MetadataFetchers: ['TheMovieDb'] });
    assert.equal(base.TypeOptions[0].MetadataFetchers, undefined, 'the source document is not mutated');

    const added = options.writeTypeFetchers({}, 'Series', 'Image', [{ name: 'TheTVDB', enabled: true }]);
    assert.deepEqual(added.TypeOptions, [{ Type: 'Series', ImageFetchers: ['TheTVDB'], ImageFetcherOrder: ['TheTVDB'] }]);
});

test('MISS-28 disabled-list providers round-trip enable state and order', () => {
    const available = [{ Name: 'Open Subtitles', DefaultEnabled: true }, { Name: 'Podnapisi', DefaultEnabled: true }];
    const entries = options.readDisabledList(available, { DisabledSubtitleFetchers: ['Podnapisi'], SubtitleFetcherOrder: ['Podnapisi', 'Open Subtitles'] }, 'Subtitle');
    assert.deepEqual(entries, [{ name: 'Podnapisi', enabled: false }, { name: 'Open Subtitles', enabled: true }]);
    const moved = options.moveEntry(entries, 1, -1);
    const written = options.writeDisabledList({ Other: 1 }, 'Subtitle', moved);
    assert.deepEqual(written, { Other: 1, DisabledSubtitleFetchers: ['Podnapisi'], SubtitleFetcherOrder: ['Open Subtitles', 'Podnapisi'] });
    assert.equal(options.moveEntry(entries, 0, -1), entries, 'moving past the edge is a no-op');
});

test('MISS-28 metadata savers and local readers map to their stored shapes', () => {
    assert.deepEqual(options.readMetadataSavers([{ Name: 'Nfo', DefaultEnabled: false }], {}), [{ name: 'Nfo', enabled: false }]);
    assert.deepEqual(options.readMetadataSavers([{ Name: 'Nfo', DefaultEnabled: false }], { MetadataSavers: ['Nfo'] }), [{ name: 'Nfo', enabled: true }]);
    assert.deepEqual(options.writeMetadataSavers({}, [{ name: 'Nfo', enabled: false }]), { MetadataSavers: [] });
    const readers = options.readLocalReaders([{ Name: 'Nfo' }, { Name: 'Json' }], { LocalMetadataReaderOrder: ['Json', 'Nfo'], DisabledLocalMetadataReaders: ['Nfo'] });
    assert.deepEqual(readers, [{ name: 'Json', enabled: true }, { name: 'Nfo', enabled: false }]);
    assert.deepEqual(options.writeLocalReaders({}, readers), { LocalMetadataReaderOrder: ['Json', 'Nfo'], DisabledLocalMetadataReaders: ['Nfo'] });
});

test('MISS-28 save payload preserves unedited options and takes folders from the latest server copy', () => {
    const draft = { EnableRealtimeMonitor: true, UnknownFutureOption: 'keep', TypeOptions: [{ Type: 'Movie' }], PathInfos: [{ Path: '/stale' }, { Path: '/removed' }] };
    const latest = { EnableRealtimeMonitor: false, PathInfos: [{ Path: '/stale' }, { Path: '/added' }] };
    const payload = options.buildLibraryOptionsPayload(draft, latest);
    assert.equal(payload.EnableRealtimeMonitor, true, 'draft edits win');
    assert.equal(payload.UnknownFutureOption, 'keep', 'fields the editor does not render survive whole-document replacement');
    assert.deepEqual(payload.PathInfos, [{ Path: '/stale' }, { Path: '/added' }], 'removed folders are not resurrected by a stale draft');
    payload.TypeOptions[0].Type = 'changed';
    assert.equal(draft.TypeOptions[0].Type, 'Movie', 'the payload is detached from the draft');
});

test('MISS-28 a late load for a previous library cannot populate the current editor', () => {
    const tracker = new options.LibraryLoadTracker();
    const first = tracker.begin('library-a');
    const second = tracker.begin('library-b');
    assert.equal(tracker.isCurrent(first, 'library-a'), false);
    assert.equal(tracker.isCurrent(second, 'library-a'), false, 'a token is bound to its library');
    assert.equal(tracker.isCurrent(second, 'library-b'), true);
    tracker.cancel();
    assert.equal(tracker.isCurrent(second, 'library-b'), false, 'closing the editor retires in-flight loads');
});

test('MISS-28 saving requires a successfully loaded draft for the selected library', () => {
    assert.equal(options.canSaveLibraryDraft('loading', undefined, 'a', false), false);
    assert.equal(options.canSaveLibraryDraft('error', 'a', 'a', false), false, 'a failed load is not a saveable empty draft');
    assert.equal(options.canSaveLibraryDraft('ready', 'a', 'b', false), false, 'a draft cannot be saved onto another library');
    assert.equal(options.canSaveLibraryDraft('ready', 'a', 'a', true), false);
    assert.equal(options.canSaveLibraryDraft('ready', 'a', 'a', false), true);
});

test('MISS-28 field visibility follows the library content type', () => {
    const tv = options.libraryFieldVisibility('tvshows');
    assert.equal(tv.seasonZero, true);
    assert.equal(tv.lufs, false);
    const music = options.libraryFieldVisibility('music');
    assert.equal(music.lufs, true);
    assert.equal(music.chapters, false);
    assert.equal(music.embeddedTitles, false);
    const mixed = options.libraryFieldVisibility(undefined);
    assert.equal(mixed.chapters, true);
    assert.equal(mixed.subtitles, true);
    assert.equal(options.libraryFieldVisibility('homevideos').photos, true);
});

test('MISS-28 admin API uses the library structure endpoints', async () => {
    const api = adminApi();
    responses.push({ status: 204, body: '' }, { status: 204, body: '' }, { status: 204, body: '' }, { status: 204, body: '' });
    await api.renameLibrary('Films', 'Movies & Films');
    await api.addLibraryPath('Movies', '/media/Films, Classics');
    await api.removeLibraryPath('Movies', '/media/old');
    await api.updateLibraryOptions('lib-id', { EnableRealtimeMonitor: true });

    const [rename, add, remove, update] = requests;
    const renameUrl = new URL(rename.url);
    assert.equal(rename.method, 'POST');
    assert.equal(renameUrl.pathname, '/Library/VirtualFolders/Name');
    assert.equal(renameUrl.searchParams.get('name'), 'Films');
    assert.equal(renameUrl.searchParams.get('newName'), 'Movies & Films');

    assert.equal(add.method, 'POST');
    assert.equal(new URL(add.url).pathname, '/Library/VirtualFolders/Paths');
    assert.deepEqual(JSON.parse(add.body), { Name: 'Movies', PathInfo: { Path: '/media/Films, Classics' } });

    const removeUrl = new URL(remove.url);
    assert.equal(remove.method, 'DELETE');
    assert.equal(removeUrl.pathname, '/Library/VirtualFolders/Paths');
    assert.equal(removeUrl.searchParams.get('path'), '/media/old');

    assert.equal(update.method, 'POST');
    assert.equal(new URL(update.url).pathname, '/Library/VirtualFolders/LibraryOptions');
    assert.deepEqual(JSON.parse(update.body), { Id: 'lib-id', LibraryOptions: { EnableRealtimeMonitor: true } });
});

test('MISS-28 available options omit the content type for mixed libraries', async () => {
    const api = adminApi();
    responses.push({ status: 200, body: '{"TypeOptions":[]}' }, { status: 200, body: '{}' });
    await api.getAvailableLibraryOptions('tvshows');
    await api.getAvailableLibraryOptions('mixed');
    assert.equal(new URL(requests[0].url).searchParams.get('libraryContentType'), 'tvshows');
    assert.equal(new URL(requests[1].url).searchParams.has('libraryContentType'), false);
});
