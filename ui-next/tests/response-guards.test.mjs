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
globalThis.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
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

const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'User' }, serverId: 'server-id' };
const disk = { Path: '/data', UsedSpace: 40, FreeSpace: 60, StorageType: 'ext4' };

test('cultures are always a list of usable languages', async () => {
    const { asCultures } = await import('../src/api-contracts.ts');
    assert.deepEqual(asCultures({ Items: [], TotalRecordCount: 0 }), []);
    assert.deepEqual(asCultures(null), []);
    assert.deepEqual(asCultures([
        { DisplayName: 'English', ThreeLetterISOLanguageName: 'eng', TwoLetterISOLanguageName: 'en' },
        { DisplayName: 'No code' },
        { ThreeLetterISOLanguageName: 'spa' },
        'french',
        null
    ]), [ { DisplayName: 'English', ThreeLetterISOLanguageName: 'eng', TwoLetterISOLanguageName: 'en' } ]);
});

test('countries are always a list of usable regions', async () => {
    const { asCountries } = await import('../src/api-contracts.ts');
    assert.deepEqual(asCountries({ Items: [] }), []);
    assert.deepEqual(asCountries([ { DisplayName: 'United Kingdom', TwoLetterISORegionName: 'GB' }, { DisplayName: 'Nowhere' } ]),
        [ { DisplayName: 'United Kingdom', TwoLetterISORegionName: 'GB' } ]);
});

test('storage keeps valid mounts and omits missing or malformed ones', async () => {
    const { asSystemStorage } = await import('../src/api-contracts.ts');
    const storage = asSystemStorage({
        CacheFolder: disk,
        LogFolder: { Path: '/log', UsedSpace: 'lots', FreeSpace: 1 },
        TranscodingTempFolder: { Path: '/tmp', UsedSpace: -1, FreeSpace: 1 },
        InternalMetadataFolder: null,
        Libraries: [ { Id: 'movies', Name: 'Movies', Folders: [ disk, { Path: '/bad' } ] }, { Name: 'No id' }, 'junk' ]
    });
    assert.deepEqual(storage.CacheFolder, disk);
    for (const key of [ 'LogFolder', 'TranscodingTempFolder', 'InternalMetadataFolder', 'ProgramDataFolder', 'WebFolder', 'ImageCacheFolder' ]) {
        assert.equal(storage[key], undefined, key);
    }
    assert.deepEqual(storage.Libraries, [ { Id: 'movies', Name: 'Movies', Folders: [ disk ] } ]);
    assert.deepEqual(asSystemStorage({ Items: [], TotalRecordCount: 0 }), { Libraries: [] });
    assert.throws(() => asSystemStorage([]), /unexpected format/);
    assert.throws(() => asSystemStorage(null), /unexpected format/);
});

test('the profile language request survives a list-shaped error body', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    responses.push({ status: 200, body: JSON.stringify({ Items: [], TotalRecordCount: 0 }) });
    assert.deepEqual(await new JellyfinApi(session).getCultures(), []);
});

test('admin storage, cultures and countries are normalized at the API boundary', async () => {
    const { createAdminApi } = await import('../src/admin/admin-api.ts');
    const bodies = {
        '/System/Info/Storage': { Items: [], TotalRecordCount: 0 },
        '/Localization/Cultures': { Items: [] },
        '/Localization/Countries': 'nope'
    };
    const admin = createAdminApi({ request: async path => bodies[path] });
    assert.deepEqual(await admin.getSystemStorage(), { Libraries: [] });
    assert.deepEqual(await admin.getCultures(), []);
    assert.deepEqual(await admin.getCountries(), []);
    bodies['/System/Info/Storage'] = 'down';
    await assert.rejects(admin.getSystemStorage(), /unexpected format/);
});
