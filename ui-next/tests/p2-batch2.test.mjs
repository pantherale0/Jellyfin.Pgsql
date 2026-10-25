import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

beforeEach(() => {
    const store = new Map();
    globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
    globalThis.window = {
        location: new URL('https://jellyfin.example.test/web/index.html?server=https%3A%2F%2Fother.example%2Fjellyfin'),
        history: { replaceState: (_state, _title, url) => { globalThis.window.location = new URL(url, 'https://jellyfin.example.test'); } },
        setTimeout
    };
});

test('AUTH-04 successful logins share one cleanup for the signed-out marker and server query', async () => {
    const { clearLoginMarkers } = await import('../src/login-markers.ts');
    assert.equal(typeof clearLoginMarkers, 'function', 'shared login cleanup must exist');
    globalThis.localStorage.setItem('jellyfin-ui-next-signed-out', 'true');
    clearLoginMarkers();
    assert.equal(globalThis.localStorage.getItem('jellyfin-ui-next-signed-out'), null);
    assert.equal(globalThis.window.location.searchParams.get('server'), null);
});
