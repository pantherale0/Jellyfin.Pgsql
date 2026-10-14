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
const session = {
    server: 'https://jellyfin.example.test', token: 'token',
    user: { Id: 'user-id', Name: 'Admin' }, serverId: 'server-id'
};
const adminApi = () => createAdminApi(new JellyfinApi(session));

test('ADMIN-11 library paths with commas survive as body PathInfos without query splitting', async () => {
    responses.push({ status: 204, body: '' });
    await adminApi().addLibrary('Films', 'movies', ['/media/Films, Classics']);
    const call = requests[0];
    assert.ok(call, 'addLibrary must issue a request');
    assert.ok(!call.url.includes('paths='), `query must not carry comma-joined paths, got ${call.url}`);
    assert.deepEqual(JSON.parse(call.body).LibraryOptions.PathInfos, [{ Path: '/media/Films, Classics' }]);
});

test('ADMIN-04 successful plugin configuration save resolves on empty 204', async () => {
    responses.push({ status: 204, body: '' });
    await adminApi().putB('/Plugins/plugin-id/Configuration', { Enabled: true }, true);
});

test('ADMIN-07 generic plugin booleans map to checkbox controls', async () => {
    const { inferFields } = await import('../src/admin/plugin-fields.ts');
    assert.equal(typeof inferFields, 'function', 'field inference must be testable');
    assert.deepEqual(inferFields({ Enabled: true, Name: 'x', Limit: 3 }), [
        { key: 'Enabled', type: 'bool' },
        { key: 'Name', type: 'string' },
        { key: 'Limit', type: 'number' }
    ]);
    assert.deepEqual(inferFields({ ApiKey: 'secret', apiToken: 'x', Password: 'y' }).map(f => f.type), ['secret', 'secret', 'secret']);
});

test('ADMIN-10 library refresh sends explicit metadata and image modes', async () => {
    responses.push({ status: 204, body: '' });
    await adminApi().refreshLibrary('library-id', 'FullRefresh', 'FullRefresh');
    assert.ok(requests[0].url.includes('metadataRefreshMode=FullRefresh'), `refresh must request metadata mode, got ${requests[0].url}`);
    assert.ok(requests[0].url.includes('imageRefreshMode=FullRefresh'), `refresh must request image mode, got ${requests[0].url}`);
});

test('ADMIN-26 activity log sorts by the valid DateCreated enum', async () => {
    responses.push({ status: 200, body: JSON.stringify({ Items: [], TotalRecordCount: 0 }) });
    await adminApi().getActivityLog();
    assert.ok(requests[0].url.includes('SortBy=DateCreated'), `activity sort must use DateCreated, got ${requests[0].url}`);
});
