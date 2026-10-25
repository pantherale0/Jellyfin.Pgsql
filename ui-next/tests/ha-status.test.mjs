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

const {
    parseHaHeaders, haFromStats, createHaTracker, haChip, haHealthIssues, haEnabled,
    MAX_FAILOVER_EVENTS, FAILOVER_MERGE_MS, FAILOVER_RECENT_MS,
} = await import('../src/ha-status.ts');

const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');
const headerBlock = (role, epoch) => `content-type: application/json\r\nx-jellyfin-ha-role: ${role}\r\nx-jellyfin-leader-epoch: ${epoch}\r\n`;
const stats = (overrides = {}) => ({ HaEnabled: true, HaRole: 'leader', LeaderEpoch: 1, InstanceName: 'node-a', StartedAtUtc: '2026-10-14T10:00:00Z', LeaderSinceUtc: '2026-10-14T10:00:05Z', HaHeartbeatSeconds: 5, ...overrides });

test('parseHaHeaders reads both headers case-insensitively and rejects partial or invalid values', () => {
    assert.deepEqual(parseHaHeaders(headerBlock('leader', 3)), { role: 'leader', epoch: 3 });
    assert.deepEqual(parseHaHeaders('X-Jellyfin-Ha-Role: Standby\nX-Jellyfin-Leader-Epoch: 0'), { role: 'standby', epoch: 0 });
    assert.equal(parseHaHeaders('x-jellyfin-ha-role: leader\r\n'), null);
    assert.equal(parseHaHeaders(headerBlock('primary', 1)), null);
    assert.equal(parseHaHeaders(headerBlock('leader', '-1')), null);
    assert.equal(parseHaHeaders(headerBlock('leader', '1e3')), null);
    assert.equal(parseHaHeaders(''), null);
    assert.equal(parseHaHeaders(null), null);
});

test('haFromStats tolerates older plugin builds and malformed fields', () => {
    assert.equal(haFromStats({ CacheActive: true }), null);
    assert.equal(haFromStats(null), null);
    assert.deepEqual(haFromStats(stats()), {
        enabled: true, role: 'leader', epoch: 1, instanceName: 'node-a',
        startedAt: '2026-10-14T10:00:00Z', leaderSince: '2026-10-14T10:00:05Z', heartbeatSeconds: 5,
    });
    const odd = haFromStats({ HaRole: 'single', LeaderEpoch: 'x', HaHeartbeatSeconds: -2, InstanceName: 42 });
    assert.equal(odd.enabled, false);
    assert.equal(odd.epoch, 0);
    assert.equal(odd.heartbeatSeconds, null);
    assert.equal(odd.instanceName, '');
});

test('tracker records a failover when the leader epoch or role changes', () => {
    let now = 1_000_000;
    const tracker = createHaTracker(() => now);
    let notified = 0;
    tracker.subscribe(() => { notified += 1; });
    tracker.observeHeaders(headerBlock('leader', 1));
    tracker.observeHeaders(headerBlock('leader', 1));
    assert.equal(notified, 1, 'unchanged headers do not notify');
    assert.equal(tracker.snapshot().failovers.length, 0);

    now += 60_000;
    tracker.observeHeaders(headerBlock('leader', 2));
    const [event] = tracker.snapshot().failovers;
    assert.equal(event.from, 'leader · epoch 1');
    assert.equal(event.to, 'leader · epoch 2');
    assert.equal(event.at, now);
});

test('tracker merges header and stats observations of one failover and caps history', () => {
    let now = 0;
    const tracker = createHaTracker(() => now);
    tracker.observeStats(stats());
    tracker.observeHeaders(headerBlock('leader', 1));
    now = 100_000;
    tracker.observeHeaders(headerBlock('leader', 2));
    now += 5_000;
    tracker.observeStats(stats({ InstanceName: 'node-b', StartedAtUtc: '2026-10-14T11:00:00Z' }));
    assert.equal(tracker.snapshot().failovers.length, 1, 'stats change within the merge window is the same failover');

    for (let index = 0; index < MAX_FAILOVER_EVENTS + 5; index += 1) {
        now += FAILOVER_MERGE_MS + 1;
        tracker.observeHeaders(headerBlock('leader', 3 + index));
    }
    assert.equal(tracker.snapshot().failovers.length, MAX_FAILOVER_EVENTS);
    assert.ok(tracker.snapshot().failovers[0].at > tracker.snapshot().failovers[1].at, 'newest first');
});

test('stats identity change (other node or restart) counts as a failover; single instances never do', () => {
    let now = 0;
    const tracker = createHaTracker(() => now);
    tracker.observeStats(stats());
    now = FAILOVER_MERGE_MS * 2;
    tracker.observeStats(stats({ InstanceName: 'node-b' }));
    assert.match(tracker.snapshot().failovers[0].to, /node-b \(leader, epoch 1\)/);

    const single = createHaTracker(() => now);
    single.observeStats(stats({ HaEnabled: false, HaRole: 'single', InstanceName: 'solo' }));
    single.observeHeaders(headerBlock('single', 1));
    now += FAILOVER_MERGE_MS * 2;
    single.observeStats(stats({ HaEnabled: false, HaRole: 'single', InstanceName: 'solo', StartedAtUtc: '2026-10-15T00:00:00Z' }));
    single.observeHeaders(headerBlock('single', 1));
    assert.equal(single.snapshot().failovers.length, 0);
    assert.equal(haEnabled(single.snapshot()), false);
    assert.equal(haChip(single.snapshot()), null);
});

test('headersMissing flags unreadable headers until they appear, and reset clears everything', () => {
    const tracker = createHaTracker(() => 0);
    tracker.observeHeaders('content-type: application/json\r\n');
    assert.equal(tracker.snapshot().headersMissing, true);
    tracker.observeHeaders(headerBlock('standby', 4));
    assert.equal(tracker.snapshot().headersMissing, false);
    tracker.observeHeaders('content-type: text/plain\r\n');
    assert.equal(tracker.snapshot().headersMissing, false, 'one header-less response after a good one is ignored');

    tracker.observeStats(stats());
    tracker.reset();
    assert.deepEqual(tracker.snapshot(), { headers: null, headersMissing: false, stats: null, failovers: [] });
});

test('haChip labels leader with epoch, flags standby, and prefers fresh headers over stats', () => {
    const tracker = createHaTracker(() => 0);
    tracker.observeStats(stats({ LeaderEpoch: 2 }));
    assert.deepEqual(haChip(tracker.snapshot()), { label: 'HA leader · epoch 2', tone: 'ok' });
    tracker.observeHeaders(headerBlock('standby', 2));
    assert.deepEqual(haChip(tracker.snapshot()), { label: 'Standby instance', tone: 'critical' });
});

test('haHealthIssues: standby and not-ready are critical, a recent failover is degraded for ten minutes', () => {
    let now = 0;
    const tracker = createHaTracker(() => now);
    tracker.observeHeaders(headerBlock('leader', 1));
    assert.deepEqual(haHealthIssues(tracker.snapshot(), 'ready', now), []);
    assert.deepEqual(haHealthIssues(tracker.snapshot(), 'not-ready', now).map(issue => issue.severity), ['critical']);

    now = 1_000;
    tracker.observeHeaders(headerBlock('standby', 1));
    const issues = haHealthIssues(tracker.snapshot(), 'unknown', now);
    assert.deepEqual(issues.map(issue => issue.severity), ['critical', 'degraded']);
    assert.match(issues[1].message, /leader · epoch 1 → standby · epoch 1/);
    assert.equal(haHealthIssues(tracker.snapshot(), 'unknown', now + FAILOVER_RECENT_MS).length, 1);

    const single = createHaTracker(() => 0);
    single.observeHeaders(headerBlock('single', 1));
    assert.deepEqual(haHealthIssues(single.snapshot(), 'not-ready', 0), [], 'single instances are not HA-diagnosed');
});

test('transport, admin API and session wiring', () => {
    const api = source('api.ts');
    assert.match(api, /haTracker\.observeHeaders\(xhr\.getAllResponseHeaders\(\)\)/);
    assert.doesNotMatch(api, /getResponseHeader\(/, 'per-header reads log console errors for unexposed headers');
    const admin = source('admin/admin-api.ts');
    assert.match(admin, /haTracker\.observeStats\(stats\)/);
    assert.match(admin, /requestText\('\/health\/ready', 2, 5000\)/);
    assert.match(source('main.tsx'), /haTracker\.reset\(\)/);
    assert.match(source('admin/admin-dashboard.tsx'), /admin-ha-chip/);
    assert.match(source('admin/pages/admin-overview.tsx'), /Leadership headers are not visible from this origin/);
});

test('getHealthReadiness maps 503 to not-ready and other failures to unknown', async () => {
    globalThis.window ??= { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
    const { createAdminApi } = await import('../src/admin/admin-api.ts');
    const fake = outcome => ({
        session: { server: 'https://jellyfin.example.test', token: 't', user: { Id: 'u' } },
        requestText: async () => { if (outcome instanceof Error) throw outcome; return outcome; },
    });
    const withStatus = status => Object.assign(new Error('x'), { status });
    assert.equal(await createAdminApi(fake('Healthy')).getHealthReadiness(), 'ready');
    assert.equal(await createAdminApi(fake(withStatus(503))).getHealthReadiness(), 'not-ready');
    assert.equal(await createAdminApi(fake(withStatus(404))).getHealthReadiness(), 'unknown');
    assert.equal(await createAdminApi(fake(new Error('offline'))).getHealthReadiness(), 'unknown');
});
