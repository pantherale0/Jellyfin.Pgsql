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

const c = await import('../src/admin/plugin-catalog.ts');
const { JellyfinRequestError, RequestTimeoutError } = await import('../src/api.ts');
const { createAdminApi } = await import('../src/admin/admin-api.ts');
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');

const TRUSTED = 'https://repo.jellyfin.org/files/plugin/manifest.json';
const THIRD = 'https://plugins.example.net/manifest.json';
const version = (v, repositoryUrl = TRUSTED, extra = {}) => ({ version: v, repositoryUrl, repositoryName: repositoryUrl === TRUSTED ? 'Jellyfin Stable' : 'Example', ...extra });

function fakeApi(responses = {}) {
    const calls = [];
    return {
        calls,
        session: { server: 'https://jf.test', token: 't', user: { Id: 'admin-id', Name: 'Admin' }, serverId: 's' },
        request(path, init = {}, emptyOk, priority) {
            calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, timeoutMs: init.timeoutMs, emptyOk, priority });
            const value = responses[`${init.method || 'GET'} ${path.split('?')[0]}`];
            return Promise.resolve(typeof value === 'function' ? value() : value);
        },
    };
}

test('MISS-33: the package catalog is validated, bounded and sorted newest first', () => {
    const parsed = c.asPackages([
        { guid: 'A1B2C3D4-0000-0000-0000-000000000001', name: ' Trakt ', description: 'Sync', category: 'General', owner: 'jellyfin', imageUrl: 'https://repo.jellyfin.org/img.png', versions: [
            version('1.0.0.0', TRUSTED, { changelog: 'first\u0000', targetAbi: '10.11.0.0', timestamp: '2025-01-01T00:00:00Z' }),
            version('1.2.0.0'), version('not-a-version'), { version: '2.0.0.0' }, version('1.10.0.0'),
        ] },
        { guid: 'a1b2c3d4000000000000000000000001', name: 'Duplicate', versions: [] },
        { guid: 'not-a-guid', name: 'Bad' },
        { guid: 'a1b2c3d4000000000000000000000002', name: '' },
        { guid: 'a1b2c3d4000000000000000000000003', name: 'Insecure image', imageUrl: 'http://example.com/x.png', versions: Array.from({ length: 150 }, (_, i) => version(`1.0.${i}.0`)) },
        { guid: 'a1b2c3d4000000000000000000000004', name: 'x'.repeat(500), description: 'y'.repeat(9000) },
        'junk', null,
    ]);
    assert.deepEqual(parsed.map(p => p.guid), [ 'a1b2c3d4000000000000000000000001', 'a1b2c3d4000000000000000000000003', 'a1b2c3d4000000000000000000000004' ]);
    assert.equal(parsed[0].name, 'Trakt');
    assert.deepEqual(parsed[0].versions.map(v => v.version), [ '1.10.0.0', '1.2.0.0', '1.0.0.0' ]);
    assert.equal(parsed[0].versions[2].changelog, 'first');
    assert.equal(parsed[0].imageUrl, 'https://repo.jellyfin.org/img.png');
    assert.equal(parsed[1].imageUrl, undefined);
    assert.equal(parsed[1].versions.length, 100);
    assert.ok(parsed[2].name.length <= 200 && parsed[2].description.length <= 4000);
    assert.throws(() => c.asPackages({ Items: [] }), /unexpected response/);
    assert.deepEqual(c.asRepositories([ { Name: 'Stable', Url: TRUSTED, Enabled: true }, { Url: THIRD, Enabled: false }, { Name: 'No url' }, 5 ]),
        [ { Name: 'Stable', Url: TRUSTED, Enabled: true }, { Name: THIRD, Url: THIRD, Enabled: false } ]);
    assert.throws(() => c.asRepositories(null), /unexpected response/);
});

test('MISS-33: versions compare numerically and the catalog merges installed plugins by GUID', () => {
    assert.equal(c.compareVersions('1.10.0.0', '1.9.0.0'), 1);
    assert.equal(c.compareVersions('1.0', '1.0.0.0'), 0);
    assert.equal(c.compareVersions('2.0.0.0', '10.0.0.0'), -1);
    assert.equal(c.normalizeGuid('{A1B2C3D4-0000-0000-0000-000000000001}'), 'a1b2c3d4000000000000000000000001');

    const packages = c.asPackages([
        { guid: 'a1b2c3d4000000000000000000000001', name: 'Trakt', versions: [ version('1.2.0.0'), version('1.1.0.0') ] },
        { guid: 'a1b2c3d4000000000000000000000002', name: 'Bookshelf', category: 'Books', versions: [ version('3.0.0.0', THIRD) ] },
        { guid: '27e7ad18-ea71-4b19-b1a9-6e4c2e4d5e18', name: 'Pgsql', versions: [ version('9.0.0.0') ] },
    ]);
    const plugins = [
        { Id: 'A1B2C3D4-0000-0000-0000-000000000001', Name: 'Trakt', Version: '1.1.0.0', Status: 'Active', CanUninstall: true },
        { Id: 'a1b2c3d4000000000000000000000001', Name: 'Trakt', Version: '1.0.0.0', Status: 'Superseded', CanUninstall: true },
        { Id: '27e7ad18ea714b19b1a96e4c2e4d5e18', Name: 'PostgreSQL', Version: '9.0.0.0', Status: 'Active', CanUninstall: true },
        { Id: 'b8715ed16c4745289ad3f72deb539cd4', Name: 'TMDb', Version: '10.11.0.0', Status: 'Active', CanUninstall: false },
    ];
    const rows = c.mergeCatalog(plugins, packages);
    assert.deepEqual(rows.map(r => r.name), [ 'Bookshelf', 'PostgreSQL', 'TMDb', 'Trakt' ]);
    const trakt = rows.find(r => r.name === 'Trakt');
    assert.equal(trakt.installed.Version, '1.1.0.0', 'the active copy wins over a superseded one');
    assert.equal(trakt.updateAvailable, true);
    assert.equal(trakt.latest.version, '1.2.0.0');
    assert.equal(trakt.packageName, 'Trakt');
    assert.equal(c.versionAction(trakt, version('1.2.0.0')), 'update');
    assert.equal(c.versionAction(trakt, version('1.1.0.0')), 'reinstall');
    assert.equal(c.versionAction(trakt, version('1.0.0.0')), 'downgrade');
    const book = rows.find(r => r.name === 'Bookshelf');
    assert.equal(book.installed, undefined);
    assert.equal(c.versionAction(book, book.latest), 'install');
    const pg = rows.find(r => r.name === 'PostgreSQL');
    assert.equal(pg.protected, true);
    assert.equal(pg.updateAvailable, false);
    const tmdb = rows.find(r => r.name === 'TMDb');
    assert.equal(tmdb.bundled, true);
    assert.equal(tmdb.packageName, undefined);
    assert.equal(c.needsRestart([ { Status: 'Active' } ]), false);
    assert.equal(c.needsRestart([ { Status: 'Restart' } ]), true);
});

test('MISS-33: repositories are trusted only on repo.jellyfin.org over https and new ones are validated', () => {
    assert.equal(c.isTrustedRepository(TRUSTED), true);
    assert.equal(c.isTrustedRepository('http://repo.jellyfin.org/manifest.json'), false);
    assert.equal(c.isTrustedRepository('https://repo.jellyfin.org.evil.example/manifest.json'), false);
    assert.equal(c.isTrustedRepository('https://user:pw@repo.jellyfin.org/manifest.json'), false);
    assert.equal(c.isTrustedRepository(THIRD), false);
    assert.equal(c.isTrustedRepository(undefined), false);

    const existing = [ { Name: 'Stable', Url: TRUSTED, Enabled: true } ];
    assert.match(c.validateRepository('', THIRD, existing).error, /name/);
    assert.match(c.validateRepository('X', 'plugins.example.net', existing).error, /full repository address/);
    assert.match(c.validateRepository('X', 'ftp://plugins.example.net/m.json', existing).error, /https:\/\/ or http:\/\//);
    assert.match(c.validateRepository('X', 'https://me:secret@plugins.example.net/m.json', existing).error, /username or password/);
    assert.match(c.validateRepository('X', TRUSTED.toUpperCase().replace('HTTPS', 'https'), existing).error, /already in the list/);
    const ok = c.validateRepository(' Example ', ` ${THIRD} `, existing);
    assert.deepEqual(ok.repository, { Name: 'Example', Url: THIRD, Enabled: true });
    assert.equal(ok.warning, undefined);
    assert.match(c.validateRepository('Plain', 'http://plugins.example.net/m.json', existing).warning, /not encrypted/);
});

test('MISS-33: install failures use fixed wording', () => {
    assert.equal(c.installErrorMessage(new JellyfinRequestError(404, '<b>raw</b>')), 'This version is not available for this server.');
    assert.equal(c.installErrorMessage(new JellyfinRequestError(403, 'raw')), 'Only administrators can install plugins.');
    assert.equal(c.installErrorMessage(new RequestTimeoutError()), 'Still installing on the server…');
    assert.equal(c.installErrorMessage(new JellyfinRequestError(500, 'stack trace')), 'The plugin could not be installed. Check the server log for details.');
});

test('MISS-33: admin API helpers build encoded install, uninstall and repository requests', async () => {
    const api = fakeApi({
        'GET /Packages': [ { guid: 'a1b2c3d4000000000000000000000001', name: 'Trakt', versions: [ version('1.0.0.0') ] }, { bad: true } ],
        'GET /Repositories': [ { Name: 'Stable', Url: TRUSTED, Enabled: true } ],
    });
    const admin = createAdminApi(api);
    assert.equal((await admin.getPackages()).length, 1);
    assert.deepEqual(await admin.getRepositories(), [ { Name: 'Stable', Url: TRUSTED, Enabled: true } ]);
    await admin.installPackage({ name: 'Trakt & Co/x', id: 'a1b2c3d4000000000000000000000001', version: '1.0.0.0', repositoryUrl: THIRD });
    const install = api.calls.find(call => call.path.startsWith('/Packages/Installed/'));
    assert.equal(install.method, 'POST');
    const url = new URL(`https://jf.test${install.path}`);
    assert.equal(url.pathname, '/Packages/Installed/Trakt%20%26%20Co%2Fx');
    assert.equal(url.searchParams.get('assemblyGuid'), 'a1b2c3d4000000000000000000000001');
    assert.equal(url.searchParams.get('version'), '1.0.0.0');
    assert.equal(url.searchParams.get('repositoryUrl'), THIRD);
    assert.equal(install.timeoutMs, 5 * 60_000);
    assert.equal(install.emptyOk, true);
    assert.equal(install.priority, 2);
    await admin.uninstallPlugin('a1b2c3d4000000000000000000000001', '1.0.0.0');
    assert.deepEqual(api.calls.at(-1), { path: '/Plugins/a1b2c3d4000000000000000000000001/1.0.0.0', method: 'DELETE', body: undefined, timeoutMs: undefined, emptyOk: true, priority: 2 });
    await admin.setRepositories([ { Name: 'Stable', Url: TRUSTED, Enabled: false } ]);
    assert.deepEqual(api.calls.at(-1).body, [ { Name: 'Stable', Url: TRUSTED, Enabled: false } ]);
    assert.equal(api.calls.at(-1).path, '/Repositories');
    assert.equal(api.calls.at(-1).method, 'POST');
});

test('MISS-33: the request layer honours a per-request timeout and reports it distinctly', () => {
    const api = source('api.ts');
    assert.match(api, /timeoutMs\?: number;/);
    assert.match(api, /xhr\.timeout = timeoutMs;/);
    assert.match(api, /xhr\.ontimeout = \(\) => settle\(\(\) => reject\(new RequestTimeoutError\(\)\)\)/);
    assert.match(api, /init\.signal, 'json', undefined, init\.timeoutMs\)/);
});

test('MISS-33: the plugins page guards protected plugins, confirms risky installs and offers a restart', () => {
    const page = source('admin/pages/admin-all-plugins.tsx');
    assert.match(page, /\{!row\.protected && \(plugin\.Status === 'Active'/, 'protected plugins have no Disable/Enable');
    assert.match(page, /\{!row\.protected && !row\.bundled && <ConfirmButton label="Uninstall"/, 'protected and bundled plugins have no Uninstall');
    assert.match(page, /if \(!plugin\?\.Id \|\| row\.protected \|\| row\.bundled\) return;/);
    assert.match(page, /if \(action === 'downgrade' \|\| !isTrustedRepository\(version\.repositoryUrl\)\) setPending\(version\);/);
    assert.match(page, /isTrustedRepository\(latest\.repositoryUrl\)\s*\? <ConfirmButton label="Update"/);
    assert.match(page, /e instanceof RequestTimeoutError[\s\S]*waitForInstall\(row\.id, version\.version, gen\)/);
    assert.match(page, /const restartPending = changed \|\| needsRestart\(plugins\);/);
    assert.match(page, /<ConfirmButton label="Restart now" confirmLabel="Restart server" onConfirm=\{restart\} \/>/);
    assert.match(page, /useDialogFocus\(sheet, true, onClose/);
    assert.match(page, /const fresh = await api\.getRepositories\(\);/, 'repository edits re-read the list before saving');
    assert.match(page, /referrerpolicy="no-referrer"/);
    const system = source('admin/pages/admin-system.tsx');
    assert.match(system, /import \{ RESTORE_MESSAGES, waitForRestart \} from '\.\.\/server-restart';/);
    assert.doesNotMatch(system, /async function waitForRestart/);
});
