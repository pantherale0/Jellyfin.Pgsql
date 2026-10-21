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
const store = new Map();
beforeEach(() => { requests.length = 0; responses.length = 0; store.clear(); });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/', origin: 'https://jellyfin.example.test' }, setTimeout };
globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, String(value)); } };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send(body) {
        requests.push({ method: this.method, url: this.url, body: body ? JSON.parse(body) : undefined });
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'Viewer' }, serverId: 'server-id' };
const source = file => readSource(new URL(`../src/${file}`, import.meta.url), 'utf8');
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const everything = { canPlay: () => true, hdrDisplay: false, audioTrackSwitching: false };
const conditions = (profile, codec) => profile.CodecProfiles.find(entry => entry.Codec === codec)?.Conditions || [];

test('PLAY-09 device profile keeps the fork Chrome/Opera MKV guard and Firefox audio guards', async () => {
    const { buildDeviceProfile } = await import('../src/device-profile.ts');
    const chrome = buildDeviceProfile({ ...everything, userAgent: CHROME });
    assert.ok(!chrome.DirectPlayProfiles.some(entry => entry.Container === 'mkv'), 'Chrome must not advertise MKV direct play');
    const opera = buildDeviceProfile({ ...everything, userAgent: `${CHROME} OPR/120.0` });
    assert.ok(!opera.DirectPlayProfiles.some(entry => entry.Container === 'mkv'));
    const safari = buildDeviceProfile({ ...everything, userAgent: SAFARI });
    assert.ok(safari.DirectPlayProfiles.some(entry => entry.Container === 'mkv'));
    const firefox = buildDeviceProfile({ ...everything, userAgent: FIREFOX });
    const mp4 = firefox.DirectPlayProfiles.find(entry => entry.Container === 'mp4,m4v');
    assert.ok(mp4 && !/\bac3\b|eac3/.test(mp4.AudioCodec), `Firefox must not claim AC-3/E-AC-3, got ${mp4?.AudioCodec}`);
});

test('PLAY-09 codec profiles constrain H.264 level, bit depth and SDR/HDR ranges', async () => {
    const { buildDeviceProfile } = await import('../src/device-profile.ts');
    const sdr = buildDeviceProfile({ ...everything, userAgent: CHROME });
    const h264 = conditions(sdr, 'h264');
    assert.ok(h264.some(entry => entry.Property === 'VideoLevel' && entry.Value === '52'));
    assert.ok(h264.some(entry => entry.Property === 'VideoBitDepth' && entry.Value === '8'));
    assert.equal(conditions(sdr, 'hevc').find(entry => entry.Property === 'VideoRangeType').Value, 'SDR');
    const hdr = buildDeviceProfile({ ...everything, hdrDisplay: true, userAgent: CHROME });
    assert.match(conditions(hdr, 'hevc').find(entry => entry.Property === 'VideoRangeType').Value, /HDR10/);
    assert.equal(conditions(hdr, 'h264').find(entry => entry.Property === 'VideoRangeType').Value, 'SDR');
    const nothing = buildDeviceProfile({ canPlay: () => false, hdrDisplay: false, audioTrackSwitching: false, userAgent: CHROME });
    assert.equal(nothing.DirectPlayProfiles.filter(entry => entry.Type === 'Video').length, 0, 'unsupported codecs must not be advertised');
});

test('PLAY-07 subtitle profiles route text as external and image formats through burn-in', async () => {
    const { buildDeviceProfile } = await import('../src/device-profile.ts');
    const profile = buildDeviceProfile({ ...everything, userAgent: CHROME });
    const method = format => profile.SubtitleProfiles.find(entry => entry.Format === format)?.Method;
    assert.equal(method('vtt'), 'External');
    assert.equal(method('subrip'), 'External');
    assert.equal(method('ass'), 'External');
    assert.equal(method('pgssub'), 'Encode');
    assert.equal(method('dvdsub'), 'Encode');
});

test('PLAY-07 subtitle selection honours delivery method, including Off for burned-in captions', async () => {
    const { planSubtitleSelection, initialSubtitleIndex } = await import('../src/player-model.ts');
    const streams = [
        { Index: 2, Type: 'Subtitle', IsTextSubtitleStream: true, DeliveryMethod: 'External' },
        { Index: 3, Type: 'Subtitle', IsTextSubtitleStream: false, DeliveryMethod: 'Encode' }
    ];
    const direct = 'https://jellyfin.example.test/Videos/x/stream?Static=true';
    const burned = 'https://jellyfin.example.test/videos/x/master.m3u8?SubtitleStreamIndex=3&SubtitleMethod=Encode';
    assert.deepEqual(planSubtitleSelection(2, streams, direct), { action: 'track', index: 2 });
    assert.deepEqual(planSubtitleSelection(null, streams, direct), { action: 'off' });
    assert.deepEqual(planSubtitleSelection(3, streams, direct), { action: 'renegotiate', subtitleStreamIndex: 3 });
    assert.deepEqual(planSubtitleSelection(null, streams, burned), { action: 'renegotiate', subtitleStreamIndex: -1 }, 'Off must remove burned-in captions');
    assert.deepEqual(planSubtitleSelection(2, streams, burned), { action: 'renegotiate', subtitleStreamIndex: 2 }, 'a text track must not coexist with burned captions');
    assert.deepEqual(planSubtitleSelection(3, streams, burned), { action: 'none' });
    assert.equal(initialSubtitleIndex({ url: burned, streams, subtitleStreamIndex: null }), 3);
    assert.equal(initialSubtitleIndex({ url: direct, streams, subtitleStreamIndex: 3 }), null, 'an undelivered image track is not shown as selected');
});

test('PLAY-01/05 negotiation carries resume ticks and keeps the server default tracks', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    responses.push({ status: 200, body: JSON.stringify({ PlaySessionId: 'play', MediaSources: [ { Id: 'src', SupportsDirectPlay: true, DefaultAudioStreamIndex: 4, DefaultSubtitleStreamIndex: 6, MediaStreams: [ { Index: 4, Type: 'Audio' }, { Index: 5, Type: 'Audio', IsDefault: true }, { Index: 6, Type: 'Subtitle', IsTextSubtitleStream: true } ] } ] }) });
    const choice = await api.play({ Id: 'movie', Name: 'Movie', Type: 'Movie' }, { startTicks: 6_000_000_000 });
    const body = requests[0].body;
    assert.equal(body.StartTimeTicks, 6_000_000_000);
    assert.equal(body.IsPlayback, true);
    assert.equal(choice.startSeconds, 600);
    assert.equal(choice.offsetSeconds, 0);
    assert.equal(choice.audioStreamIndex, 4);
    assert.equal(choice.subtitleStreamIndex, 6);
    const { initialAudioIndex, initialSubtitleIndex } = await import('../src/player-model.ts');
    assert.equal(initialAudioIndex(choice), 4, 'the negotiated default wins over the file IsDefault flag');
    assert.equal(initialSubtitleIndex(choice), 6);
});

test('PLAY-01 resume intent and progressive-transcode offsets', async () => {
    const { resumeStartTicks, canResume, startPlan } = await import('../src/player-model.ts');
    const item = { Type: 'Movie', RunTimeTicks: 72_000_000_000, UserData: { PlaybackPositionTicks: 9_000_000_000 } };
    assert.equal(resumeStartTicks(item, 'resume'), 9_000_000_000);
    assert.equal(resumeStartTicks(item, 'beginning'), 0);
    assert.equal(resumeStartTicks({ ...item, UserData: { PlaybackPositionTicks: 9_000_000_000, Played: true } }), 0);
    assert.equal(resumeStartTicks({ Type: 'TvChannel', UserData: { PlaybackPositionTicks: 5 } }), 0);
    assert.equal(canResume(item), true);
    assert.deepEqual(startPlan('https://h/videos/x/master.m3u8?StartTimeTicks=9000000000', false, true, 9_000_000_000), { startSeconds: 900, offsetSeconds: 0 });
    assert.deepEqual(startPlan('https://h/videos/x/stream.mp4?StartTimeTicks=9000000000', false, false, 9_000_000_000), { startSeconds: 0, offsetSeconds: 900 });
    const main = source('main.tsx');
    assert.match(main, /onPlay\('beginning'\)/, 'details must offer From beginning');
    assert.match(main, /api\.play\(playbackItem, \{ startTicks: resumeStartTicks\(playbackItem, intent\) \}\)/);
});

test('live playback watchdog shows buffering and requests only one fresh stream', async () => {
    const model = await import('../src/player-model.ts');
    const watch = { lastPositionSeconds: 42, lastProgressAtMs: 1_000, liveReopenAttempted: false };
    const observe = model.observePlaybackProgress;

    assert.deepEqual(observe?.(watch, { currentTime: 42, nowMs: 3_000, paused: false, seeking: false, isLive: true }), {
        watch,
        buffering: true,
        reopenLiveStream: false,
        recoveryFailed: false
    });

    const reopen = observe?.(watch, { currentTime: 42, nowMs: 21_000, paused: false, seeking: false, isLive: true });
    assert.deepEqual(reopen, {
        watch: { ...watch, liveReopenAttempted: true },
        buffering: true,
        reopenLiveStream: true,
        recoveryFailed: false
    });
    const reopenedWatch = { ...reopen.watch, lastProgressAtMs: 21_000 };
    assert.deepEqual(observe?.(reopenedWatch, { currentTime: 42, nowMs: 22_000, paused: false, seeking: false, isLive: true }), {
        watch: reopenedWatch,
        buffering: false,
        reopenLiveStream: false,
        recoveryFailed: false
    });
    assert.deepEqual(observe?.(reopenedWatch, { currentTime: 42, nowMs: 41_000, paused: false, seeking: false, isLive: true }), {
        watch: reopenedWatch,
        buffering: true,
        reopenLiveStream: false,
        recoveryFailed: true
    });
});

test('live playback watchdog resets on progress and ignores pause or seek', async () => {
    const model = await import('../src/player-model.ts');
    const watch = { lastPositionSeconds: 42, lastProgressAtMs: 1_000, liveReopenAttempted: false };
    const observe = model.observePlaybackProgress;

    assert.deepEqual(observe?.(watch, { currentTime: 43, nowMs: 5_000, paused: false, seeking: false, isLive: true }), {
        watch: { ...watch, lastPositionSeconds: 43, lastProgressAtMs: 5_000 },
        buffering: false,
        reopenLiveStream: false,
        recoveryFailed: false
    });
    assert.deepEqual(observe?.(watch, { currentTime: 42, nowMs: 30_000, paused: true, seeking: false, isLive: true }), {
        watch: { ...watch, lastProgressAtMs: 30_000 },
        buffering: false,
        reopenLiveStream: false,
        recoveryFailed: false
    });
    assert.deepEqual(observe?.(watch, { currentTime: 42, nowMs: 30_000, paused: false, seeking: true, isLive: true }), {
        watch: { ...watch, lastProgressAtMs: 30_000 },
        buffering: false,
        reopenLiveStream: false,
        recoveryFailed: false
    });
    assert.deepEqual(observe?.(watch, { currentTime: 42, nowMs: 3_000, paused: false, seeking: false, isLive: false }), {
        watch,
        buffering: true,
        reopenLiveStream: false,
        recoveryFailed: false
    }, 'VOD shows buffering but never opens a Live TV stream');
});

test('fresh live recovery omits the previous LiveStreamId while ordinary renegotiation retains it', async () => {
    const model = await import('../src/player-model.ts');

    assert.deepEqual(model.playbackRenegotiationPlan?.({ startTicks: 12, mediaSourceId: 'old-source', reopenLiveStream: true }, 'old-live-id'), {
        options: { startTicks: 12, mediaSourceId: undefined, liveStreamId: undefined },
        retainedLiveStreamId: undefined
    });
    assert.deepEqual(model.playbackRenegotiationPlan?.({ forceTranscode: true }, 'current-live-id'), {
        options: { forceTranscode: true, liveStreamId: 'current-live-id' },
        retainedLiveStreamId: 'current-live-id'
    });
});

test('HLS recovery ignores nonfatal events and bounds live media recovery', async () => {
    const model = await import('../src/player-model.ts');
    const noAttempts = { networkRetries: 0, mediaRetries: 0 };
    const nonfatal = model.planHlsRecovery?.({ fatal: false, kind: 'media' }, noAttempts, true, false);
    assert.deepEqual(nonfatal, { action: 'ignore', attempts: noAttempts });

    const recover = model.planHlsRecovery?.({ fatal: true, kind: 'media' }, noAttempts, true, false);
    assert.deepEqual(recover, { action: 'recover-media', attempts: { networkRetries: 0, mediaRetries: 1 } });
    const swap = model.planHlsRecovery?.({ fatal: true, kind: 'media' }, recover.attempts, true, false);
    assert.deepEqual(swap, { action: 'swap-audio-codec', attempts: { networkRetries: 0, mediaRetries: 2 } });
    const reopen = model.planHlsRecovery?.({ fatal: true, kind: 'media' }, swap.attempts, true, false);
    assert.deepEqual(reopen, { action: 'reopen-live', attempts: swap.attempts });
    assert.deepEqual(model.planHlsRecovery?.({ fatal: true, kind: 'media' }, swap.attempts, true, true), { action: 'fail', attempts: swap.attempts });

    const retryNetwork = model.planHlsRecovery?.({ fatal: true, kind: 'network' }, noAttempts, true, false);
    assert.deepEqual(retryNetwork, { action: 'start-load', attempts: { networkRetries: 1, mediaRetries: 0 } });
    assert.deepEqual(model.planHlsRecovery?.({ fatal: true, kind: 'network' }, retryNetwork.attempts, true, false), { action: 'reopen-live', attempts: retryNetwork.attempts });
    assert.deepEqual(model.planHlsRecovery?.({ fatal: true, kind: 'network', responseCode: 0 }, noAttempts, true, false), { action: 'reopen-live', attempts: noAttempts });
    assert.deepEqual(model.planHlsRecovery?.({ fatal: true, kind: 'network', responseCode: 0 }, noAttempts, true, true), { action: 'fail', attempts: noAttempts });
    assert.deepEqual(model.planHlsRecovery?.({ fatal: true, kind: 'network', responseCode: 0 }, noAttempts, false, false), { action: 'fail', attempts: noAttempts });
    assert.deepEqual(model.planHlsRecovery?.({ fatal: true, kind: 'network', responseCode: 404 }, noAttempts, true, false), { action: 'fail', attempts: noAttempts });
});

test('PLAY-04 tuner sources are opened and the live stream id is retained and reported', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    responses.push({ status: 200, body: JSON.stringify({ PlaySessionId: 'play', MediaSources: [ { Id: 'tuner', RequiresOpening: true, OpenToken: 'open-me', SupportsDirectPlay: false } ] }) });
    responses.push({ status: 200, body: JSON.stringify({ MediaSource: { Id: 'opened', LiveStreamId: 'live-1', SupportsDirectPlay: false, TranscodingUrl: '/videos/ch/live.m3u8?LiveStreamId=live-1', IsInfiniteStream: true } }) });
    const choice = await api.play({ Id: 'channel', Name: 'Channel', Type: 'TvChannel' });
    assert.equal(requests[0].body.AutoOpenLiveStream, true);
    assert.match(requests[1].url, /\/LiveStreams\/Open$/);
    assert.equal(requests[1].body.OpenToken, 'open-me');
    assert.equal(choice.liveStreamId, 'live-1');
    assert.equal(choice.isLive, true);
    const { playbackReport } = await import('../src/playback-report.ts');
    const report = playbackReport({ itemId: 'channel', positionSeconds: 0, durationSeconds: 0, paused: false, muted: false, volume: 1, audioStreamIndex: null, subtitleStreamIndex: null, playMethod: 'Transcode', startedAtMs: 1, liveStreamId: 'live-1' });
    assert.equal(report.LiveStreamId, 'live-1');
});

test('PLAY-06 audio switches only commit locally when the element exposes every track', async () => {
    const { planAudioSelection } = await import('../src/player-model.ts');
    const streams = [ { Index: 1, Type: 'Audio' }, { Index: 2, Type: 'Audio' } ];
    assert.deepEqual(planAudioSelection(2, 1, streams, 2, 'DirectPlay'), { action: 'switch', trackPosition: 1 });
    assert.deepEqual(planAudioSelection(2, 1, streams, 0, 'DirectPlay'), { action: 'renegotiate', audioStreamIndex: 2 });
    assert.deepEqual(planAudioSelection(2, 1, streams, 2, 'Transcode'), { action: 'renegotiate', audioStreamIndex: 2 });
    assert.deepEqual(planAudioSelection(1, 1, streams, 2, 'DirectPlay'), { action: 'none' });
    const player = source('player.tsx');
    assert.doesNotMatch(player, /const selectAudio = \(index: number\) => \{\s*setAudioIndex\(index\)/, 'selection must not be committed before the switch is effective');
});

test('PLAY-08 cross-origin media enables CORS before the source and reports caption failures', () => {
    const player = source('player.tsx');
    const video = player.slice(player.indexOf('<video'), player.indexOf('</video>'));
    assert.ok(video.indexOf('crossOrigin={crossOrigin}') >= 0 && video.indexOf('crossOrigin={crossOrigin}') < video.indexOf('src={hlsPlayback'), 'crossOrigin must be applied before src');
    assert.match(video, /<track[^>]*onError=/);
});

test('PLAY-12 each media load reports from its own progress snapshot', () => {
    const player = source('player.tsx');
    assert.doesNotMatch(player, /positionRef|durationRef/);
    assert.match(player, /const media = mediaRef\.current;/);
    assert.match(player, /positionSeconds: media\.position/);
    assert.match(player, /media\.frozen = true;\s*void reporter\.stopAsync\(false\)/);
    assert.match(player, /mediaRef\.current = mediaProgress\(playback, item\);/);
});

test('PLAY-15 quality preferences are persisted, negotiated and recoverable', async () => {
    const { savePlaybackPreferences, loadPlaybackPreferences, normalizePlaybackPreferences } = await import('../src/device-profile.ts');
    assert.equal(normalizePlaybackPreferences({ maxBitrate: 123 }).maxBitrate, 0, 'unknown bitrates fall back to Auto');
    savePlaybackPreferences({ maxBitrate: 4_000_000, maxHeight: 720, hlsContainer: 'mp4' });
    assert.equal(loadPlaybackPreferences().maxHeight, 720);
    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    responses.push({ status: 200, body: JSON.stringify({ MediaSources: [ { Id: 'src', SupportsDirectPlay: true, TranscodingUrl: '/videos/m/master.m3u8' } ] }) });
    const choice = await api.play({ Id: 'm', Name: 'M', Type: 'Movie' }, { forceTranscode: true });
    const body = requests[0].body;
    assert.equal(body.MaxStreamingBitrate, 4_000_000);
    assert.equal(body.EnableDirectPlay, false);
    assert.equal(body.DeviceProfile.TranscodingProfiles[0].Container, 'mp4');
    assert.ok(body.DeviceProfile.CodecProfiles.some(entry => entry.Conditions.some(condition => condition.Property === 'Height' && condition.Value === '720')));
    assert.equal(choice.method, 'Transcode');
    const player = source('player.tsx');
    assert.match(player, /Retry from/);
    assert.match(player, /Convert the stream/);
    assert.doesNotMatch(player, /which this player does not start/);
    assert.match(source('profile.tsx'), /Quality on this device/);
});

test('PLAY-16 diagnostics use URL reasons and session transcoding info', async () => {
    const { transcodeReasonsFromUrl, describeTranscode, sessionPlayMethod, describePlayMethod } = await import('../src/player-model.ts');
    const reasons = transcodeReasonsFromUrl('https://h/videos/x/master.m3u8?TranscodeReasons=ContainerNotSupported,AudioCodecNotSupported');
    assert.deepEqual(reasons, [ 'ContainerNotSupported', 'AudioCodecNotSupported' ]);
    assert.equal(describeTranscode(reasons, false), 'Container is not supported. Audio codec is not supported.');
    assert.equal(sessionPlayMethod({ method: 'Transcode' }, { IsVideoDirect: true, IsAudioDirect: true }), 'DirectStream');
    assert.equal(sessionPlayMethod({ method: 'Transcode' }, { IsVideoDirect: false, IsAudioDirect: true }), 'Transcode');
    assert.match(describePlayMethod('Transcode', { IsVideoDirect: false, IsAudioDirect: true, VideoCodec: 'h264' }), /video → h264, audio copied/);
});

test('PLAY-18 playback reports resolve with delivery status instead of assuming success', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    responses.push({ status: 500, body: '' });
    assert.equal(await api.reportPlaybackStopped({ ItemId: 'i', PositionTicks: 1 }), false);
    responses.push({ status: 204, body: '' });
    assert.equal(await api.reportPlaybackStopped({ ItemId: 'i', PositionTicks: 1 }), true);
    assert.match(source('player.tsx'), /if \(saved && !keepalive && owner\.canRefresh\(session\)\) onReported\?\.\(itemId\)/);
});

test('PLAY-18 a keepalive stop waits behind an in-flight start report', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const api = new JellyfinApi(session);
    const BrowserXhr = globalThis.XMLHttpRequest;
    const browserFetch = globalThis.fetch;
    const order = [];
    let finishStart;
    globalThis.XMLHttpRequest = class extends BrowserXhr {
        send(body) {
            if (this.url.endsWith('/Sessions/Playing')) {
                order.push('start');
                requests.push({ method: this.method, url: this.url, body: JSON.parse(body) });
                finishStart = () => {
                    this.status = 204;
                    this.responseText = '';
                    this.onload();
                };
                return;
            }
            super.send(body);
        }
    };
    globalThis.fetch = async () => {
        order.push('stop');
        return { ok: true };
    };

    try {
        const start = api.reportPlaybackStart({ ItemId: 'i', PositionTicks: 0 });
        const stop = api.reportPlaybackStopped({ ItemId: 'i', PositionTicks: 0 }, true);
        await Promise.resolve();
        assert.deepEqual(order, [ 'start' ], 'the unload stop must not bypass an outstanding start report');

        finishStart();
        assert.equal(await start, true);
        assert.equal(await stop, true);
        assert.deepEqual(order, [ 'start', 'stop' ]);
    } finally {
        globalThis.XMLHttpRequest = BrowserXhr;
        globalThis.fetch = browserFetch;
    }
});

test('PLAY-19 live seeking uses the seekable window', async () => {
    const { seekBounds, clampSeek } = await import('../src/player-model.ts');
    assert.deepEqual(seekBounds(120, []), { start: 0, end: 120, live: false, seekable: true });
    const live = seekBounds(Infinity, [ [ 300, 420 ] ]);
    assert.deepEqual(live, { start: 300, end: 420, live: true, seekable: true });
    assert.equal(clampSeek(0, live), 300);
    assert.equal(clampSeek(999, live), 420);
    const edgeOnly = seekBounds(Infinity, []);
    assert.equal(edgeOnly.seekable, false);
    const { playbackReport } = await import('../src/playback-report.ts');
    const report = playbackReport({ itemId: 'c', positionSeconds: 10, durationSeconds: 0, paused: false, muted: false, volume: 1, audioStreamIndex: null, subtitleStreamIndex: null, playMethod: 'Transcode', startedAtMs: 1, canSeek: true });
    assert.equal(report.CanSeek, true, 'a live window is seekable even without a finite duration');
});

test('PLAY-20 player convenience: faster speeds, PiP, iOS fullscreen and persisted preferences', async () => {
    const { PLAYER_SPEEDS, savePlaybackPreferences, loadPlaybackPreferences } = await import('../src/device-profile.ts');
    assert.ok(PLAYER_SPEEDS.includes(3) && PLAYER_SPEEDS.includes(2.5));
    savePlaybackPreferences({ speed: 1.5, fit: 'cover', volume: 0.4 });
    assert.deepEqual([ loadPlaybackPreferences().speed, loadPlaybackPreferences().fit, loadPlaybackPreferences().volume ], [ 1.5, 'cover', 0.4 ]);
    const player = source('player.tsx');
    assert.match(player, /requestPictureInPicture/);
    assert.match(player, /webkitEnterFullscreen\(\)/);
    assert.match(player, /useState\(preferences\.speed\)/);
});

test('LIVE-07 timer editors keep server fields and gate series recording', async () => {
    const { timerUpdatePayload, validateTimerDraft, timerDraft, programRecordingState, timerInProgress } = await import('../src/live-model.ts');
    const timer = { Id: 's1', Name: 'News', ChannelId: 'c', Days: [ 'Monday' ], PrePaddingSeconds: 120, PostPaddingSeconds: 0, KeepUpTo: 0 };
    const draft = { ...timerDraft(timer), postPaddingMinutes: 5, recordNewOnly: true, keepUpTo: 3 };
    assert.equal(timerDraft(timer).prePaddingMinutes, 2);
    const payload = timerUpdatePayload(timer, draft, true);
    assert.deepEqual(payload.Days, [ 'Monday' ], 'unedited server fields survive');
    assert.equal(payload.PostPaddingSeconds, 300);
    assert.equal(payload.IsPostPaddingRequired, true);
    assert.equal(payload.RecordNewOnly, true);
    assert.equal(payload.KeepUpTo, 3);
    assert.equal(timerUpdatePayload(timer, draft, false).RecordNewOnly, undefined, 'episode timers do not gain series fields');
    assert.match(validateTimerDraft({ ...draft, prePaddingMinutes: -1 }, false), /Padding/);
    assert.equal(validateTimerDraft(draft, true), '');
    assert.deepEqual(programRecordingState({ IsSeries: false }), { kind: 'none', series: false });
    assert.deepEqual(programRecordingState({ IsSeries: true }), { kind: 'none', series: true });
    assert.equal(programRecordingState({ TimerId: 't1' }).kind, 'episode');
    assert.equal(programRecordingState({ SeriesTimerId: 's1', TimerId: 't1' }).timerId, 't1');
    assert.equal(timerInProgress({ Status: 'InProgress' }, 0), true);
    assert.equal(timerInProgress({ Status: 'Completed', StartDate: '2026-01-01T00:00:00Z', EndDate: '2027-01-01T00:00:00Z' }, Date.parse('2026-06-01T00:00:00Z')), false);
    const { JellyfinApi } = await import('../src/api.ts');
    await new JellyfinApi(session).updateSeriesTimer(payload);
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].url, /\/LiveTv\/SeriesTimers\/s1$/);
    const live = source('live-tv.tsx');
    assert.match(live, /\{state\.series && <button[^\n]*?>Record Series<\/button>\}/);
    assert.match(live, /'Stop recording' : 'Cancel recording'/);
});

test('LIVE-08 guide days follow GuideInfo and the live view survives the player', async () => {
    const { guideDays, rememberLiveView, peekLiveView, startOfLocalDay, addLocalDays, MAX_GUIDE_DAYS } = await import('../src/live-model.ts');
    const now = Date.parse('2026-10-14T12:00:00');
    const today = startOfLocalDay(now);
    const days = guideDays({ StartDate: new Date(today - 86400000).toISOString(), EndDate: new Date(addLocalDays(today, 7)).toISOString() }, now);
    assert.equal(days.length, 7);
    assert.equal(days[0].start, today);
    assert.equal(days[0].label, 'Today');
    assert.equal(days[1].label, 'Tomorrow');
    assert.equal(guideDays({ StartDate: new Date(today).toISOString(), EndDate: new Date(addLocalDays(today, 40)).toISOString() }, now).length, MAX_GUIDE_DAYS);
    assert.equal(guideDays(null, now).length, 3);
    rememberLiveView({ userId: 'u', dayStart: addLocalDays(today, 1), filter: 'favorites', range: { start: 1, end: 2 }, channelCount: 9999, channelId: 'ch', savedAt: now });
    const bookmark = peekLiveView('u', now + 1000);
    assert.equal(bookmark?.filter, 'favorites');
    assert.equal(bookmark?.channelCount, 500);
    assert.equal(peekLiveView('other', now), null, 'bookmarks are per user');
    assert.equal(peekLiveView('u', now + 7 * 60 * 60 * 1000), null, 'stale bookmarks expire');
    const live = source('live-tv.tsx');
    assert.match(live, /rememberLiveView\(\{ userId, dayStart, filter, range/);
    assert.match(live, /peekLiveView\(userId, Date\.now\(\)\)/);
});

test('LIVE-09 channel order is labelled as device-local with a reset', () => {
    const live = source('live-tv.tsx');
    assert.match(live, /saved only in this browser on this device/);
    assert.match(live, /Reset order/);
});
