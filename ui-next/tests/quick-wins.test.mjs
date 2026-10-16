import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requestedUrls = [];
globalThis.window = globalThis.window || { location: { href: 'https://host/jellyfin/web/' }, setTimeout };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => undefined };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(_method, url) { this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send() {
        requestedUrls.push(this.url);
        queueMicrotask(() => {
            if (this.url.includes('/LiveTv/Programs')) {
                this.status = 200;
                this.responseText = JSON.stringify({ Items: [], TotalRecordCount: 0 });
                this.onload();
                return;
            }
            if (this.url.includes('/PlaybackInfo')) {
                this.status = 200;
                this.responseText = JSON.stringify({
                    MediaSources: [{ Id: 'source-conversion', SupportsDirectPlay: false, TranscodingUrl: '/videos/conversion/master.m3u8?token=t', MediaStreams: [] }],
                    PlaySessionId: 'play-conversion'
                });
                this.onload();
                return;
            }
            this.status = 200;
            this.responseText = JSON.stringify({ Items: [], TotalRecordCount: 0 });
            this.onload();
        });
    }
};

const { JellyfinApi } = await import('../src/api.ts');

const session = {
    server: 'https://host/jellyfin',
    token: 'token',
    user: { Id: 'user-id', Name: 'Admin' },
    serverId: 'server-id'
};

test('LIVE-01 guide query uses overlap parameters so crossing broadcasts remain visible', async () => {
    requestedUrls.length = 0;
    const api = new JellyfinApi(session);
    await api.getLivePrograms(['channel'], '2026-10-13T20:00:00.000Z', '2026-10-14T00:00:00.000Z');
    const url = requestedUrls[0] || '';
    assert.ok(url.includes('MinEndDate='), `guide query must include MinEndDate, got ${url}`);
    assert.ok(url.includes('MaxStartDate='), `guide query must include MaxStartDate, got ${url}`);
});

test('PLAY-02 conversion URL preserves the configured server base path', async () => {
    const api = new JellyfinApi(session);
    const choice = await api.play({ Id: 'conversion', Name: 'Conversion', Type: 'Movie' });
    assert.equal(choice.url, 'https://host/jellyfin/videos/conversion/master.m3u8?token=t');
});

test('PLAY-03 home On Now program normalizes to its channel for negotiation and reporting', async () => {
    const { resolvePlaybackItem } = await import('../src/live-model.ts');
    assert.equal(typeof resolvePlaybackItem, 'function', 'playback item resolver must exist');
    const program = { Id: 'program', Name: 'On Now', Type: 'Program', ChannelId: 'channel', ChannelName: 'Fixture Channel' };
    const resolved = resolvePlaybackItem(program);
    assert.equal(resolved.Id, 'channel');
    assert.equal(resolved.Type, 'TvChannel');
    assert.throws(() => resolvePlaybackItem({ Id: 'program', Type: 'Program', Name: 'Orphan' }), /channel/i);
    const movie = { Id: 'movie', Name: 'Movie', Type: 'Movie' };
    assert.equal(resolvePlaybackItem(movie), movie);
});

test('ADMIN-03 stale merge preview cannot execute against a new target pair', async () => {
    const { isMergePreviewCurrent } = await import('../src/admin/merge-preview.ts');
    assert.equal(typeof isMergePreviewCurrent, 'function', 'merge preview identity guard must exist');
    const preview = { sourceId: 'source', targetId: 'target-b', requestId: 1, mode: 'merge' };
    assert.equal(isMergePreviewCurrent(preview, 'source', 'target-b', 1, 'merge'), true);
    assert.equal(isMergePreviewCurrent(preview, 'source', 'target-c', 1, 'merge'), false);
    assert.equal(isMergePreviewCurrent(preview, 'source', 'target-b', 2, 'merge'), false);
    assert.equal(isMergePreviewCurrent(preview, 'source', 'target-b', 1, 'move'), false);
});

test('ADMIN-03 execute sends the server preview token and a 409 discards stale UI state', async () => {
    const calls = [];
    const { createAdminApi } = await import('../src/admin/admin-api.ts');
    const admin = createAdminApi({
        session,
        request: async (path, init) => {
            calls.push({ path, init });
            return { counts: {} };
        }
    });
    await admin.mergeUsers('source', 'target', false, 'signed-preview');
    assert.equal(calls[0].path, '/Pgsql/Admin/Users/Merge');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        sourceUserId: 'source',
        targetUserId: 'target',
        previewToken: 'signed-preview'
    });
    assert.equal(calls[0].init.headers.Accept, 'application/json; profile="CamelCase"');

    const users = readFileSync(new URL('../src/admin/pages/admin-users.tsx', import.meta.url), 'utf8');
    assert.match(users, /status\?: unknown[\s\S]*=== 409/);
    assert.match(users, /setMergePreview\(null\); setMergePreviewIdentity\(null\);/);
    assert.match(users, /The users changed since the preview\. Preview again\./);
});
