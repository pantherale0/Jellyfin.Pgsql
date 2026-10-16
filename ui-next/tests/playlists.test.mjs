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

const detail = await import('../src/detail-model.ts');
const catalog = await import('../src/catalog-model.ts');
const bulk = await import('../src/bulk-actions.ts');
const discovery = await import('../src/discovery.ts');
const { JellyfinApi, PLAYLIST_PAGE_SIZE, PLAYLIST_QUEUE_LIMIT } = await import('../src/api.ts');
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');
const session = { server: 'https://jf.test', token: 'token', user: { Id: 'me', Name: 'Me' }, serverId: 's' };
const page = (items, total) => ({ status: 200, body: JSON.stringify({ Items: items, TotalRecordCount: total }) });
const url = request => new URL(request.url);

test('playlist entries page with StartIndex and report the full total', async () => {
    const api = new JellyfinApi(session);
    responses.push(page([ { Id: 'a', PlaylistItemId: 'e1' } ], 450));
    const first = await api.getPlaylistEntries('pl');
    assert.deepEqual(first, { items: [ { Id: 'a', PlaylistItemId: 'e1' } ], total: 450 });
    assert.equal(url(requests[0]).pathname, '/Playlists/pl/Items');
    assert.equal(url(requests[0]).searchParams.get('Limit'), String(PLAYLIST_PAGE_SIZE));
    assert.equal(url(requests[0]).searchParams.get('StartIndex'), null);
    responses.push(page([], 450));
    await api.getPlaylistEntries('pl', 200);
    assert.equal(url(requests[1]).searchParams.get('StartIndex'), '200');
    responses.push({ status: 200, body: JSON.stringify({ Items: [ { Id: 'x' } ] }) });
    assert.equal((await api.getPlaylistEntries('pl', 10)).total, 11, 'a missing total never hides loaded entries');
    assert.equal(PLAYLIST_QUEUE_LIMIT, 5000);
});

test('appendEntries keeps repeated titles that are different playlist entries', () => {
    const current = [ { Id: 'a', PlaylistItemId: 'e1' }, { Id: 'b', PlaylistItemId: 'e2' } ];
    const next = catalog.appendEntries(current, [ { Id: 'a', PlaylistItemId: 'e3' }, { Id: 'b', PlaylistItemId: 'e2' } ]);
    assert.deepEqual(next.map(entry => entry.PlaylistItemId), [ 'e1', 'e2', 'e3' ]);
    assert.deepEqual(catalog.appendPage(current, [ { Id: 'a', PlaylistItemId: 'e3' } ]).length, 2, 'appendPage still dedupes by item id');
});

test('favorites page with StartIndex', async () => {
    const api = new JellyfinApi(session);
    const movies = discovery.FAVORITE_GROUPS.find(group => group.id === 'movies');
    responses.push(page([ { Id: 'm' } ], 60), page([ { Id: 'm2' } ], 60));
    assert.deepEqual(await api.getFavorites(movies), { items: [ { Id: 'm' } ], total: 60 });
    await api.getFavorites(movies, 24, 24);
    assert.equal(url(requests[0]).searchParams.get('StartIndex'), null);
    assert.equal(url(requests[1]).searchParams.get('StartIndex'), '24');
    assert.equal(url(requests[1]).searchParams.get('Limit'), '24');
});

test('playlist curation uses the Jellyfin playlist endpoints', async () => {
    const api = new JellyfinApi(session);
    responses.push(page([ { Id: 'p1', Name: 'Road trip', Type: 'Playlist' } ], 1), { status: 200, body: JSON.stringify({ Id: 'new' }) });
    assert.equal((await api.getPlaylists())[0].Id, 'p1');
    assert.equal(url(requests[0]).searchParams.get('IncludeItemTypes'), 'Playlist');
    assert.equal((await api.createPlaylist('Mix', [ 'a', 'b' ])).Id, 'new');
    assert.deepEqual(JSON.parse(requests[1].body), { Name: 'Mix', Ids: [ 'a', 'b' ], UserId: 'me' });
    await api.addToPlaylist('p1', [ 'a', 'b' ]);
    await api.removeFromPlaylist('p1', [ 'e1' ]);
    await api.movePlaylistEntry('p1', 'e2', 3);
    await api.renamePlaylist('p1', 'Renamed');
    assert.deepEqual(requests.slice(1).map(request => `${request.method} ${url(request).pathname}`), [
        'POST /Playlists', 'POST /Playlists/p1/Items', 'DELETE /Playlists/p1/Items', 'POST /Playlists/p1/Items/e2/Move/3', 'POST /Playlists/p1'
    ]);
    assert.equal(url(requests[2]).searchParams.get('ids'), 'a,b');
    assert.equal(url(requests[3]).searchParams.get('entryIds'), 'e1');
    assert.deepEqual(JSON.parse(requests[5].body), { Name: 'Renamed' });
});

test('edit permission comes from the playlist user endpoint; anything else is read-only', async () => {
    const api = new JellyfinApi(session);
    responses.push({ status: 200, body: JSON.stringify({ UserId: 'me', CanEdit: true }) });
    assert.equal(await api.canEditPlaylist('p1'), true);
    assert.equal(url(requests[0]).pathname, '/Playlists/p1/Users/me');
    responses.push({ status: 200, body: JSON.stringify({ UserId: 'me', CanEdit: false }) });
    assert.equal(await api.canEditPlaylist('p1'), false);
    responses.push({ status: 204, body: '' });
    assert.equal(await api.canEditPlaylist('p1'), false);
    responses.push({ status: 403, body: 'Forbidden' });
    assert.equal(await api.canEditPlaylist('p1'), false);
});

test('any user can add playable titles and folders to playlists, not people or tags', () => {
    const viewer = { Policy: { IsAdministrator: false } };
    assert.equal(detail.itemActions({ Id: 'm', Type: 'Movie' }, viewer).playlist, true);
    assert.equal(detail.itemActions({ Id: 's', Type: 'Series' }, viewer).playlist, true);
    assert.equal(detail.itemActions({ Id: 'p', Type: 'Person' }, viewer).playlist, false);
    assert.equal(detail.itemActions({ Id: 'tag:x', Type: 'Movie' }, viewer).playlist, false);
    assert.equal(bulk.bulkCapabilities([ { Id: 'm', Type: 'Movie' }, { Id: 'e', Type: 'Episode' } ], viewer).playlist, true);
    assert.equal(bulk.bulkCapabilities([ { Id: 'm', Type: 'Movie' }, { Id: 'b', Type: 'BoxSet' } ], viewer).playlist, false);
});

test('UI wiring: paged playlists, whole-playlist queue, editor controls, pickers and favorites Show more', () => {
    const sections = source('detail-sections.tsx');
    assert.match(sections, /if \(kind === 'playlist'\) return <PlaylistEntries/);
    assert.match(sections, /api\.getPlaylistEntries\(item\.Id, entries\.length\)/);
    assert.match(sections, /while \(api && all\.length < Math\.min\(total, PLAYLIST_QUEUE_LIMIT\)\)/, 'Play all loads the remaining pages first');
    assert.match(sections, /Load more \(\$\{remaining\.toLocaleString\(\)\} remaining\)/);
    assert.match(sections, /canEdit && entry\.PlaylistItemId && <>/);
    assert.match(sections, /api\.removeFromPlaylist\(item\.Id, \[ entry\.PlaylistItemId! \]\)/);
    assert.match(sections, /api\.movePlaylistEntry\(item\.Id, entry\.PlaylistItemId!, target\)/);
    assert.match(sections, /api\.renamePlaylist\(item\.Id, name\)/);
    assert.match(sections, /\{actions\.playlist && <button[^\n]*>Add to playlist<\/button>\}/);
    assert.match(sections, /export function PlaylistPicker\(/);
    const library = source('library.tsx');
    assert.match(library, /<PlaylistPicker api=\{api\} itemIds=\{selected\.map\(item => item\.Id\)\}/);
    assert.match(library, /canAddToPlaylist\(item\) && <button[^\n]*>Add to playlist…<\/button>/);
    const favorites = source('discovery-views.tsx');
    assert.match(favorites, /api\.getFavorites\(group, FAVORITES_PAGE_SIZE, row\.items\.length\)/);
    assert.match(favorites, /Show more \(\$\{\(row\.total - row\.items\.length\)\.toLocaleString\(\)\} remaining\)/);
});
