import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type NativeHlsResponse = 'error' | 'stalled';

async function installLiveHlsFixture(page: Page, nativeResponse: NativeHlsResponse) {
    await resetFakeServer();
    const segment = await readFile(new URL('../fake-server/media/hls-sample.ts', import.meta.url));
    const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    const observations = {
        segmentRequests: [] as string[],
        mediaRequests: [] as string[],
        pageErrors: [] as string[],
        nativeMediaRequests: 0,
        hlsJsManifestRequests: 0,
        playlistLoads: 0
    };

    await page.addInitScript(() => {
        Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
            configurable: true,
            value: function(type: string) { return /mpegurl/i.test(type) ? 'maybe' : ''; }
        });
    });
    page.on('pageerror', error => observations.pageErrors.push(error.message));
    page.on('requestfailed', request => {
        if (/\.m3u8|\.ts/.test(request.url())) observations.mediaRequests.push(`${request.url()} ${request.failure()?.errorText || ''}`);
    });
    await page.route(url => url.pathname === '/Items/e2e-live-channel/PlaybackInfo', async route => {
        const response = await route.fetch();
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.MediaSources)) throw new Error('Live playback fixture did not return media sources.');
        const [ source, ...otherSources ] = payload.MediaSources;
        if (!isRecord(source)) throw new Error('Live playback fixture did not return a media source.');
        await route.fulfill({ response, json: { ...payload, MediaSources: [ {
            ...source,
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true
        }, ...otherSources ] } });
    });
    await page.route('**/LiveStreams/Open', async route => {
        const response = await route.fetch();
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !isRecord(payload.MediaSource)) throw new Error('Live stream fixture did not return an opened source.');
        await route.fulfill({ response, json: { ...payload, MediaSource: {
            ...payload.MediaSource,
            Id: 'e2e-live-hls-source',
            Container: 'm3u8',
            IsInfiniteStream: true,
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            TranscodingUrl: '/Videos/e2e-live-channel/master.m3u8?ApiKey=e2e-access-token'
        } } });
    });
    await page.route(url => url.pathname === '/Videos/e2e-live-channel/master.m3u8', async route => {
        if (route.request().resourceType() === 'media') {
            observations.nativeMediaRequests += 1;
            if (nativeResponse === 'stalled') {
                await new Promise(resolve => setTimeout(resolve, 6000));
            }
            await route.fulfill({ status: 500, contentType: 'text/plain', body: 'Native HLS playback is unavailable.' }).catch(() => undefined);
            return;
        }
        observations.hlsJsManifestRequests += 1;
        await route.fulfill({
            contentType: 'application/vnd.apple.mpegurl', headers: corsHeaders,
            body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.64000c,mp4a.40.2"\nlive.m3u8\n'
        });
    });
    await page.route(url => url.pathname === '/Videos/e2e-live-channel/live.m3u8', route => {
        observations.playlistLoads += 1;
        const count = 4 + observations.playlistLoads;
        const entries = Array.from({ length: count }, (_, index) => `${index ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:10.0,\nsegment${index}.ts\n`).join('');
        return route.fulfill({
            contentType: 'application/vnd.apple.mpegurl', headers: corsHeaders,
            body: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n${entries}`
        });
    });
    await page.route(url => /^\/Videos\/e2e-live-channel\/segment\d+\.ts$/.test(url.pathname), route => {
        observations.segmentRequests.push(new URL(route.request().url()).pathname);
        return route.fulfill({ contentType: 'video/mp2t', headers: corsHeaders, body: segment });
    });

    return observations;
}

async function startLiveChannel(page: Page) {
    await page.goto('/?live=channels');
    await page.getByRole('button', { name: '1 E2E Test Channel', exact: true }).click();
    const video = page.locator('video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.canPlayType('application/vnd.apple.mpegurl') : '')).toBe('maybe');
    return video;
}

async function expectLiveHlsPlayback(page: Page, video: ReturnType<Page['locator']>, observations: Awaited<ReturnType<typeof installLiveHlsFixture>>) {
    await expect.poll(async () => {
        const [ state, requests, hasPlaybackError ] = await Promise.all([
            video.evaluate(element => element instanceof HTMLVideoElement ? { paused: element.paused, currentTime: element.currentTime } : null),
            fakeServerRequests(),
            page.getByRole('alert').count().then(count => count > 0)
        ]);
        if (requests.some(request => request.path === '/Sessions/Playing/Stopped' || request.path === '/LiveStreams/Close')) return 'stopped';
        if (hasPlaybackError) return 'failed';
        return state && !state.paused && state.currentTime > 5 ? 'playing' : 'starting';
    }, { timeout: 15_000 }).toBe('playing');
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.currentSrc : '')).toMatch(/^blob:/);
    await expect.poll(() => observations.segmentRequests.length).toBeGreaterThan(0);
    await expect.poll(() => observations.playlistLoads, { timeout: 15_000 }).toBeGreaterThan(1);
    await expect.poll(() => observations.segmentRequests).toContain('/Videos/e2e-live-channel/segment5.ts');

    const requests = await fakeServerRequests();
    expect(requests.filter(request => request.path === '/Items/e2e-live-channel/PlaybackInfo')).toHaveLength(1);
    expect(requests.filter(request => request.path === '/LiveStreams/Open')).toHaveLength(1);
    expect(requests.filter(request => request.path === '/Sessions/Playing')).toHaveLength(1);
    expect(requests.filter(request => request.path === '/Sessions/Playing/Stopped')).toEqual([]);
    expect(requests.filter(request => request.path === '/LiveStreams/Close')).toEqual([]);
    expect(observations.nativeMediaRequests).toBe(1);
    expect(observations.hlsJsManifestRequests).toBeGreaterThan(0);
    expect(observations.pageErrors).toEqual([]);
    expect(observations.mediaRequests.filter(request => !request.includes('ERR_ABORTED'))).toEqual([]);
}

test('Live TV HLS falls back after native playback fails without reopening its EVENT stream', async ({ page }) => {
    const observations = await installLiveHlsFixture(page, 'error');
    const video = await startLiveChannel(page);
    await expectLiveHlsPlayback(page, video, observations);
});

test('Live TV HLS falls back when native playback starts but presents no video frames', async ({ page }) => {
    const observations = await installLiveHlsFixture(page, 'stalled');
    const video = await startLiveChannel(page);
    await expect.poll(() => observations.nativeMediaRequests).toBe(1);
    await expect.poll(() => observations.hlsJsManifestRequests, { timeout: 5000 }).toBeGreaterThan(0);
    await expectLiveHlsPlayback(page, video, observations);
});
