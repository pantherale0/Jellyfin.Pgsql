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
    open(_method, url) { this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send() {
        requests.push(this.url);
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
const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'Admin' }, serverId: 'server-id' };
const adminApi = () => createAdminApi(new JellyfinApi(session));

test('ADMIN-09 Seerr status reads the forced lowercase contract', async () => {
    responses.push({ status: 200, body: JSON.stringify({ enabled: true }) });
    assert.deepEqual(await adminApi().getSeerrStatus(), { enabled: true });
    responses.push({ status: 200, body: JSON.stringify({ Enabled: true }) });
    assert.deepEqual(await adminApi().getSeerrStatus(), { enabled: true });
});

test('ADMIN-21 library counts cover audio, books, and videos', async () => {
    for (let i = 0; i < 8; i++) responses.push({ status: 200, body: JSON.stringify({ TotalRecordCount: i + 1 }) });
    assert.deepEqual(await adminApi().getLibraryCounts('parent'), {
        Movies: 1, Series: 2, Episodes: 3, Audio: 9, Books: 6, Videos: 15
    });
});

test('ADMIN-18 admin Live TV inventories page beyond their caps', async () => {
    responses.push({ status: 200, body: JSON.stringify({ Items: [], TotalRecordCount: 250 }) });
    await adminApi().getLiveTvChannels(100, 100);
    assert.ok(requests[0].includes('StartIndex=100'), `channel inventory must page, got ${requests[0]}`);
    assert.ok(requests[0].includes('Limit=100'), `channel inventory must bound pages, got ${requests[0]}`);
});
