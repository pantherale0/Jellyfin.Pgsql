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
globalThis.localStorage = { getItem: () => null, setItem: () => undefined };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(_method, url) { this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send() {
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

test('AUTH-02 only the current authentication attempt can commit its session', async () => {
    const { AuthAttemptTracker } = await import('../src/login-markers.ts');
    assert.equal(typeof AuthAttemptTracker, 'function', 'authentication attempts need one shared owner');
    const tracker = new AuthAttemptTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    assert.equal(tracker.isCurrent(first), false);
    assert.equal(tracker.isCurrent(second), true);
    tracker.invalidate();
    assert.equal(tracker.isCurrent(second), false);
});

test('AUTH-07 restoration verifies the token owner instead of the requested user', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'User' }, serverId: 'server-id' };
    responses.push({ status: 200, body: JSON.stringify({ Id: 'user-id', Name: 'User' }) });
    assert.deepEqual(await new JellyfinApi(session).getUser(), { Id: 'user-id', Name: 'User' });
    responses.push({ status: 200, body: JSON.stringify({ Id: 'other-user', Name: 'Other' }) });
    await assert.rejects(new JellyfinApi(session).getUser(), error => error.status === 401);
});

test('AUTH-09 malformed remembered storage cannot break the picker', async () => {
    const remembered = await import('../src/remembered-users.ts');
    const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'User' }, serverId: 'server-id' };
    const store = new Map();
    globalThis.localStorage = {
        getItem: key => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, value),
        removeItem: key => store.delete(key)
    };
    store.set('jellyfin-ui-next-remembered-users', JSON.stringify({
        'server-id': [
            { userId: 'user-id', name: 'User', lastSignedIn: 3 },
            { userId: 42, name: null, lastSignedIn: 'yesterday' },
            'not-a-user'
        ],
        'other-server': { userId: 'x' }
    }));
    assert.deepEqual(remembered.getRememberedUsers(session), [
        { userId: 'user-id', name: 'User', lastSignedIn: 3 }
    ]);
    assert.doesNotThrow(() => remembered.rememberUser(session));
    assert.doesNotThrow(() => remembered.clearRememberedToken(session));
});
