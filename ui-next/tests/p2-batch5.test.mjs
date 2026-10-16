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

const { JellyfinApi, JellyfinRequestError } = await import('../src/api.ts');

test('AUTH-13 SSO probe separates unavailable from disabled', async () => {
    responses.push({ status: 200, body: JSON.stringify({ enabled: true }) });
    assert.deepEqual(await JellyfinApi.getSsoConfig('https://jellyfin.example.test'), { enabled: true, checked: true, codeExchange: false });
    responses.push({ status: 200, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await JellyfinApi.getSsoConfig('https://jellyfin.example.test'), { enabled: false, checked: true, codeExchange: false });
    responses.push({ status: 500, body: 'proxy failure' });
    assert.deepEqual(await JellyfinApi.getSsoConfig('https://jellyfin.example.test'), { enabled: false, checked: false, codeExchange: false });
});

test('AUTH-14 password login preserves typed status for credential failures', async () => {
    responses.push({ status: 401, body: 'Unauthorized' });
    await assert.rejects(JellyfinApi.login('https://jellyfin.example.test', 'user', 'wrong'), error => error instanceof JellyfinRequestError && error.status === 401);
    responses.push({ status: 200, body: JSON.stringify({ AccessToken: 'token', User: { Id: 'user-id', Name: 'User' }, ServerId: 'server-id' }) });
    const session = await JellyfinApi.login('https://jellyfin.example.test', 'user', 'correct');
    assert.equal(session.token, 'token');
});
