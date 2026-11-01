import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

async function sendWebOsMediaKey(page: import('@playwright/test').Page, keyCode: number): Promise<void> {
    await page.evaluate(code => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Unidentified',
            keyCode: code,
            which: code,
            bubbles: true,
            cancelable: true
        }));
    }, keyCode);
}

test('webOS remote fast-forward and rewind keys seek the playing video', async ({ page }) => {
    await resetFakeServer();
    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await app.startMoviePlayback();

    const video = page.locator('video');
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
    await sendWebOsMediaKey(page, 19);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && element.paused)).toBe(true);
    await sendWebOsMediaKey(page, 415);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused)).toBe(true);
    await sendWebOsMediaKey(page, 19);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && element.paused)).toBe(true);
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The player video element is missing.');
        element.currentTime = 8;
    });
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.currentTime : 0)).toBeGreaterThanOrEqual(8);

    await sendWebOsMediaKey(page, 417);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.currentTime : 0)).toBeGreaterThanOrEqual(18);
    await sendWebOsMediaKey(page, 412);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.currentTime : 0)).toBeLessThanOrEqual(8);
});
