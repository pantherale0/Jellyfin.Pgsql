import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const responses = [];
beforeEach(() => { responses.length = 0; });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
globalThis.XMLHttpRequest = class {
    open(_method, url) { this.responseURL = url; }
    setRequestHeader() {}
    send() {
        const response = responses.shift();
        assert.ok(response, 'each request must have an explicit HTTP response');
        queueMicrotask(() => {
            if (response.networkError) {
                this.onerror();
                return;
            }
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};
const { JellyfinApi } = await import('../src/api.ts');
const session = {
    server: 'https://jellyfin.example.test', token: 'rejected-token',
    user: { Id: 'user-id', Name: 'Jordan' }, serverId: 'server-id'
};

test('an authenticated 401 notifies the session owner even when the server returns an error body', async () => {
    let invalidations = 0;
    const api = new JellyfinApi(session, () => { invalidations++; });
    responses.push({ status: 401, body: 'Token is no longer valid.' });
    await assert.rejects(api.getViews(), error => error.status === 401 && error.message === 'Your session expired. Sign in again.');
    assert.equal(invalidations, 1);
});

test('concurrent rejected requests invalidate their session only once', async () => {
    let invalidations = 0;
    const api = new JellyfinApi(session, () => { invalidations++; });
    responses.push({ status: 401, body: '' }, { status: 401, body: '' }, { status: 401, body: '' });
    const results = await Promise.allSettled([api.getViews(), api.getResumeItems(), api.getLatestItems()]);
    assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected', 'rejected']);
    assert.equal(invalidations, 1);
});

test('permission and server errors preserve the session and retain their actual HTTP status', async () => {
    let invalidations = 0;
    const api = new JellyfinApi(session, () => { invalidations++; });
    responses.push({ status: 403, body: 'Access denied.' }, { status: 500, body: 'Upstream failure (401).' });
    await assert.rejects(api.getViews(), error => error.status === 403 && error.message === 'Access denied.');
    await assert.rejects(api.getViews(), error => error.status === 500 && error.message === 'Upstream failure (401).');
    assert.equal(invalidations, 0);
});

test('the startup user check invalidates an already-revoked saved session', async () => {
    let invalidations = 0;
    const api = new JellyfinApi(session, () => { invalidations++; });
    responses.push({ status: 401, body: '' });
    await assert.rejects(api.getUser(), error => error.status === 401);
    assert.equal(invalidations, 1);
});

test('text requests also invalidate rejected authenticated sessions', async () => {
    let invalidations = 0;
    const api = new JellyfinApi(session, () => { invalidations++; });
    responses.push({ status: 401, body: '' });
    await assert.rejects(api.requestText('/System/Logs/Log?name=test.log'), error => error.status === 401);
    assert.equal(invalidations, 1);
});

test('network failures preserve a session that has not been rejected by the server', async () => {
    let invalidations = 0;
    const api = new JellyfinApi(session, () => { invalidations++; });
    responses.push({ networkError: true });
    await assert.rejects(api.getViews(), /Could not reach the Jellyfin server/);
    assert.equal(invalidations, 0);
});

test('playback-report failures recover a rejected session despite suppressing report errors', async () => {
    let invalidations = 0;
    const api = new JellyfinApi(session, () => { invalidations++; });
    responses.push({ status: 401, body: '' });
    await api.reportPlaybackProgress({ ItemId: 'item-id', PositionTicks: 100 });
    assert.equal(invalidations, 1);
});
