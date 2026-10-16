import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const storage = new Map();
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };

const m = await import('../src/metadata-model.ts');
const a = await import('../src/metadata-api.ts');
const { JellyfinRequestError, RequestTimeoutError } = await import('../src/api.ts');
const s = await import('../src/admin/server-settings.ts');
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');

function fakeApi(responses = {}) {
    const calls = [];
    return {
        calls,
        session: { server: 'https://jf.test', token: 't', user: { Id: 'user-1', Name: 'Admin' }, serverId: 's' },
        request(path, init = {}, emptyOk, priority) {
            calls.push({ path, method: init.method || 'GET', body: init.body, headers: init.headers, timeoutMs: init.timeoutMs, emptyOk, priority });
            const value = responses[`${init.method || 'GET'} ${path.split('?')[0]}`];
            return Promise.resolve(typeof value === 'function' ? value() : value);
        },
    };
}

const admin = { Policy: { IsAdministrator: true } };
const subtitler = { Policy: { IsAdministrator: false, EnableSubtitleManagement: true } };
const lyricist = { Policy: { IsAdministrator: false, EnableLyricManagement: true } };
const viewer = { Policy: { IsAdministrator: false } };

test('MISS-35: editor info keeps only well-formed entries and https link templates', () => {
    const info = m.asEditorInfo({
        ParentalRatingOptions: [ { Name: 'PG-13', Value: 13 }, { Value: 5 }, 'bad' ],
        Countries: [ { DisplayName: 'Canada', TwoLetterISORegionName: 'CA' }, { DisplayName: 'Nowhere' } ],
        Cultures: [ { DisplayName: 'English', ThreeLetterISOLanguageName: 'eng', TwoLetterISOLanguageName: 'en' }, { DisplayName: 'No code' } ],
        ExternalIdInfos: [
            { Name: 'IMDb', Key: 'Imdb', Type: null, UrlFormatString: 'https://www.imdb.com/title/{0}' },
            { Name: 'Evil', Key: 'Evil', UrlFormatString: 'javascript:alert({0})' },
            { Name: 'Bad key', Key: 'a b' },
        ],
        ContentType: 'movies',
        ContentTypeOptions: [ { Name: 'Movies', Value: 'movies' } ],
    });
    assert.deepEqual(info.ParentalRatingOptions, [ { Name: 'PG-13', Value: '13' } ]);
    assert.deepEqual(info.Countries, [ { Name: 'Canada', TwoLetterISORegionName: 'CA' } ]);
    assert.equal(info.Cultures.length, 1);
    assert.deepEqual(info.ExternalIdInfos, [ { Name: 'IMDb', Key: 'Imdb', UrlFormatString: 'https://www.imdb.com/title/{0}' }, { Name: 'Evil', Key: 'Evil' } ]);
    assert.equal(info.ContentType, 'movies');
    assert.throws(() => m.asEditorInfo(null));
});

test('MISS-35: remote images, search results, subtitles and lyrics are bounded and https-only', () => {
    const images = m.asRemoteImages({
        Images: [
            { ProviderName: 'TMDb', Url: 'https://image.tmdb.org/a.jpg', ThumbnailUrl: 'http://insecure/thumb.jpg', Width: 1000, Height: 1500, CommunityRating: 7.2 },
            { ProviderName: 'Bad', Url: 'http://plain/a.jpg' },
            { ProviderName: 'Creds', Url: 'https://user:pass@host/a.jpg' },
            { ProviderName: 'Script', Url: 'javascript:alert(1)' },
        ],
        TotalRecordCount: 40,
        Providers: [ 'TMDb', 42 ],
    });
    assert.equal(images.Images.length, 1);
    assert.equal(images.Images[0].ThumbnailUrl, undefined);
    assert.equal(images.TotalRecordCount, 40);
    assert.deepEqual(images.Providers, [ 'TMDb' ]);
    assert.equal(m.asRemoteImages({ Images: Array.from({ length: 900 }, (_, i) => ({ Url: `https://h/${i}.jpg` })) }).Images.length, 300);

    const results = m.asRemoteSearchResults([
        { Name: 'Heat', ProductionYear: 1995, ImageUrl: 'http://x/y.jpg', ProviderIds: { Tmdb: '949', 'bad key': 'x' }, SearchProviderName: 'TheMovieDb' },
        { ProductionYear: 2000 },
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].ImageUrl, undefined);
    assert.deepEqual(results[0].ProviderIds, { Tmdb: '949' });
    assert.throws(() => m.asRemoteSearchResults({}));

    const subtitles = m.asRemoteSubtitles([ { Id: 'os-1', Name: 'Heat.srt', Format: 'srt', IsHashMatch: true }, { Name: 'no id' } ]);
    assert.deepEqual(subtitles.map(entry => entry.Id), [ 'os-1' ]);
    assert.equal(subtitles[0].IsHashMatch, true);

    const lyrics = m.asRemoteLyrics([ { Id: 'l1', ProviderName: 'LrcLib', Lyrics: { Metadata: { Title: 'Song', Artist: 'Band' }, Lyrics: [ { Text: 'Hello', Start: 10 }, { Text: 5 } ] } } ]);
    assert.equal(lyrics[0].Title, 'Song');
    assert.deepEqual(lyrics[0].Lines, [ { Text: 'Hello', Start: 10 } ]);
    assert.deepEqual(m.asImageInfos([ { ImageType: 'Primary', ImageIndex: 0, ImageTag: 't', Width: 10 }, { ImageType: '../x' } ]), [ { ImageType: 'Primary', ImageIndex: 0, ImageTag: 't', Width: 10 } ]);
});

test('MISS-35: editor fields follow the item type', () => {
    const movie = m.editorFields({ Type: 'Movie' });
    assert.ok(movie.has('People') && movie.has('CriticRating') && movie.has('Video3DFormat'));
    assert.ok(!movie.has('Status') && !movie.has('IndexNumber'));
    const series = m.editorFields({ Type: 'Series' });
    assert.ok(series.has('Status') && series.has('AirDays') && series.has('EndDate') && series.has('DisplayOrder'));
    const episode = m.editorFields({ Type: 'Episode' });
    assert.ok(episode.has('IndexNumber') && episode.has('ParentIndexNumber') && episode.has('AirsBeforeSeasonNumber'));
    const audio = m.editorFields({ Type: 'Audio' });
    assert.ok(audio.has('Album') && audio.has('Artists') && audio.has('AlbumArtists') && !audio.has('People'));
    const person = m.editorFields({ Type: 'Person' });
    assert.ok(!person.has('Genres') && !person.has('OfficialRating') && person.has('EndDate'));
});

test('MISS-35: drafts validate numbers, dates, people and names', () => {
    const base = m.metadataDraft({ Id: 'i', Name: 'Heat', ProductionYear: 1995, PremiereDate: '1995-12-15T00:00:00.0000000Z', Genres: [ 'Crime' ], People: [ { Id: 'p1', Name: 'Al Pacino', Type: 'Actor', Role: 'Hanna' } ] });
    assert.equal(base.PremiereDate, '1995-12-15');
    assert.equal(base.ProductionYear, '1995');
    assert.equal(m.validateDraft(base), '');
    assert.match(m.validateDraft({ ...base, Name: '  ' }), /name/i);
    assert.match(m.validateDraft({ ...base, CommunityRating: '11' }), /between 0 and 10/);
    assert.match(m.validateDraft({ ...base, CriticRating: 'abc' }), /Critic/);
    assert.match(m.validateDraft({ ...base, ProductionYear: '1995.5' }), /Year/);
    assert.match(m.validateDraft({ ...base, IndexNumber: '-1' }), /whole numbers/);
    assert.match(m.validateDraft({ ...base, PremiereDate: '1995-13-45' }), /Dates/);
    assert.match(m.validateDraft({ ...base, AirTime: 'noon' }), /Air time/);
    assert.match(m.validateDraft({ ...base, People: [ { Name: '', Type: 'Actor', Role: '' } ] }), /person/);
    assert.deepEqual(m.cleanList([ ' Drama ', 'drama', '', 'Crime' ]), [ 'Drama', 'Crime' ]);
});

test('MISS-35: saves send only edited fields and keep concurrent server changes', () => {
    const original = { Id: 'i', Name: 'Heat', Overview: 'Old', Genres: [ 'Crime' ], Tags: [ 'heist' ], People: [ { Id: 'p1', Name: 'Al Pacino', Type: 'Actor', Role: 'Hanna', PrimaryImageTag: 'img' } ], ProviderIds: { Imdb: 'tt0113277' } };
    const draft = m.metadataDraft(original);
    const edited = { ...draft, Overview: 'New overview', Genres: [ 'Crime', 'Thriller' ] };
    const changes = m.changedMetadata(m.metadataDraft(original), edited);
    assert.deepEqual(Object.keys(changes).sort(), [ 'Genres', 'Overview' ]);

    const fresh = { ...original, Tags: [ 'heist', 'server-added' ], OfficialRating: 'R' };
    const update = m.buildItemUpdate(fresh, changes);
    assert.equal(update.Overview, 'New overview');
    assert.deepEqual(update.Genres, [ 'Crime', 'Thriller' ]);
    assert.deepEqual(update.Tags, [ 'heist', 'server-added' ]);
    assert.equal(update.OfficialRating, 'R');

    const fields = m.itemFields({ Studios: [ 'Warner' ], Artists: [ 'A' ], PremiereDate: '2000-01-02', CommunityRating: '', ProviderIds: { Imdb: ' tt1 ', Tmdb: '' }, People: [ { Id: 'p1', Name: 'Al Pacino', Type: 'Actor', Role: '' } ] }, fresh);
    assert.deepEqual(fields.Studios, [ { Name: 'Warner' } ]);
    assert.deepEqual(fields.ArtistItems, [ { Name: 'A' } ]);
    assert.deepEqual(fields.Artists, [ 'A' ]);
    assert.equal(fields.PremiereDate, '2000-01-02T00:00:00.0000000Z');
    assert.equal(fields.CommunityRating, null);
    assert.deepEqual(fields.ProviderIds, { Imdb: 'tt1' });
    assert.equal(fields.People[0].PrimaryImageTag, 'img');
    assert.equal(fields.People[0].Role, null);
});

test('MISS-35: refresh modes, identify queries and image types', () => {
    assert.deepEqual(m.refreshOptions('scan', true, false), { metadataRefreshMode: 'Default', imageRefreshMode: 'Default', replaceAllMetadata: 'false', replaceAllImages: 'false', regenerateTrickplay: 'false' });
    assert.deepEqual(m.refreshOptions('missing', false, true), { metadataRefreshMode: 'FullRefresh', imageRefreshMode: 'FullRefresh', replaceAllMetadata: 'false', replaceAllImages: 'false', regenerateTrickplay: 'true' });
    assert.deepEqual(m.refreshOptions('all', true, false), { metadataRefreshMode: 'FullRefresh', imageRefreshMode: 'FullRefresh', replaceAllMetadata: 'true', replaceAllImages: 'true', regenerateTrickplay: 'false' });
    assert.equal(m.identifyType({ Type: 'Movie' }), 'Movie');
    assert.equal(m.identifyType({ Type: 'Episode' }), null);
    assert.deepEqual(m.identifyQuery({ Id: 'i' }, { name: ' Heat ', year: '1995', providerIds: { Imdb: ' tt0113277 ', Tmdb: '' } }), { SearchInfo: { Name: 'Heat', Year: 1995, ProviderIds: { Imdb: 'tt0113277' } }, ItemId: 'i', IncludeDisabledProviders: true });
    assert.equal('Year' in m.identifyQuery({ Id: 'i' }, { name: 'Heat', year: '', providerIds: {} }).SearchInfo, false);
    assert.deepEqual(m.imageTypesFor({ Type: 'Person' }), [ 'Primary' ]);
    assert.ok(m.imageTypesFor({ Type: 'Movie' }).includes('Logo'));
});

test('MISS-35: file validators enforce type and size', () => {
    assert.equal(m.validateImageFile({ name: 'a.png', size: 1000, type: 'image/png' }), '');
    assert.match(m.validateImageFile({ name: 'a.svg', size: 1000, type: 'image/svg+xml' }), /JPEG/);
    assert.match(m.validateImageFile({ name: 'a.png', size: 16 * 1024 * 1024, type: 'image/png' }), /15 MB/);
    assert.equal(m.validateSubtitleFile({ name: 'Heat.en.SRT', size: 100, type: '' }), '');
    assert.match(m.validateSubtitleFile({ name: 'Heat.exe', size: 100, type: '' }), /SRT/);
    assert.match(m.validateSubtitleFile({ name: 'a.srt', size: 3 * 1024 * 1024, type: '' }), /2 MB/);
    assert.equal(m.validateLyricFile({ name: 'song.lrc', size: 100, type: '' }), '');
    assert.match(m.validateLyricFile({ name: 'song.lrc', size: 0, type: '' }), /empty/);
    assert.match(m.validateLyricFile({ name: 'song.mp3', size: 100, type: '' }), /LRC/);
});

test('MISS-35: management actions follow admin and management permissions, never on TV or tag items', () => {
    const movie = { Id: 'm', Type: 'Movie' };
    const song = { Id: 'a', Type: 'Audio' };
    assert.deepEqual(m.metadataActions(movie, admin, 'desktop'), { edit: true, images: true, identify: true, refresh: true, subtitles: false, lyrics: false, any: true });
    assert.equal(m.metadataActions({ Id: 'e', Type: 'Episode' }, admin, 'desktop').identify, false);
    assert.deepEqual(m.metadataActions(movie, subtitler, 'desktop'), { edit: false, images: false, identify: false, refresh: false, subtitles: true, lyrics: false, any: true });
    assert.equal(m.metadataActions(song, subtitler, 'desktop').any, false);
    assert.equal(m.metadataActions(song, lyricist, 'desktop').lyrics, true);
    assert.equal(m.metadataActions(movie, lyricist, 'desktop').any, false);
    assert.equal(m.metadataActions(movie, viewer, 'desktop').any, false);
    assert.equal(m.metadataActions(movie, null, 'desktop').any, false);
    assert.equal(m.metadataActions(movie, admin, 'tv').any, false);
    assert.equal(m.metadataActions({ Id: 'tag:heist', Type: 'Tag' }, admin, 'desktop').any, false);
    assert.equal(m.metadataActions({ Id: 'c', Type: 'TvChannel' }, admin, 'desktop').any, false);
});

test('MISS-35: error messages are friendly and never echo server bodies', () => {
    assert.match(m.metadataErrorMessage(new RequestTimeoutError()), /long time/);
    assert.match(m.metadataErrorMessage(new JellyfinRequestError(403, 'secret body')), /not allowed/);
    assert.match(m.metadataErrorMessage(new JellyfinRequestError(400, 'secret body'), 'Saving'), /^Saving was rejected/);
    assert.match(m.metadataErrorMessage(new JellyfinRequestError(404, 'secret body')), /no longer exists/);
    assert.doesNotMatch(m.metadataErrorMessage(new Error('stack trace with secret'), 'Saving'), /secret/);
});

test('MISS-35: item updates re-read the item once and post the merged body', async () => {
    let reads = 0;
    const api = fakeApi({
        'GET /Items/a%20b': () => { reads += 1; return { Id: 'a b', Name: 'Heat', Overview: 'Old', Tags: [ 'server-added' ] }; },
        'POST /Items/a%20b': undefined,
    });
    await a.updateItem(api, 'a b', { Overview: 'New' });
    assert.equal(reads, 1);
    assert.equal(api.calls[0].path, '/Items/a%20b?userId=user-1');
    const post = api.calls[1];
    assert.equal(post.path, '/Items/a%20b');
    assert.equal(post.method, 'POST');
    assert.equal(post.emptyOk, true);
    const body = JSON.parse(post.body);
    assert.equal(body.Overview, 'New');
    assert.deepEqual(body.Tags, [ 'server-added' ]);
});

test('MISS-35: API helpers encode paths, set upload content types and timeouts', async () => {
    const api = fakeApi({ 'POST /Items/RemoteSearch/Movie': [], 'GET /Items/i/RemoteImages': { Images: [] }, 'GET /Items/i/RemoteSearch/Subtitles/eng': [] });
    await a.uploadImage(api, 'i', 'Primary', 'image/png', 'QUJD');
    await a.uploadLyrics(api, 'i', 'song name.lrc', '[00:01.00]Hi');
    await a.refreshItem(api, 'i', m.refreshOptions('all', false, false));
    await a.downloadRemoteImage(api, 'i', 'Backdrop', 'https://image.tmdb.org/a b.jpg');
    await a.remoteSearch(api, 'Movie', { SearchInfo: { Name: 'Heat' } });
    await a.getRemoteImages(api, 'i', { type: 'Primary', startIndex: 30, limit: 30, providerName: 'TMDb', includeAllLanguages: true });
    await a.searchSubtitles(api, 'i', 'eng', true);
    await a.moveImage(api, 'i', 'Backdrop', 2, 1);
    await a.deleteSubtitle(api, 'i', 3);
    const [ image, lyric, refresh, remote, search, remoteImages, subtitles, move, deleteSub ] = api.calls;
    assert.deepEqual([ image.path, image.headers, image.body, image.timeoutMs ], [ '/Items/i/Images/Primary', { 'Content-Type': 'image/png' }, 'QUJD', 120000 ]);
    assert.deepEqual([ lyric.path, lyric.headers, lyric.body ], [ '/Audio/i/Lyrics?fileName=song+name.lrc', { 'Content-Type': 'text/plain' }, '[00:01.00]Hi' ]);
    assert.equal(refresh.path, '/Items/i/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=FullRefresh&replaceAllMetadata=true&replaceAllImages=false&regenerateTrickplay=false');
    assert.equal(remote.path, '/Items/i/RemoteImages/Download?type=Backdrop&imageUrl=https%3A%2F%2Fimage.tmdb.org%2Fa+b.jpg');
    assert.equal(search.timeoutMs, 60000);
    assert.equal(remoteImages.path, '/Items/i/RemoteImages?type=Primary&startIndex=30&limit=30&includeAllLanguages=true&providerName=TMDb');
    assert.equal(subtitles.path, '/Items/i/RemoteSearch/Subtitles/eng?isPerfectMatch=true');
    assert.equal(move.path, '/Items/i/Images/Backdrop/2/Index?newIndex=1');
    assert.deepEqual([ deleteSub.path, deleteSub.method ], [ '/Videos/i/Subtitles/3', 'DELETE' ]);
    assert.equal(a.itemImageUrl(api, 'i', { ImageType: 'Primary', ImageIndex: 0, ImageTag: 'abc' }), 'https://jf.test/Items/i/Images/Primary/0?maxWidth=320&quality=85&tag=abc');
});

test('MISS-35: admin metadata settings and manager query', async () => {
    assert.deepEqual(s.DISPLAY_FIELDS.map(field => field.key), [ 'EnableFolderView', 'DisplaySpecialsWithinSeasons', 'EnableGroupingMoviesIntoCollections', 'EnableGroupingShowsIntoCollections', 'EnableExternalContentInSuggestions' ]);
    assert.deepEqual(s.DATE_ADDED_FIELDS.map(field => [ field.key, field.kind ]), [ [ 'UseFileCreationTimeForDateAdded', 'boolean' ] ]);
    assert.ok(s.METADATA_DEFAULT_FIELDS.some(field => field.key === 'ChapterImageResolution' && field.values === s.CHAPTER_IMAGE_RESOLUTIONS));
    assert.deepEqual(s.NFO_FIELDS.map(field => field.key), [ 'UserId', 'ReleaseDateFormat', 'SaveImagePathsInNfo', 'EnablePathSubstitution', 'EnableExtraThumbsDuplication' ]);
    const page = source('admin/pages/admin-metadata.tsx');
    assert.match(page, /path="\/System\/Configuration\/metadata"/);
    assert.match(page, /path="\/System\/Configuration\/xbmcmetadata"/);
    assert.match(page, /UserId: users/);
    assert.match(page, /\[ '', 'None' \]/);
});

test('MISS-35: wiring, focus handling and privacy of remote thumbnails', () => {
    const editors = source('metadata-editors.tsx');
    assert.match(editors, /useDialogFocus\(sheet, true, requestClose/);
    const remoteImgs = editors.match(/<img src=\{(image\.ThumbnailUrl|result\.ImageUrl)[^>]*>/g) || [];
    assert.equal(remoteImgs.length, 2);
    remoteImgs.forEach(tag => { assert.match(tag, /referrerpolicy="no-referrer"/); assert.match(tag, /loading="lazy"/); });
    assert.match(editors, /rel="noopener noreferrer"/);
    assert.match(editors, /You have unsaved metadata changes/);
    assert.match(source('detail-sections.tsx'), /<ManageItemActions api=\{api\} item=\{item\} user=\{user\} onChanged=\{onChanged\} menu \/>/);
    assert.match(source('main.tsx'), /<ItemActionsBar [^>]*onChanged=\{onRetry\}/);
    assert.match(source('main.tsx'), /window\.location\.hash = 'admin\/metadata'; setView\('admin'\)/);
    assert.doesNotMatch(source('main.tsx'), /openClassic\('metadata'\)/);
    const dashboard = source('admin/admin-dashboard.tsx');
    assert.match(dashboard, /\{ id: 'metadata', label: 'Metadata' \}/);
    assert.match(dashboard, /section === 'metadata' && <AdminMetadata adminApi=\{adminApi\} api=\{api\} \/>/);
    assert.match(source('admin/types.ts'), /'metadata'/);
});
