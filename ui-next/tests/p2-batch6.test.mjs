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
    open(_method, url) { this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send() {
        requests.push(this.url);
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const sample = () => ({ itemId: 'item', positionSeconds: 0, durationSeconds: 60, paused: false, muted: false, volume: 1, audioStreamIndex: null, subtitleStreamIndex: null, playMethod: 'DirectPlay', startedAtMs: 1000 });
const clock = () => { let now = 1000; const timers = new Map(); let next = 1; return { now: () => now, setTimeout: (fn) => { const id = next++; timers.set(id, fn); return id; }, clearTimeout: id => { timers.delete(id); }, setInterval: (fn) => { const id = next++; timers.set(id, fn); return id; }, clearInterval: id => { timers.delete(id); }, advance: ms => { now += ms; }, fire: id => timers.get(id)?.() }; };

test('PLAY-10 replay after ended restarts reporting', async () => {
    const { PlaybackReporter } = await import('../src/playback-report.ts');
    const calls = [];
    const transport = { start: () => { calls.push('start'); }, progress: () => { calls.push('progress'); }, stop: () => { calls.push('stop'); } };
    const reporter = new PlaybackReporter(sample, transport, clock());
    reporter.start();
    reporter.stop(false);
    assert.deepEqual(calls, ['start', 'stop']);
    reporter.restart();
    assert.deepEqual(calls, ['start', 'stop', 'start']);
    assert.equal(reporter.isStarted, true);
});

test('PLAY-14 trickplay preview carries its actual manifest source', async () => {
    const { pickTrickplay } = await import('../src/player-model.ts');
    const level = { Width: 320, Height: 180, TileWidth: 5, TileHeight: 5, ThumbnailCount: 100, Interval: 10000 };
    const manifest = { 'other-source': { '320': level } };
    const picked = pickTrickplay(manifest, 'chosen-source');
    assert.ok(picked && typeof picked === 'object' && 'level' in picked, 'preview must name its source, not just the level');
    assert.equal(picked.sourceId, 'other-source');
    assert.deepEqual(picked.level, level);
    const exact = pickTrickplay({ 'chosen-source': { '320': level } }, 'chosen-source');
    assert.equal(exact?.sourceId, 'chosen-source');
    assert.equal(pickTrickplay(undefined, 'chosen-source'), null);
});

test('PLAY-17 media URLs use the modern ApiKey parameter', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'Admin' }, serverId: 'server-id' };
    const api = new JellyfinApi(session);
    assert.ok(api.subtitleUrl('item', 'source', 2).includes('ApiKey=token'), `subtitle URL must use ApiKey, got ${api.subtitleUrl('item', 'source', 2)}`);
    assert.ok(api.trickplayTileUrl('item', 320, 4, 'source').includes('ApiKey=token'));
    responses.push({ status: 200, body: JSON.stringify({ MediaSources: [{ Id: 'source', SupportsDirectPlay: true, MediaStreams: [] }], PlaySessionId: 'play' }) });
    const choice = await api.play({ Id: 'movie', Name: 'Movie', Type: 'Movie' });
    assert.ok(choice.url.includes('ApiKey=token'), `stream URL must use ApiKey, got ${choice.url}`);
});
