import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('HLS.js resumes MPEG-TS playback and supports a backward seek', async ({ page }) => {
    await resetFakeServer();
    await page.addInitScript(() => {
        const canPlayType = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function(type: string) {
            return /mpegurl/i.test(type) ? '' : canPlayType.call(this, type);
        };
    });
    const segment = await readFile(new URL('../fake-server/media/hls-sample.ts', import.meta.url));
    const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

    await page.route(url => url.pathname === '/Users/e2e-user-id/Items/e2e-movie-1', async route => {
        const response = await route.fetch();
        const payload: unknown = await response.json();
        if (!isRecord(payload)) throw new Error('Movie fixture did not return an item.');
        const userData = isRecord(payload.UserData) ? payload.UserData : {};
        await route.fulfill({ response, json: { ...payload, UserData: { ...userData, PlaybackPositionTicks: 40_000_000 } } });
    });
    await page.route(url => url.pathname === '/Items/e2e-movie-1/PlaybackInfo', async route => {
        const response = await route.fetch();
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.MediaSources)) throw new Error('Playback fixture did not return media sources.');
        const [ source, ...otherSources ] = payload.MediaSources;
        if (!isRecord(source)) throw new Error('Playback fixture did not return a media source.');
        await route.fulfill({
            response,
            json: {
                ...payload,
                MediaSources: [ {
                    ...source,
                    Container: 'm3u8',
                    SupportsDirectPlay: false,
                    SupportsDirectStream: false,
                    TranscodingUrl: '/Videos/e2e-movie-1/master.m3u8?ApiKey=e2e-access-token'
                }, ...otherSources ]
            }
        });
    });
    await page.route(url => url.pathname === '/Videos/e2e-movie-1/master.m3u8', route => route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        headers: corsHeaders,
        body: `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=180000,CODECS="avc1.64000c,mp4a.40.2"\nvariant.m3u8?ApiKey=e2e-access-token\n`
    }));
    await page.route(url => url.pathname === '/Videos/e2e-movie-1/variant.m3u8', route => route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        headers: corsHeaders,
        body: '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:10\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nsegment.ts?ApiKey=e2e-access-token\n#EXT-X-ENDLIST\n'
    }));
    await page.route(url => url.pathname === '/Videos/e2e-movie-1/segment.ts', route => route.fulfill({
        status: 200,
        contentType: 'video/mp2t',
        headers: corsHeaders,
        body: segment
    }));

    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await page.getByRole('button', { name: /^▶ Resume$/ }).click();

    const video = page.locator('video');
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.currentSrc : '')).toMatch(/^blob:/);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && element.buffered.length > 0)).toBe(true);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && element.currentTime > 3)).toBe(true);
    const playbackRequest = (await fakeServerRequests()).find(request => request.path === '/Items/e2e-movie-1/PlaybackInfo');
    expect(isRecord(playbackRequest?.body) ? playbackRequest.body.StartTimeTicks : undefined).toBe(40_000_000);
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The HLS video element is missing.');
        element.currentTime = 5;
    });
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && element.currentTime >= 4.5)).toBe(true);
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The HLS video element is missing.');
        element.currentTime = 0.25;
    });
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && element.currentTime < 1)).toBe(true);
});
