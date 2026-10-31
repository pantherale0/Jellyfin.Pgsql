import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requests = [];
const responses = [];
beforeEach(() => { requests.length = 0; responses.length = 0; });
globalThis.window = globalThis.window || { location: { href: 'https://host/jellyfin/web/' }, setTimeout, clearTimeout, setInterval, clearInterval };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => undefined };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send(body) {
        requests.push({ method: this.method, url: this.url, body });
        const response = responses.shift() || { status: 204, body: '' };
        queueMicrotask(async () => {
            if (response.wait) await response.wait;
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const session = {
    server: 'https://host/jellyfin',
    token: 'token',
    user: { Id: 'user-id', Name: 'Viewer' },
    serverId: 'server-id'
};
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');

async function tracker() {
    const { AccountGeneration } = await import('../src/account-generation.ts');
    const { NavigationOwner } = await import('../src/navigation-owner.ts');
    const { PlaybackSessionTracker } = await import('../src/playback-session.ts');
    const account = new AccountGeneration();
    return new PlaybackSessionTracker(account, new NavigationOwner(account));
}

test('PLAY ownership only the current session can commit a stream', async () => {
    const sessions = await tracker();
    const first = sessions.begin('movie-a');
    const second = sessions.begin('movie-b');

    assert.equal(sessions.isCurrent(first), false);
    assert.equal(sessions.commit(first, { mediaSourceId: 'old' }), null);
    const committed = sessions.commit(second, { mediaSourceId: 'new', playSessionId: 'play', liveStreamId: 'live-1' });
    assert.equal(committed?.mediaSourceId, 'new');
    assert.deepEqual(sessions.active(), committed);
});

test('committed playback survives the navigation handoff into the player', async () => {
    const { AccountGeneration } = await import('../src/account-generation.ts');
    const { NavigationOwner } = await import('../src/navigation-owner.ts');
    const { PlaybackSessionTracker } = await import('../src/playback-session.ts');
    const account = new AccountGeneration();
    const navigation = new NavigationOwner(account);
    const sessions = new PlaybackSessionTracker(account, navigation);
    const pending = sessions.begin('movie');
    const active = sessions.commit(pending, { mediaSourceId: 'source' });
    assert.equal(sessions.isCurrent(pending), true, 'the accepted request can release its loading state');
    navigation.retire();
    assert.equal(sessions.isCurrent(active), true);
    assert.equal(sessions.canRefresh(active), true);
    account.invalidate();
    assert.equal(sessions.isCurrent(active), false);
    assert.equal(sessions.canRefresh(active), false);
});

test('failed replacement leaves the playing session alive and superseded replacements cannot commit', async () => {
    const sessions = await tracker();
    const active = sessions.commit(sessions.begin('movie'), { mediaSourceId: 'original' });
    const first = sessions.begin('movie');
    const second = sessions.begin('movie');
    assert.equal(sessions.commit(first, { mediaSourceId: 'obsolete' }), null);
    sessions.retire(second);
    assert.equal(sessions.isCurrent(active), true);
    assert.equal(sessions.active().mediaSourceId, 'original');
});

test('concurrent stops share delivery and a false acknowledgment remains false', async () => {
    const { PlaybackReporter } = await import('../src/playback-report.ts');
    let finish;
    let count = 0;
    const sample = () => ({ itemId: 'i', positionSeconds: 1, durationSeconds: 10, paused: false, muted: false, volume: 1, audioStreamIndex: null, subtitleStreamIndex: null, playMethod: 'DirectPlay', startedAtMs: 1 });
    const reporter = new PlaybackReporter(sample, { start: () => {}, progress: () => {}, stop: () => { count++; return new Promise(resolve => { finish = resolve; }); } });
    reporter.start();
    const first = reporter.stopAsync();
    const second = reporter.stopAsync();
    finish(false);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(count, 1);
});

test('PLAY ownership retires sessions on leave, account, and route changes', async () => {
    const sessions = await tracker();
    const active = sessions.begin('movie-a');
    sessions.retire(active);
    assert.equal(sessions.active(), null);
    assert.equal(sessions.isCurrent(active), false);

    const stale = sessions.begin('movie-b');
    sessions.retire();
    assert.equal(sessions.isCurrent(stale), false);
});

test('live cleanup is per acquired session and cannot close a retained stream', async () => {
    const sessions = await tracker();
    const first = sessions.commit(sessions.begin('channel'), { liveStreamId: 'live-1' });
    const next = sessions.commit(sessions.begin('channel'), { liveStreamId: 'live-1' }, 'live-1');
    assert.equal(sessions.claimLiveCleanup(first), false);
    sessions.retire();
    assert.equal(sessions.claimLiveCleanup(next), true);
    assert.equal(sessions.claimLiveCleanup(next), false);
    assert.equal(sessions.claimLiveCleanup(first), false, 'retired loads share the retained lease cleanup');
    const another = sessions.commit(sessions.begin('channel'), { liveStreamId: 'live-1' });
    sessions.retire();
    assert.equal(sessions.claimLiveCleanup(another), true);
    assert.equal(sessions.liveStreamFor(another), 'live-1');
    sessions.markLiveReleased(another);
    assert.equal(sessions.liveStreamFor(another), undefined);
});

test('PLAY reporter stop reports delivery without resending the stop', async () => {
    const { PlaybackReporter } = await import('../src/playback-report.ts');
    const calls = [];
    const read = () => ({ itemId: 'i', positionSeconds: 1, durationSeconds: 10, paused: false, muted: false, volume: 1, audioStreamIndex: null, subtitleStreamIndex: null, playMethod: 'DirectPlay', startedAtMs: 1 });
    const reporter = new PlaybackReporter(read, { start: () => undefined, progress: () => undefined, stop: () => { calls.push('stop'); return Promise.resolve(true); } });

    reporter.start();
    assert.equal(await reporter.stopAsync(false), true);
    assert.equal(await reporter.stopAsync(false), true);
    assert.deepEqual(calls, [ 'stop' ]);
});

test('progressive resume uses one item timeline and copy-timestamp streams are not double-offset', async () => {
    const { startPlan, itemPosition, mediaPosition } = await import('../src/player-model.ts');
    assert.deepEqual(startPlan('https://h/stream.mp4?StartTimeTicks=9000000000&CopyTimestamps=true', false, false, 9_000_000_000), { startSeconds: 900, offsetSeconds: 0 });
    assert.equal(itemPosition(12, 900), 912);
    assert.equal(mediaPosition(930, 900), 30);
});

test('explicit embedded and HLS subtitles are not mislabelled as external VTT tracks', async () => {
    const { subtitleIsExternal, planSubtitleSelection } = await import('../src/player-model.ts');
    const embedded = { Index: 3, Type: 'Subtitle', IsTextSubtitleStream: true, DeliveryMethod: 'Embed' };
    const hls = { Index: 4, Type: 'Subtitle', IsTextSubtitleStream: true, DeliveryMethod: 'Hls' };
    assert.equal(subtitleIsExternal(embedded), false);
    assert.equal(subtitleIsExternal(hls), false);
    assert.deepEqual(planSubtitleSelection(3, [embedded], 'https://h/videos/m/stream?Static=true'), { action: 'embedded', index: 3 });
});

test('negotiation releases a live stream if the returned conversion URL is rejected', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    responses.push({ status: 200, body: JSON.stringify({ PlaySessionId: 'play-rejected', MediaSources: [{ Id: 'opened', LiveStreamId: 'live-rejected', SupportsDirectPlay: false, TranscodingUrl: 'https://foreign.test/live.m3u8' }] }) });
    await assert.rejects(new JellyfinApi(session).play({ Id: 'channel', Name: 'Channel', Type: 'TvChannel' }), /another origin/);
    assert.equal(requests.some(request => new URL(request.url).searchParams.get('liveStreamId') === 'live-rejected'), true);
});

test('PLAY live cleanup posts to LiveStreams/Close and never rejects', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);

    responses.push({ status: 204, body: '' });
    assert.equal(await api.closeLiveStream('live-1'), true);
    assert.equal(requests[0].method, 'POST');
    assert.ok(requests[0].url.includes('/LiveStreams/Close?'), `cleanup must use LiveStreams/Close, got ${requests[0].url}`);
    assert.ok(requests[0].url.includes('liveStreamId=live-1'), `cleanup must name the stream, got ${requests[0].url}`);

    responses.push({ status: 500, body: '' });
    assert.equal(await api.closeLiveStream('live-2'), false);
    assert.equal(await api.closeLiveStream(''), false);
});

test('a replacement start waits for the preceding stop acknowledgment', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    let finish;
    responses.push({ status: 204, body: '', wait: new Promise(resolve => { finish = resolve; }) }, { status: 204, body: '' });
    const api = new JellyfinApi(session);
    const stop = api.reportPlaybackStopped({ ItemId: 'old', PositionTicks: 100 });
    const start = api.reportPlaybackStart({ ItemId: 'new', PositionTicks: 200 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, '/jellyfin/Sessions/Playing/Stopped');
    finish();
    assert.deepEqual(await Promise.all([stop, start]), [true, true]);
    assert.equal(JSON.parse(requests[1].body).ItemId, 'new');
});

test('live renegotiation retains the existing tuner identity without opening another stream', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    responses.push({ status: 200, body: JSON.stringify({ PlaySessionId: 'replacement', MediaSources: [{ Id: 'source', LiveStreamId: 'live-1', SupportsDirectPlay: false, TranscodingUrl: '/videos/channel/live.m3u8?LiveStreamId=live-1' }] }) });
    const api = new JellyfinApi(session);
    const choice = await api.play({ Id: 'channel', Name: 'Channel', Type: 'TvChannel' }, { liveStreamId: 'live-1', subtitleStreamIndex: -1 });
    assert.equal(JSON.parse(requests[0].body).LiveStreamId, 'live-1');
    assert.equal(JSON.parse(requests[0].body).SubtitleStreamIndex, -1);
    assert.equal(choice.liveStreamId, 'live-1');
    assert.equal(requests.length, 1);
    await api.releasePlayback(choice, 'live-1');
    assert.equal(requests.some(request => request.url.includes('/LiveStreams/Close')), false);
    assert.equal(requests[1].method, 'DELETE');
});

test('PLAY App, Player, and API share one playback-session owner', () => {
    const main = source('main.tsx');
    assert.match(main, /PlaybackSessionTracker/);
    assert.match(main, /playbackSessions\.begin\(/);
    assert.match(main, /playbackSessions\.commit\(/);
    assert.match(main, /playbackSessions\.retire\(\)/);
    assert.match(main, /playbackSession=\{playerSource\.kind === 'library' \? playbackSessions\.active\(\) : null\}/);
    assert.match(main, /sessionOwner=\{playbackSessions\}/);
    assert.doesNotMatch(main, /playbackRequest\.current/);

    const player = source('player.tsx');
    assert.match(player, /playbackSession\?\.key/);
    assert.match(player, /owner\.isCurrent\(session\)/);
    assert.match(player, /reporter\.stopAsync\(false\)/);
    assert.match(player, /owner\.claimLiveCleanup\(session\)/);
    assert.match(player, /client\.closeLiveStream\(liveStreamId\)/);

    const api = source('api.ts');
    assert.match(api, /async closeLiveStream\(liveStreamId: string\)/);
});
