import { expect, test, type Page } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

async function startMovie(page: Page): Promise<void> {
    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await app.startMoviePlayback();
    await expect.poll(() => page.locator('video').evaluate(video => video instanceof HTMLVideoElement && !video.paused && video.currentTime > 0)).toBe(true);
}

test('playback seek bar shows buffered and played ranges', async ({ page }) => {
    await resetFakeServer();
    await startMovie(page);

    const video = page.locator('video');
    const played = page.locator('.player-played-progress');
    const buffered = page.locator('.player-buffered-range');
    const seek = page.locator('.player-seek');
    await expect(buffered.first()).toBeVisible();
    await expect(seek).toHaveAttribute('aria-label', 'Seek');
    const before = await played.evaluate(element => element instanceof HTMLElement ? parseFloat(element.style.width) : 0);
    await expect.poll(() => played.evaluate(element => element instanceof HTMLElement ? parseFloat(element.style.width) : 0)).toBeGreaterThan(before);
    await expect(video).toBeVisible();
});

test('live seek bar clips buffered progress to its seekable window', async ({ page }) => {
    await resetFakeServer();
    await page.goto('/?live=channels');
    await page.getByRole('button', { name: '1 E2E Test Channel', exact: true }).click();
    const video = page.locator('video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused)).toBe(true);
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The live video element is missing.');
        const timeRanges = (ranges: Array<[number, number]>) => ({
            get length() { return ranges.length; },
            start: (index: number) => ranges[index][0],
            end: (index: number) => ranges[index][1]
        });
        Object.defineProperty(element, 'duration', { configurable: true, get: () => Number.POSITIVE_INFINITY });
        Object.defineProperty(element, 'currentTime', { configurable: true, get: () => 140, set: () => undefined });
        Object.defineProperty(element, 'seekable', { configurable: true, get: () => timeRanges([ [ 100, 200 ] ]) });
        Object.defineProperty(element, 'buffered', { configurable: true, get: () => timeRanges([ [ 90, 135 ], [ 175, 225 ] ]) });
        element.dispatchEvent(new Event('durationchange', { bubbles: true }));
        element.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    });

    const buffered = page.locator('.player-buffered-range');
    await expect(buffered).toHaveCount(2);
    await expect(buffered.nth(0)).toHaveAttribute('style', /left: 0%; width: 35%;/);
    await expect(buffered.nth(1)).toHaveAttribute('style', /left: 75%; width: 25%;/);
    await expect(page.locator('.player-played-progress')).toHaveAttribute('style', /width: 40%;/);
    await expect(page.locator('.player-seek')).toHaveAttribute('aria-label', 'Seek within the live buffer');
});
