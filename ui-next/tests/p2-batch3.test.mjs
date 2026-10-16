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

test('LIVE-05 recording completion updates only the submitted program sheet', async () => {
    const { withRecordingPending } = await import('../src/live-model.ts');
    assert.equal(typeof withRecordingPending, 'function', 'sheet-bound recording update must exist');
    const sheet = { program: { Id: 'program-a', Name: 'A' }, channel: { Id: 'channel', Name: 'C' } };
    const updated = withRecordingPending(sheet, 'program-a', false);
    assert.equal(updated?.program.TimerId, 'pending');
    assert.equal(withRecordingPending(sheet, 'program-b', false), sheet);
    assert.equal(withRecordingPending(null, 'program-a', false), null);
    const series = withRecordingPending(sheet, 'program-a', true);
    assert.equal(series?.program.SeriesTimerId, 'pending');
});

test('LIVE-06 live badge follows the broadcast IsLive flag', async () => {
    const { programBadges } = await import('../src/live-model.ts');
    const now = Date.parse('2026-10-14T22:15:00.000Z');
    const live = { Id: 'a', StartDate: '2026-10-14T22:00:00.000Z', EndDate: '2026-10-14T23:00:00.000Z', IsLive: true };
    const rerun = { ...live, Id: 'b', IsLive: false };
    assert.ok(programBadges(live, now).includes('live'));
    assert.ok(!programBadges(rerun, now).includes('live'), 'a rerun airing now must not carry the live badge');
});

test('PLAY-11 and PLAY-13 media and select keys classify to explicit player actions', async () => {
    const { classifyPlayerKey } = await import('../src/player-model.ts');
    assert.equal(typeof classifyPlayerKey, 'function', 'player key classifier must exist');
    assert.equal(classifyPlayerKey('MediaStop', 413), 'stop');
    assert.equal(classifyPlayerKey('MediaPlayPause', 10252), 'toggle');
    assert.equal(classifyPlayerKey('MediaPlay', 415), 'play');
    assert.equal(classifyPlayerKey('MediaPause', 0), 'pause');
    assert.equal(classifyPlayerKey('Enter', 13), 'select');
    assert.equal(classifyPlayerKey('ArrowLeft', 37), null);

    const player = readFileSync(new URL('../src/player.tsx', import.meta.url), 'utf8');
    assert.match(player, /\[ 'stop', \(\) => \{ rememberPosition\(video\); onBackRef\.current\(\); \} \]/, 'OS Stop remembers the current position before leaving');
    assert.match(player, /actions\.forEach\(\(\[ action \]\) => setHandler\(action, null\)\)/, 'video MediaSession handlers are cleared on exit');
    assert.match(player, /if \(action === 'stop'\) \{\s+withVideo\(rememberPosition\);\s+onBackRef\.current\(\);/, 'MediaStop key follows the same position-preserving leave path');
});
