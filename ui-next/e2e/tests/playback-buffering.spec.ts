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

test('playback seek bar marks the buffered edge when the remaining buffer is subpixel-width', async ({ page }) => {
    await resetFakeServer();
    await startMovie(page);

    await page.locator('video').evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The video element is missing.');
        const timeRanges = (ranges: Array<[number, number]>) => ({
            get length() { return ranges.length; },
            start: (index: number) => ranges[index][0],
            end: (index: number) => ranges[index][1]
        });
        Object.defineProperty(element, 'duration', { configurable: true, get: () => 7200 });
        Object.defineProperty(element, 'currentTime', { configurable: true, get: () => 180, set: () => undefined });
        Object.defineProperty(element, 'buffered', { configurable: true, get: () => timeRanges([ [ 0, 184.5 ] ]) });
        element.dispatchEvent(new Event('durationchange', { bubbles: true }));
        element.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    });

    const buffered = page.locator('.player-buffered-range').first();
    const played = page.locator('.player-played-progress');
    await expect(buffered).toHaveAttribute('style', /left: 0%; width: 2\.5625%;/);
    await expect(played).toHaveAttribute('style', /width: 2\.5%;/);

    const aheadWidth = await page.evaluate(() => {
        const buffered = document.querySelector('.player-buffered-range');
        const played = document.querySelector('.player-played-progress');
        if (!(buffered instanceof HTMLElement) || !(played instanceof HTMLElement) || !buffered.parentElement) return null;
        const aheadPercent = parseFloat(buffered.style.width) - parseFloat(played.style.width);
        return buffered.parentElement.getBoundingClientRect().width * aheadPercent / 100;
    });
    if (aheadWidth === null) throw new Error('The buffered or played range is missing.');
    expect(aheadWidth).toBeGreaterThan(0);
    expect(aheadWidth).toBeLessThan(2);

    const edge = await page.locator('.player-buffered-range').evaluate(element => {
        const style = getComputedStyle(element, '::after');
        const track = element.parentElement;
        return {
            content: style.content,
            display: style.display,
            width: parseFloat(style.width),
            color: style.backgroundColor,
            trackColor: track ? getComputedStyle(track).backgroundColor : ''
        };
    });
    expect(edge.content).not.toBe('none');
    expect(edge.display).not.toBe('none');
    expect(edge.width).toBeGreaterThanOrEqual(2);
    expect(edge.color).not.toBe(edge.trackColor);
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
