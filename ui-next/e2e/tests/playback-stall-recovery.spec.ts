import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

const BUFFERING_DELAY_MS = 1400;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function startMovie(page: Page): Promise<Locator> {
    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await app.startMoviePlayback();
    const video = page.locator('video');
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
    await expect(page.getByRole('status').filter({ hasText: 'Buffering…' })).toHaveCount(0);
    return video;
}

async function freezeAndWait(video: Locator): Promise<void> {
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The player video element is missing.');
        const currentTime = element.currentTime;
        Object.defineProperty(element, 'currentTime', { configurable: true, get: () => currentTime, set: () => undefined });
        element.dispatchEvent(new Event('waiting', { bubbles: true }));
    });
}

async function resumeAfterWait(video: Locator): Promise<void> {
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The player video element is missing.');
        Reflect.deleteProperty(element, 'currentTime');
        element.dispatchEvent(new Event('playing', { bubbles: true }));
    });
}

async function useHighBitratePlayback(page: Page, observedBitrates: number[]): Promise<void> {
    await page.route('**/Items/e2e-movie-1/PlaybackInfo', async route => {
        const request: unknown = route.request().postDataJSON();
        if (isRecord(request) && typeof request.MaxStreamingBitrate === 'number') observedBitrates.push(request.MaxStreamingBitrate);

        const response = await route.fetch();
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.MediaSources)) throw new Error('Playback fixture did not return media sources.');
        const [ firstSource, ...otherSources ] = body.MediaSources;
        if (!isRecord(firstSource)) throw new Error('Playback fixture did not return a media source.');
        await route.fulfill({
            response,
            json: {
                ...body,
                MediaSources: [ {
                    ...firstSource,
                    Bitrate: 8_000_000,
                    TranscodingUrl: '/Videos/e2e-movie-1/stream?ApiKey=e2e-access-token'
                }, ...otherSources ]
            }
        });
    });
}

test('delayed playback progress reports do not stall video or flash buffering on a brief wait', async ({ page }) => {
    await resetFakeServer();
    let progressRequests = 0;
    await page.route('**/Sessions/Playing/Progress', async route => {
        progressRequests += 1;
        await new Promise<void>(resolve => setTimeout(resolve, 1200));
        await route.continue();
    });

    const video = await startMovie(page);
    const buffering = page.getByRole('status').filter({ hasText: 'Buffering…' });
    await video.evaluate(element => element.dispatchEvent(new Event('volumechange')));
    await expect.poll(() => progressRequests).toBeGreaterThan(0);
    const before = await video.evaluate(element => element instanceof HTMLVideoElement ? element.currentTime : 0);
    await page.waitForTimeout(300);
    const after = await video.evaluate(element => element instanceof HTMLVideoElement ? element.currentTime : 0);
    expect(after).toBeGreaterThan(before);
    await expect(buffering).toHaveCount(0);

    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The player video element is missing.');
        const currentTime = element.currentTime;
        Object.defineProperty(element, 'currentTime', { configurable: true, get: () => currentTime, set: () => undefined });
        element.dispatchEvent(new Event('waiting', { bubbles: true }));
    });
    const showedBufferingImmediately = await page.locator('.player-buffering').count() > 0;
    expect(showedBufferingImmediately).toBe(false);
    await page.waitForTimeout(100);
    await expect(buffering).toHaveCount(0);
    await resumeAfterWait(video);
});

test('repeated real stalls trigger a lower-bitrate playback request', async ({ page }) => {
    await resetFakeServer();
    const observedBitrates: number[] = [];
    await useHighBitratePlayback(page, observedBitrates);

    const video = await startMovie(page);
    const buffering = page.getByRole('status').filter({ hasText: 'Buffering…' });
    for (let stall = 0; stall < 2; stall += 1) {
        await freezeAndWait(video);
        await expect(buffering, `confirmed stall ${stall + 1}`).toBeVisible({ timeout: BUFFERING_DELAY_MS + 3000 });
        await resumeAfterWait(video);
        await expect(buffering).toHaveCount(0);
    }

    await freezeAndWait(video);
    await expect.poll(() => observedBitrates.length).toBeGreaterThan(0);
    expect(observedBitrates[observedBitrates.length - 1]).toBe(4_000_000);
});
