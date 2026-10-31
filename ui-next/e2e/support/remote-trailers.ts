import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { resetFakeServer } from './control-client';

const videoId = 'dQw4w9WgXcQ';

export async function openTrailerDetails(page: Page, trailers: unknown = [
    { Url: 'https://vimeo.com/123' },
    { Url: `https://youtu.be/${videoId}` },
    { Url: 'https://www.youtube.com/watch?v=abcdefghijk' }
]) {
    await resetFakeServer();
    await page.route(url => /\/Users\/[^/]+\/Items\/e2e-movie-1$/.test(url.pathname), async route => {
        const response = await route.fetch();
        const raw: unknown = await response.json();
        if (typeof raw !== 'object' || raw === null) throw new Error('Expected a movie DTO.');
        await route.fulfill({ json: { ...raw, RemoteTrailers: trailers } });
    });
    await page.goto('/?item=e2e-movie-1');
    await expect(page.locator('.detail-page')).toBeVisible();
}

export function remoteTrailerCases() {
    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: 'wait' });
    });

    test('clapperboard action plays the first supported trailer and returns without library playback activity', async ({ page }) => {
        const requests: string[] = [];
        page.on('request', request => requests.push(request.url()));
        const bytes = await readFile(new URL('../fake-server/media/sample.webm', import.meta.url));
        await page.route('**/Pgsql/Trailers/*/stream*', async route => {
            const url = new URL(route.request().url());
            expect(url.pathname).toBe(`/Pgsql/Trailers/${videoId}/stream`);
            expect(url.searchParams.get('ApiKey')).toBe('e2e-access-token');
            await route.fulfill({ contentType: 'video/webm', body: bytes });
        });
        await openTrailerDetails(page);
        if (test.info().project.name === 'chromium') {
            await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Movies', exact: true }).click();
            const queuedCard = page.locator('.library-card').filter({ has: page.getByRole('button', { name: /^View E2E Movie Two/ }) });
            await queuedCard.getByRole('button', { name: 'More actions', exact: true }).focus();
            await queuedCard.getByRole('button', { name: 'More actions', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Add to queue', exact: true }).click();
            await page.getByRole('button', { name: /^View E2E Movie One/ }).click();
        }
        const trailer = page.getByRole('button', { name: 'Watch trailer', exact: true });
        await expect(trailer.locator('svg')).toHaveCount(1);
        if (test.info().project.name === 'tv') {
            await page.locator('.detail-actions .button.primary').focus();
            await page.keyboard.press('ArrowRight');
            await expect(trailer).toBeFocused();
            await page.keyboard.press('Enter');
        } else await trailer.click();

        const video = page.locator('video');
        await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
        await expect(page.getByRole('heading', { name: 'E2E Movie One · Trailer', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Playback settings', exact: true }).click();
        await expect(page.getByText('Quality', { exact: true })).toHaveCount(0);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        // Back first dismisses the OSD, then leaves the player.
        if (await video.isVisible()) await page.keyboard.press('Escape');
        await expect(trailer).toBeFocused();

        await trailer.click();
        await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
        await video.evaluate(element => element.dispatchEvent(new Event('ended')));
        await expect(trailer).toBeFocused();
        expect(requests.filter(url => /\/PlaybackInfo|\/Sessions\/Playing|\/MediaSegments\//.test(url))).toEqual([]);
        await expect(page.getByRole('button', { name: 'Mark watched', exact: true })).toBeVisible();
        if (test.info().project.name === 'chromium') {
            await page.getByRole('button', { name: /^▶ Play$/ }).click();
            await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
            await video.evaluate(element => element.dispatchEvent(new Event('ended')));
            await expect(page.getByRole('dialog', { name: 'Up next', exact: true })).toContainText('E2E Movie Two');
        }
    });

    test('trailer errors offer a working retry and an accessible return action', async ({ page }) => {
        const bytes = await readFile(new URL('../fake-server/media/sample.webm', import.meta.url));
        let fail = true;
        await page.route('**/Pgsql/Trailers/*/stream*', route => fail
            ? route.fulfill({ status: 503, body: 'Upstream secret diagnostics' })
            : route.fulfill({ contentType: 'video/webm', body: bytes }));
        await openTrailerDetails(page);
        await page.getByRole('button', { name: 'Watch trailer', exact: true }).click();
        const error = page.locator('.player-error');
        await expect(error).toContainText('This trailer could not be played.');
        await expect(error).not.toContainText('Upstream secret');
        await expect(error.getByRole('button', { name: 'Retry', exact: true })).toBeFocused();
        await expect(error.getByRole('button', { name: 'Convert the stream' })).toHaveCount(0);
        fail = false;
        await error.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect.poll(() => page.locator('video').evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
        await expect(error).toHaveCount(0);
        await page.locator('video').evaluate(element => element.dispatchEvent(new Event('error')));
        await error.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Watch trailer', exact: true })).toBeFocused();
    });

    test('the compact heart toggles favorites and actions fit the viewport', async ({ page }) => {
        await page.route('**/Users/*/FavoriteItems/e2e-movie-1', route => route.fulfill({ json: { IsFavorite: route.request().method() === 'POST' } }));
        await openTrailerDetails(page);
        const favorite = page.getByRole('button', { name: 'Add to favorites', exact: true });
        await expect(favorite).toHaveAttribute('aria-pressed', 'false');
        const rect = await favorite.boundingBox();
        expect(rect?.width).toBe(48);
        expect(rect?.height).toBe(48);
        await expect(favorite).toHaveText('');
        await favorite.click();
        await expect(page.getByRole('button', { name: 'Remove from favorites', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.screenshot({ path: test.info().outputPath('detail-actions.png') });
        const widths = test.info().project.name === 'mobile' ? [ 411, 360, 320 ] : [ page.viewportSize()?.width || 1280 ];
        for (const width of widths) {
            await page.setViewportSize({ width, height: page.viewportSize()?.height || 900 });
            const controls = await page.locator('.detail-actions button').evaluateAll(elements => elements.map(element => {
                const { left, right, width, height } = element.getBoundingClientRect();
                return { left, right, width, height, viewport: window.innerWidth };
            }));
            for (const control of controls) {
                expect(control.left).toBeGreaterThanOrEqual(0);
                expect(control.right).toBeLessThanOrEqual(control.viewport);
                expect(control.height).toBeGreaterThanOrEqual(48);
            }
        }
    });

    test('unsupported trailer metadata adds no action', async ({ page }) => {
        await openTrailerDetails(page, [ { Url: 'https://vimeo.com/123' }, { Url: 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ' } ]);
        await expect(page.getByRole('button', { name: 'Watch trailer', exact: true })).toHaveCount(0);
        await expect(page.locator('.detail-actions .button.primary')).toBeVisible();
    });
}
