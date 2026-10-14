import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const state = await import('../src/admin/admin-state.ts');
const { inferFields } = await import('../src/admin/plugin-fields.ts');
const session = {
    server: 'https://jellyfin.example.test', token: 'token',
    user: { Id: 'user-id', Name: 'Admin' }, serverId: 'server-id'
};
const adminApi = () => createAdminApi(new JellyfinApi(session));
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const repo = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const csharpProperties = text => new Set([...text.matchAll(/public\s+[\w<>\[\]?,\s]+?\s+(\w+)\s*\{\s*get;\s*set;/g)].map(m => m[1]));
const draftKeys = text => new Set([
    ...[...text.matchAll(/patch\('(\w+)'/g)].map(m => m[1]),
    ...[...text.matchAll(/draft\.(\w+)/g)].map(m => m[1]),
    ...[...text.matchAll(/(?:\[\[|\], \[)'([A-Z]\w+)', '/g)].map(m => m[1]),
    ...[...text.matchAll(/(?:bool|num)\('(\w+)'/g)].map(m => m[1]),
]);

test('ADMIN-08: admin routes encode once and decode spaces, escapes and malformed input safely', () => {
    assert.equal(state.adminRouteHash('plugin-a b/c'), '#admin/plugin-a%20b%2Fc');
    assert.equal(state.parseAdminRoute('#admin/plugin-a%20b%2Fc'), 'plugin-a b/c');
    assert.equal(state.parseAdminRoute(state.adminRouteHash('plugin-Ünïcode')), 'plugin-Ünïcode');
    assert.equal(state.parseAdminRoute('#admin/%E0%A4%A'), null);
    assert.equal(state.parseAdminRoute('#library'), null);
    assert.equal(state.pluginSection('abc'), 'plugin-abc');
    assert.equal(state.hasConfigurationPage([{ PluginId: 'a' }], 'a'), true);
    assert.equal(state.hasConfigurationPage([{ PluginId: 'a' }], 'b'), false);
    assert.equal(state.hasConfigurationPage([{ PluginId: 'a' }], undefined), false);
    const dashboard = source('src/admin/admin-dashboard.tsx');
    assert.match(dashboard, /parseAdminRoute\(window\.location\.hash\)/);
    assert.doesNotMatch(dashboard, /\[a-z0-9\._-\]/);
    assert.match(source('src/admin/pages/admin-all-plugins.tsx'), /configurablePluginIds\.includes/);
});

test('ADMIN-19: the unsaved-changes guard blocks navigation until confirmed and is scoped to its owner', () => {
    assert.equal(state.confirmLeave(() => { throw new Error('should not ask'); }), true);
    const release = state.registerUnsavedGuard(() => true);
    assert.equal(state.hasUnsavedChanges(), true);
    assert.equal(state.confirmLeave(() => false), false);
    assert.equal(state.hasUnsavedChanges(), true);
    const replaced = state.registerUnsavedGuard(() => true);
    release();
    assert.equal(state.hasUnsavedChanges(), true, 'a stale release must not clear a newer guard');
    assert.equal(state.confirmLeave(() => true), true);
    assert.equal(state.hasUnsavedChanges(), false);
    replaced();
    const shell = source('src/admin/plugin-shell.tsx');
    assert.match(shell, /registerUnsavedGuard/);
    assert.doesNotMatch(shell, /unsaved-discard/);
    assert.match(source('src/admin/admin-dashboard.tsx'), /confirmLeave\(/);
});

test('ADMIN-01: plugin drafts are saveable only once their own configuration loaded', () => {
    assert.equal(state.canSavePluginDraft('', 'plugin-a'), false);
    assert.equal(state.canSavePluginDraft(null, 'plugin-a'), false);
    assert.equal(state.canSavePluginDraft('plugin-b', 'plugin-a'), false);
    assert.equal(state.canSavePluginDraft('plugin-a', 'plugin-a'), true);
    for (const page of ['generic', 'postgres', 'tmdb', 'seerr']) {
        const text = source(`src/admin/pages/admin-plugin-${page}.tsx`);
        assert.match(text, /canSavePluginDraft\(loadedId, plugin\.Id\)/, page);
        assert.match(text, /loaded=\{canSavePluginDraft/, page);
        assert.match(text, /onDiscard=\{discard\}/, page);
    }
    const router = source('src/admin/admin-dashboard.tsx');
    assert.match(router, /let active = true;\s*setPlugin\(null\);/);
});

test('ADMIN-12/14: failed reads reject instead of becoming empty inventory', async () => {
    const api = adminApi();
    responses.push({ status: 500, body: 'Plugin manager failed' });
    await assert.rejects(api.getPlugins(), /Plugin manager failed/);
    responses.push({ status: 500, body: 'boom' });
    await assert.rejects(api.getLogs());
    responses.push({ status: 500, body: 'boom' });
    await assert.rejects(api.getLiveTvInfo());
    responses.push({ status: 500, body: 'boom' });
    await assert.rejects(api.getLiveTvChannels());

    const ok = await state.settle(Promise.resolve(3), 'x');
    const failed = await state.settle(Promise.reject(new Error('Sessions down')), 'fallback');
    const silent = await state.settle(Promise.reject('nope'), 'fallback');
    assert.deepEqual(ok, { ok: true, value: 3 });
    assert.deepEqual(failed, { ok: false, error: 'Sessions down' });
    assert.deepEqual(silent, { ok: false, error: 'fallback' });
    assert.deepEqual(state.resourceErrors({ Sessions: failed, Channels: ok }), ['Sessions: Sessions down']);
    assert.match(source('src/admin/pages/admin-overview.tsx'), /settle\(api\.getSessions\(\)/);
    assert.match(source('src/admin/pages/admin-libraries.tsx'), /setLoadError\(/);
    assert.match(source('src/admin/pages/admin-playback.tsx'), /setSessionsError\(/);
    assert.match(source('src/admin/pages/admin-livetv.tsx'), /resourceErrors\(/);
    assert.match(source('src/admin/pages/admin-all-plugins.tsx'), /await load\(\);\s*setMessage/);
});

test('ADMIN-13: task actions report failures and refresh state on both task views', async () => {
    const api = adminApi();
    responses.push({ status: 500, body: 'Task already running' });
    await assert.rejects(api.startTask('task-1'), /Task already running/);
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].url, /\/ScheduledTasks\/Running\/task-1$/);
    for (const page of ['admin-system', 'admin-infrastructure']) {
        const text = source(`src/admin/pages/${page}.tsx`);
        assert.match(text, /await api\.startTask\(t\.Id\); await load\(\); \} catch \(e\) \{ setTaskError/, page);
        assert.match(text, /await api\.stopTask\(t\.Id\); await load\(\); \} catch \(e\) \{ setTaskError/, page);
    }
});

test('ADMIN-15: live logs append only new text, join partial lines, handle rotation and cap retention', () => {
    let tail = state.appendLogText({ lines: [], length: 0 }, 'a\nb\npart');
    assert.deepEqual(tail.lines, ['a', 'b', 'part']);
    const same = state.appendLogText(tail, 'a\nb\npart');
    assert.equal(same, tail, 'unchanged files keep the same state object');
    tail = state.appendLogText(tail, 'a\nb\npartial\nc\n');
    assert.deepEqual(tail.lines, ['a', 'b', 'partial', 'c']);
    tail = state.appendLogText(tail, 'new\n');
    assert.deepEqual(tail.lines, ['new'], 'a shorter file is treated as rotated');
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n');
    const capped = state.appendLogText({ lines: [], length: 0 }, big);
    assert.equal(capped.lines.length, state.LOG_LINE_LIMIT);
    assert.equal(capped.lines[capped.lines.length - 1], 'line 2499');
    const grown = state.appendLogText(capped, `${big}\nline 2500`);
    assert.equal(grown.lines.length, state.LOG_LINE_LIMIT);
    assert.equal(grown.lines[grown.lines.length - 1], 'line 2500');

    const parsed = state.parseLogLine('[2026-10-14 12:00:01.123 +00:00] [ERR] [12] Emby.Server: Failure');
    assert.equal(parsed.ts, '2026-10-14 12:00:01.123 +00:00');
    assert.equal(parsed.severity, 'ERROR');
    assert.equal(parsed.rest, '[12] Emby.Server: Failure');
    assert.equal(state.parseLogLine('[2026-10-14 12:00:01.123 +00:00] [WRN] x').severity, 'WARN');
    assert.equal(state.parseLogLine('plain text').severity, 'INFO');
    const viewer = source('src/admin/live-log.tsx');
    assert.match(viewer, /appendLogText\(tail\.current, text\)/);
    assert.match(viewer, /request !== generation\.current/);
});

test('ADMIN-17: API keys can be revealed and copied, and creation explains how', () => {
    const text = source('src/admin/pages/admin-system.tsx');
    assert.match(text, /navigator\.clipboard\?\.writeText/);
    assert.match(text, /copiedKey === k\.AccessToken \? <code/);
    assert.match(text, /Use Copy on its row to reveal and copy the token/);
});

test('ADMIN-20: generic plugin secrets are masked', () => {
    const fields = inferFields({ ApiKey: 'x', Api_Key: 'x', ServerPassword: 'x', AccessToken: 'x', RedisConnectionString: 'x', ClientSecret: 'x', Url: 'x', Enabled: true, Port: 1 });
    const types = Object.fromEntries(fields.map(f => [f.key, f.type]));
    for (const key of ['ApiKey', 'Api_Key', 'ServerPassword', 'AccessToken', 'RedisConnectionString', 'ClientSecret']) assert.equal(types[key], 'secret', key);
    assert.equal(types.Url, 'string');
    assert.equal(types.Enabled, 'bool');
    assert.equal(types.Port, 'number');
    assert.match(source('src/admin/pages/admin-plugin-generic.tsx'), /f\.type === 'secret' \? <input type="password"/);
});

test('ADMIN-22: scan status shows percentage and polls only while scanning or shortly after a request', () => {
    assert.deepEqual(state.libraryStatusLabel({ RefreshStatus: 'Active', RefreshProgress: 41.6 }), { text: 'Scanning 42%', tone: 'blue' });
    assert.deepEqual(state.libraryStatusLabel({ RefreshStatus: 'Idle' }), { text: 'Idle', tone: 'green' });
    assert.deepEqual(state.libraryStatusLabel({}), { text: 'Idle', tone: 'green' });
    assert.equal(state.libraryStatusLabel({ RefreshStatus: 'Failed' }).tone, 'red');
    assert.equal(state.isLibraryScanning([{ RefreshStatus: 'Idle' }, { RefreshProgress: 3 }]), true);
    assert.equal(state.isLibraryScanning([{ RefreshStatus: 'Idle' }]), false);
    assert.equal(state.scanPollDelay(true, 0, 1000), 3000);
    assert.equal(state.scanPollDelay(false, 1000, 30_000), 5000);
    assert.equal(state.scanPollDelay(false, 1000, 120_000), null);
    assert.equal(state.scanPollDelay(false, 0, 1000), null);
});

test('ADMIN-23: the plugin catalog route is never treated as a missing plugin page', () => {
    const text = source('src/admin/admin-dashboard.tsx');
    assert.match(text, /isPlugin\(section\) && section !== 'plugins' && !activePlugin/);
    assert.match(text, /const activePlugin = isPlugin\(section\) && section !== 'plugins'/);
});

test('ADMIN-24: diagnostics use reported SystemInfo fields and network config ports', () => {
    for (const path of ['src/admin/admin-dashboard.tsx', 'src/admin/pages/admin-system.tsx', 'src/admin/pages/admin-infrastructure.tsx', 'src/admin/types.ts']) {
        const text = source(path);
        assert.doesNotMatch(text, /RunTimeTicks \/|sys\??\.RunTimeTicks|OperatingSystemDisplayName|sys\??\.HttpsPort|sys\??\.InternalHttpPort/, path);
    }
    const infra = source('src/admin/pages/admin-infrastructure.tsx');
    assert.match(infra, /network\?\.InternalHttpPort/);
    const reported = csharpProperties(repo('jellyfin/MediaBrowser.Model/System/SystemInfo.cs') + repo('jellyfin/MediaBrowser.Model/System/PublicSystemInfo.cs'));
    const types = source('src/admin/types.ts');
    const block = types.slice(types.indexOf('export interface SystemInfo'), types.indexOf('}', types.indexOf('export interface SystemInfo')));
    for (const [, key] of block.matchAll(/(\w+)\?:/g)) assert.ok(reported.has(key), `SystemInfo.${key} is not reported by the server`);
});

test('ADMIN-25: activity severity filters and alerts follow LogLevel names', () => {
    assert.deepEqual([...state.ACTIVITY_SEVERITIES], ['All', 'Critical', 'Error', 'Warning']);
    assert.equal(state.activitySeverityParam('Critical'), 'Critical');
    assert.equal(state.activitySeverityParam('Warning'), 'Warning');
    assert.equal(state.activitySeverityParam('All'), undefined);
    assert.equal(state.isErrorSeverity('Critical'), true);
    assert.equal(state.isErrorSeverity('Error'), true);
    assert.equal(state.isErrorSeverity('Fatal'), false);
    for (const path of ['src/admin/pages/admin-activity.tsx', 'src/admin/pages/admin-overview.tsx']) assert.doesNotMatch(source(path), /Fatal/, path);
});

test('ADMIN-02: Emby import executes only the previewed mapping from the current upload', () => {
    const discovered = [{ id: 1 }, { id: 2 }];
    assert.equal(state.embyImportMapping('s1', [9], discovered, 'target'), null, 'stale numeric ids are dropped');
    assert.equal(state.embyImportMapping('', [1], discovered, 'target'), null);
    assert.equal(state.embyImportMapping('s1', [1], discovered, ''), null);
    const preview = state.embyImportMapping('s1', [1, 9, 2], discovered, 'target');
    assert.deepEqual(preview, { sessionId: 's1', sourceUserIds: [1, 2], targetUserId: 'target' });
    assert.equal(state.sameEmbyImportMapping(preview, state.embyImportMapping('s1', [1, 2], discovered, 'target')), true);
    assert.equal(state.sameEmbyImportMapping(preview, state.embyImportMapping('s1', [1], discovered, 'target')), false);
    assert.equal(state.sameEmbyImportMapping(preview, state.embyImportMapping('s2', [1, 2], discovered, 'target')), false);
    assert.equal(state.sameEmbyImportMapping(preview, state.embyImportMapping('s1', [1, 2], discovered, 'other')), false);
    assert.equal(state.sameEmbyImportMapping(preview, null), false);
    const users = source('src/admin/pages/admin-users.tsx');
    assert.match(users, /api\.executeEmbyImport\(importMapping\.sessionId, importMapping\.sourceUserIds, importMapping\.targetUserId\)/);
    assert.match(users, /setImportMapping\(null\);\s*\};/);
});

test('ADMIN user deletion cannot remove the signed-in user or the last enabled administrator', () => {
    const users = [
        { Id: 'admin', Policy: { IsAdministrator: true, IsDisabled: false } },
        { Id: 'disabled-admin', Policy: { IsAdministrator: true, IsDisabled: true } },
        { Id: 'viewer', Policy: { IsAdministrator: false } },
    ];
    assert.equal(state.canDeleteAdminUser(users[0], 'admin', users), false);
    assert.equal(state.canDeleteAdminUser(users[0], 'other', users), false);
    assert.equal(state.canDeleteAdminUser(users[1], 'other', users), true);
    assert.equal(state.canDeleteAdminUser(users[2], 'other', users), true);
    const page = source('src/admin/pages/admin-users.tsx');
    assert.match(page, /canDeleteAdminUser\(selected, session\.user\.Id, users\)/);
    assert.match(page, /const currentUsers = await api\.getUsers\(\)/);
    assert.match(page, /const currentTarget = currentUsers\.find\(user => user\.Id === selected\.Id\)/);
    assert.match(page, /canDeleteAdminUser\(currentTarget, session\.user\.Id, currentUsers\)/);
});

test('ADMIN-27: admins set real passwords; clearing is not offered for administrators', async () => {
    assert.equal(state.validateNewPassword('', ''), 'Enter a new password.');
    assert.equal(state.validateNewPassword('a', 'b'), 'The passwords do not match.');
    assert.equal(state.validateNewPassword('secret', 'secret'), '');
    const api = adminApi();
    responses.push({ status: 204, body: '' });
    await api.setUserPassword('user 2', 'n3w');
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].url, /\/Users\/Password\?userId=user%202$/);
    assert.deepEqual(JSON.parse(requests[0].body), { NewPw: 'n3w' });
    const users = source('src/admin/pages/admin-users.tsx');
    assert.match(users, /selected\.IsAdministrator\s*\?\s*<p class="ad-note">Clearing the password is unavailable/);
    assert.match(users, /selected\.Id !== session\.user\.Id && <form class="ad-password-form"/);
});

test('ADMIN-28: session controls respect remote-control capability and use the session command endpoints', async () => {
    assert.deepEqual(state.sessionControls({}), { canControl: false, isPaused: false, reason: 'Nothing is playing' });
    assert.equal(state.sessionControls({ NowPlayingItem: {}, SupportsRemoteControl: false }).canControl, false);
    assert.deepEqual(state.sessionControls({ NowPlayingItem: {}, SupportsRemoteControl: true, PlayState: { IsPaused: true } }), { canControl: true, isPaused: true, reason: '' });
    const api = adminApi();
    responses.push({ status: 204, body: '' }, { status: 204, body: '' }, { status: 204, body: '' });
    await api.pausePlayback('s 1');
    await api.resumePlayback('s 1');
    await api.sendSessionMessage('s 1', 'Server restarting');
    assert.match(requests[0].url, /\/Sessions\/s%201\/Playing\/Pause$/);
    assert.match(requests[1].url, /\/Sessions\/s%201\/Playing\/Unpause$/);
    assert.match(requests[2].url, /\/Sessions\/s%201\/Message$/);
    assert.deepEqual(JSON.parse(requests[2].body), { Header: 'Message from administrator', Text: 'Server restarting', TimeoutMs: 10000 });
    responses.push({ status: 500, body: 'Session not found' });
    await assert.rejects(api.stopPlayback('gone'), /Session not found/);
    assert.match(source('src/admin/pages/admin-overview.tsx'), /<SessionControls session=\{s\} api=\{api\} \/>/);
    assert.match(source('src/admin/pages/admin-playback.tsx'), /<SessionControls session=\{s\} api=\{api\} onChanged=\{load\} \/>/);
    assert.doesNotMatch(source('src/admin/pages/admin-overview.tsx'), /catch \{\}/);
});

test('ADMIN-05: PostgreSQL controls map to real plugin settings and surface environment overrides', () => {
    const schema = csharpProperties(repo('Jellyfin.Plugin.Pgsql/Configuration/PluginConfiguration.cs'));
    const keys = draftKeys(source('src/admin/pages/admin-plugin-postgres.tsx'));
    assert.ok(keys.size >= 15);
    for (const key of keys) assert.ok(schema.has(key), `PostgreSQL page edits unknown property ${key}`);
    for (const key of schema) assert.ok(keys.has(key), `PostgreSQL page does not expose ${key}`);
    const saved = { CacheBackend: 'Redis', LatestCacheTtlSeconds: 120, BrowseCacheTtlSeconds: 60, OptimizeNextUpQueries: true };
    const stats = { CacheBackend: 'memory', LatestTtlSeconds: 120, BrowseTtlSeconds: 10, OptimizeNextUp: true };
    assert.deepEqual(state.pgsqlEnvironmentOverrides(saved, stats), {
        CacheBackend: { envVar: 'Pgsql_CACHE_BACKEND', effective: 'memory' },
        BrowseCacheTtlSeconds: { envVar: 'Pgsql_CACHE_BROWSE_TTL', effective: 10 },
    });
    assert.deepEqual(state.pgsqlEnvironmentOverrides(saved, null), {});
});

test('ADMIN-06: TMDb controls map to the provider configuration including library opt-in', () => {
    const schema = csharpProperties(repo('jellyfin/MediaBrowser.Providers/Plugins/Tmdb/Configuration/PluginConfiguration.cs'));
    const keys = draftKeys(source('src/admin/pages/admin-plugin-tmdb.tsx'));
    assert.ok(keys.has('EnabledMissingEpisodeLibraries'));
    for (const key of keys) assert.ok(schema.has(key), `TMDb page edits unknown property ${key}`);
    for (const key of schema) assert.ok(keys.has(key), `TMDb page does not expose ${key}`);
});

test('ADMIN-09 follow-up: Seerr controls map to the Seerr plugin configuration', () => {
    const schema = csharpProperties(repo('Jellyfin.Plugin.Seerr/Configuration/PluginConfiguration.cs'));
    const keys = draftKeys(source('src/admin/pages/admin-plugin-seerr.tsx'));
    for (const key of keys) assert.ok(schema.has(key), `Seerr page edits unknown property ${key}`);
    for (const key of schema) assert.ok(keys.has(key), `Seerr page does not expose ${key}`);
});
