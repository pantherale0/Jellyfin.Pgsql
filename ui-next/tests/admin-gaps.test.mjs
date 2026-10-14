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

const settings = await import('../src/admin/server-settings.ts');
const stats = await import('../src/admin/playback-stats.ts');
const { tasteRuntimeOverrides } = await import('../src/admin/admin-state.ts');
const { createAdminApi } = await import('../src/admin/admin-api.ts');
const { normalizeBranding, brandingAssets } = await import('../src/branding.ts');

const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

function fakeApi(responses = {}) {
    const calls = [];
    return {
        calls,
        session: { server: 'https://jf.test', token: 't', user: { Id: 'admin-id', Name: 'Admin' }, serverId: 's' },
        request(path, init = {}) {
            calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
            const value = responses[`${init.method || 'GET'} ${path}`];
            return Promise.resolve(typeof value === 'function' ? value() : value);
        },
    };
}

test('field parsing scales units, enforces bounds and keeps nullable blanks', () => {
    const bitrate = settings.STREAMING_FIELDS.find(field => field.scale);
    assert.deepEqual(settings.parseInput(bitrate, '12.5'), { value: 12_500_000 });
    assert.equal(settings.displayValue(bitrate, 12_500_000), '12.5');
    const resume = settings.RESUME_FIELDS[0];
    assert.match(settings.parseInput(resume, '101').error, /at most 100/);
    assert.match(settings.parseInput(resume, '4.5').error, /whole number/);
    assert.match(settings.parseInput(resume, '').error, /required/);
    assert.deepEqual(settings.parseInput({ key: 'x', label: 'X', kind: 'number', nullable: true }, ''), { value: null });
    assert.deepEqual(settings.parseInput({ key: 'x', label: 'X', kind: 'list' }, 'a, b,\nc'), { value: [ 'a', 'b', 'c' ] });
    assert.match(settings.parseInput({ key: 'x', label: 'X', kind: 'select', values: [ 'A', 'B' ] }, 'C').error, /unsupported/);
});

test('changedFields + applyPatch merge only edited dotted paths onto a fresh document', () => {
    const fields = [ { key: 'A', label: 'A', kind: 'number' }, { key: 'Nested.B', label: 'B', kind: 'text' } ];
    const saved = { A: 1, Nested: { B: 'x', Keep: true } };
    const draft = settings.setPath(saved, 'Nested.B', 'y');
    assert.equal(saved.Nested.B, 'x', 'setPath must not mutate its input');
    const patch = settings.changedFields(fields, saved, draft);
    assert.deepEqual(patch, { 'Nested.B': 'y' });
    const fresh = { A: 5, Other: 'server-side', Nested: { B: 'x', Keep: false } };
    assert.deepEqual(settings.applyPatch(fresh, patch), { A: 5, Other: 'server-side', Nested: { B: 'y', Keep: false } });
});

test('saveConfigPatch re-reads the document before posting the merged copy', async () => {
    const api = fakeApi({ 'GET /System/Configuration/livetv': { RecordingPath: '/new', PrePaddingSeconds: 0, TunerHosts: [ { Id: 't1' } ] } });
    await createAdminApi(api).saveConfigPatch('/System/Configuration/livetv', { PrePaddingSeconds: 60 });
    assert.deepEqual(api.calls.map(call => `${call.method} ${call.path}`), [ 'GET /System/Configuration/livetv', 'POST /System/Configuration/livetv' ]);
    assert.deepEqual(api.calls[1].body, { RecordingPath: '/new', PrePaddingSeconds: 60, TunerHosts: [ { Id: 't1' } ] });
});

test('task triggers are built, validated and described', () => {
    const daily = settings.buildTrigger({ type: 'DailyTrigger', time: '03:30', day: '', intervalHours: '', maxRuntimeHours: '2' });
    assert.deepEqual(daily, { Type: 'DailyTrigger', TimeOfDayTicks: 210 * settings.TICKS_PER_MINUTE, MaxRuntimeTicks: 2 * settings.TICKS_PER_HOUR });
    assert.equal(settings.describeTrigger(daily), 'Daily at 03:30 (stops after 2 h)');
    assert.equal(settings.describeTrigger({ Type: 'IntervalTrigger', IntervalTicks: settings.TICKS_PER_HOUR / 2 }), 'Every 30 min');
    assert.equal(settings.describeTrigger({ Type: 'WeeklyTrigger', DayOfWeek: 'Monday', TimeOfDayTicks: 0 }), 'Every Monday at 00:00');
    assert.match(settings.buildTrigger({ type: 'DailyTrigger', time: '25:00', day: '', intervalHours: '', maxRuntimeHours: '' }).error, /HH:MM/);
    assert.match(settings.buildTrigger({ type: 'WeeklyTrigger', time: '01:00', day: 'Funday', intervalHours: '', maxRuntimeHours: '' }).error, /day/);
    assert.match(settings.buildTrigger({ type: 'IntervalTrigger', time: '', day: '', intervalHours: '0.1', maxRuntimeHours: '' }).error, /0.25/);
    assert.deepEqual(settings.buildTrigger({ type: 'StartupTrigger', time: '', day: '', intervalHours: '', maxRuntimeHours: '' }), { Type: 'StartupTrigger' });
});

test('trigger, rename, device and backup requests use the expected endpoints', async () => {
    const api = fakeApi({ 'GET /Users/u1': { Id: 'u1', Name: 'Old', Configuration: { Keep: true } } });
    const admin = createAdminApi(api);
    await admin.updateTaskTriggers('task 1', [ { Type: 'StartupTrigger' } ]);
    await admin.renameUser('u1', 'New');
    await admin.saveDevicePlaybackOptions('dev', { enableHevcEncoding: true });
    await admin.createBackup({ Metadata: true });
    await admin.getBackupManifest('/backups/a b.zip');
    const lines = api.calls.map(call => `${call.method} ${call.path}`);
    assert.deepEqual(lines, [
        'POST /ScheduledTasks/task%201/Triggers', 'GET /Users/u1', 'POST /Users/u1', 'PUT /Devices/Options/Playback?id=dev', 'POST /Backup/Create', 'GET /Backup/Manifest?path=%2Fbackups%2Fa+b.zip',
    ]);
    assert.deepEqual(api.calls[2].body, { Id: 'u1', Name: 'New', Configuration: { Keep: true } });
    assert.match(api.calls[3].headers.Accept, /CamelCase/);
    assert.deepEqual(api.calls[4].body, { Database: true, Metadata: true, Trickplay: false, Subtitles: false });
});

test('device overrides round-trip between stored options and the tri-state form', () => {
    assert.deepEqual(settings.devicePlaybackDraft({ enableHevcEncoding: false, hardwareAccelerationType: 'vaapi', other: null }), { enableHevcEncoding: 'false', hardwareAccelerationType: 'vaapi' });
    assert.deepEqual(settings.devicePlaybackPayload({ allowHevcEncoding: 'true', enableTonemapping: '', maxStreamingBitrate: 8000000, unknownKey: 'x' }), { allowHevcEncoding: true, maxStreamingBitrate: 8000000 });
});

test('access schedules and policy lists are validated', () => {
    assert.equal(settings.validateSchedule({ DayOfWeek: 'Weekday', StartHour: 8, EndHour: 20 }), '');
    assert.match(settings.validateSchedule({ DayOfWeek: 'Weekday', StartHour: 20, EndHour: 8 }), /after/);
    assert.match(settings.validateSchedule({ DayOfWeek: 'Someday', StartHour: 1, EndHour: 2 }), /day/);
    assert.ok(settings.UNRATED_ITEM_KINDS.some(([ kind ]) => kind === 'ChannelContent'));
    assert.equal(new Set(settings.RBAC_PERMISSIONS.map(([ key ]) => key)).size, settings.RBAC_PERMISSIONS.length);
});

test('playback statistics helpers build the heat map and per-user totals', () => {
    const { grid, max } = stats.hourlyGrid([ { DayOfWeek: 1, Hour: 20, PlayCount: 3 }, { DayOfWeek: 1, Hour: 20, PlayCount: 2 }, { DayOfWeek: 9, Hour: 1, PlayCount: 50 } ]);
    assert.equal(grid.length, 7);
    assert.equal(grid[1][20], 5);
    assert.equal(max, 5);
    const totals = stats.userTotals([ { UserId: 'AA-BB', PlayCount: 2, TotalTicks: 36_000_000_000 }, { UserId: 'aabb', PlayCount: 1 }, { UserId: 'gone', PlayCount: 4 } ], [ { Id: 'aabb', Name: 'Ann' } ]);
    assert.deepEqual(totals.map(row => [ row.name, row.plays ]), [ [ 'Deleted user', 4 ], [ 'Ann', 3 ] ]);
    assert.equal(stats.formatPlayed(36_000_000_000), '1.0h');
    assert.equal(stats.formatPlayed(18_000_000_000), '30m');
});

test('taste runtime overrides report only toggles the environment changed', () => {
    const saved = { EnableTasteProfiles: true };
    assert.deepEqual(tasteRuntimeOverrides(saved, { TasteEnabled: false, ShadowTrainingEnabled: false }), { EnableTasteProfiles: { effective: false } });
    assert.deepEqual(tasteRuntimeOverrides(saved, { TasteEnabled: true }), {});
    assert.deepEqual(tasteRuntimeOverrides(saved, null), {});
});

test('login branding is normalized to plain text and anonymous asset URLs', () => {
    const branding = normalizeBranding({ LoginDisclaimer: '  <b>Staff only</b>  ', CustomCss: ' body{} ', SplashscreenEnabled: true });
    assert.deepEqual(branding, { loginDisclaimer: '<b>Staff only</b>', customCss: true, splashscreen: true });
    assert.deepEqual(brandingAssets('https://jf.test/', branding), { cssUrl: 'https://jf.test/Branding/Css.css', splashUrl: 'https://jf.test/Branding/Splashscreen' });
    assert.deepEqual(brandingAssets('https://jf.test', normalizeBranding({ CustomCss: '   ' })), { cssUrl: undefined, splashUrl: undefined });
    const main = source('main.tsx');
    assert.match(main, /<p class="login-disclaimer">\{branding\.loginDisclaimer\}<\/p>/);
    assert.doesNotMatch(main, /dangerouslySetInnerHTML=\{\{ __html: branding/);
});

test('admin pages expose the new settings surfaces', () => {
    const playback = source('admin/pages/admin-playback.tsx');
    assert.match(playback, /RESUME_FIELDS/);
    assert.match(playback, /TRICKPLAY_FIELDS/);
    assert.match(playback, /HourlyHeatmap/);
    assert.match(playback, /getRecentPlayback/);
    assert.match(playback, /SessionDetail/);
    const system = source('admin/pages/admin-system.tsx');
    for (const marker of [ 'GENERAL_FIELDS', 'NETWORK_FIELDS', 'BRANDING_FIELDS', 'DeviceEditor', 'TaskSchedule', 'getBackupManifest', 'waitForRestart' ]) assert.match(system, new RegExp(marker));
    const users = source('admin/pages/admin-users.tsx');
    for (const marker of [ 'renameUser', 'BlockUnratedItems', 'AccessSchedules', 'EnabledChannels', 'EnabledDevices', 'POLICY_FIELDS', 'RBAC_PERMISSIONS' ]) assert.match(users, new RegExp(marker));
    const livetv = source('admin/pages/admin-livetv.tsx');
    for (const marker of [ 'DVR_FIELDS', 'getSeriesTimers', 'cancelSeriesTimer', 'getActiveRecordings', 'deleteItem' ]) assert.match(livetv, new RegExp(marker));
    assert.match(source('admin/pages/admin-infrastructure.tsx'), /LOGGING_FIELDS/);
    assert.match(source('admin/live-log.tsx'), /new Blob/);
    assert.match(source('admin/pages/admin-recommendations.tsx'), /Evaluation history/);
    assert.match(source('admin/pages/admin-plugin-postgres.tsx'), /tasteRuntimeOverrides/);
});

test('userdata-only move previews before committing and never deletes the source', async () => {
    const api = fakeApi({ 'POST /Pgsql/Admin/Users/MoveUserData/Preview': { counts: { UserData: 3 } } });
    const admin = createAdminApi(api);
    assert.deepEqual(await admin.moveUserData('a', 'b'), { counts: { UserData: 3 } });
    await admin.moveUserData('a', 'b', false);
    assert.deepEqual(api.calls.map(call => call.path), [ '/Pgsql/Admin/Users/MoveUserData/Preview', '/Pgsql/Admin/Users/MoveUserData' ]);
    assert.deepEqual(api.calls[1].body, { sourceUserId: 'a', targetUserId: 'b' });
    assert.match(api.calls[0].headers.Accept, /CamelCase/);
    assert.doesNotMatch(source('admin/pages/admin-users.tsx'), /moveUserData\([^)]*\)[^;]*deleteUser/);
});

test('user policy offers the server authentication and password-reset providers', async () => {
    const api = fakeApi({ 'GET /Auth/Providers': [ { Id: 'Default', Name: 'Default' }, { Name: 'no id' } ], 'GET /Auth/PasswordResetProviders': () => Promise.reject(new Error('403')) });
    assert.deepEqual(await createAdminApi(api).getAuthProviders(), { auth: [ [ 'Default', 'Default' ] ], reset: [] });
    assert.ok(settings.POLICY_FIELDS.some(field => field.key === 'AuthenticationProviderId' && field.kind === 'select'));
    assert.match(source('admin/pages/admin-users.tsx'), /AuthenticationProviderId: providers\.auth/);
});
