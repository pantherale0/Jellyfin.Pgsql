import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function serveTranscodedVod(page: Page, blockedSegment: number | null = null) {
    await resetFakeServer();
    const segment = await readFile(new URL('../fake-server/media/hls-sample.ts', import.meta.url));
    const requestedSegments: number[] = [];
    const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    let releaseSlowSegment: () => void = () => undefined;
    const slowSegment = new Promise<void>(resolve => { releaseSlowSegment = resolve; });

    await page.route(url => url.pathname === '/Items/e2e-movie-1/PlaybackInfo', async route => {
        const response = await route.fetch();
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.MediaSources)) throw new Error('Playback fixture did not return media sources.');
        const [ source, ...otherSources ] = payload.MediaSources;
        if (!isRecord(source)) throw new Error('Playback fixture did not return a media source.');
        await route.fulfill({ response, json: {
            ...payload,
            MediaSources: [ {
                ...source,
                SupportsDirectPlay: false,
                SupportsDirectStream: false,
                Bitrate: 8_000_000,
                RunTimeTicks: 6_000_000_000,
                TranscodingUrl: '/Videos/e2e-movie-1/master.m3u8?ApiKey=e2e-access-token'
            }, ...otherSources ]
        } });
    });
    await page.route(url => url.pathname === '/Videos/e2e-movie-1/master.m3u8', route => route.fulfill({
        contentType: 'application/vnd.apple.mpegurl', headers: corsHeaders,
        body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.64000c,mp4a.40.2"\nmain.m3u8\n'
    }));
    await page.route(url => url.pathname === '/Videos/e2e-movie-1/main.m3u8', route => route.fulfill({
        contentType: 'application/vnd.apple.mpegurl', headers: corsHeaders,
        body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n'
            + Array.from({ length: 60 }, (_, index) => `${index ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:10.0,\nhls1/main/${index}.ts?runtimeTicks=${index * 100_000_000}&actualSegmentLengthTicks=100000000\n`).join('')
            + '#EXT-X-ENDLIST\n'
    }));
    await page.route(url => /\/Videos\/e2e-movie-1\/hls1\/main\/\d+\.ts$/.test(url.pathname), async route => {
        const url = new URL(route.request().url());
        const index = Number(url.pathname.match(/\/(\d+)\.ts$/)?.[1]);
        expect(url.searchParams.get('runtimeTicks')).toBe(String(index * 100_000_000));
        requestedSegments.push(index);
        if (index === blockedSegment) await slowSegment;
        await route.fulfill({ contentType: 'video/mp2t', headers: corsHeaders, body: segment }).catch(() => undefined);
    });
    return { requestedSegments, releaseSlowSegment };
}

async function startMovie(page: Page): Promise<void> {
    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await app.startMoviePlayback();
}

test('transcoded VOD seeks beyond generated content and then back without replacing the session', async ({ page }) => {
    await page.addInitScript(() => {
        const canPlayType = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function(type: string) {
            return /mpegurl/i.test(type) ? '' : canPlayType.call(this, type);
        };
    });
    const { requestedSegments, releaseSlowSegment } = await serveTranscodedVod(page, 2);

    try {
        await startMovie(page);
        const video = page.locator('video');
        await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
        await expect.poll(() => requestedSegments.includes(2), { timeout: 15000 }).toBe(true);
        await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.duration : 0)).toBe(600);

        await page.mouse.move(640, 450);
        await page.getByRole('slider', { name: 'Seek', exact: true }).fill('565');
        await expect.poll(() => requestedSegments.includes(56)).toBe(true);
        await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.seeking && !element.paused && element.currentTime > 565.25)).toBe(true);
        await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.currentSrc : '')).toMatch(/^blob:/);
        await expect(page.getByRole('alert')).toHaveCount(0);

        await page.mouse.move(640, 450);
        await page.getByRole('slider', { name: 'Seek', exact: true }).fill('325');
        await expect.poll(() => requestedSegments.includes(32)).toBe(true);
        await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.seeking && !element.paused && element.currentTime > 325.25 && element.currentTime < 335)).toBe(true);
        const requests = await fakeServerRequests();
        expect(requests.filter(request => request.path === '/Items/e2e-movie-1/PlaybackInfo')).toHaveLength(1);
        expect(requests.filter(request => request.path === '/Sessions/Playing/Stopped')).toHaveLength(0);
    } finally {
        releaseSlowSegment();
    }
});

test('HLS falls back to native playback without MSE and reports native playback errors', async ({ page }) => {
    await page.addInitScript(() => {
        for (const name of [ 'MediaSource', 'ManagedMediaSource', 'WebKitMediaSource' ]) {
            Object.defineProperty(window, name, { configurable: true, value: undefined });
        }
    });
    await serveTranscodedVod(page);
    await startMovie(page);
    const video = page.locator('video');
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.currentSrc : '')).toContain('/Videos/e2e-movie-1/master.m3u8');
    await expect.poll(async () => (await fakeServerRequests()).filter(request => request.path === '/Sessions/Playing').length).toBe(1);
    await video.evaluate(element => element.dispatchEvent(new Event('error')));
    await expect(page.getByRole('alert')).toContainText('Playback stopped because this browser could not play the stream.');
    await expect.poll(async () => (await fakeServerRequests()).filter(request => request.path === '/Sessions/Playing/Stopped').length).toBe(1);
});

test('HLS reports an actionable failure when neither MSE nor native HLS is supported', async ({ page }) => {
    await page.addInitScript(() => {
        for (const name of [ 'MediaSource', 'ManagedMediaSource', 'WebKitMediaSource' ]) {
            Object.defineProperty(window, name, { configurable: true, value: undefined });
        }
        const canPlayType = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function(type: string) {
            return /mpegurl/i.test(type) ? '' : canPlayType.call(this, type);
        };
    });
    const { requestedSegments } = await serveTranscodedVod(page);
    await startMovie(page);
    await expect(page.getByRole('alert')).toContainText('Playback stopped because this browser could not play the stream.');
    await expect(page.getByRole('button', { name: 'Retry from 0:00', exact: true })).toBeVisible();
    expect(requestedSegments).toEqual([]);
});
