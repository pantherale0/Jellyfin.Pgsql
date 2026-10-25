import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

test('a finished movie hides the player controls and offers similar titles', async ({ page }) => {
    await resetFakeServer();
    const mediaEvents: string[] = [];
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/Videos/e2e-movie-2/stream') mediaEvents.push('request');
    });
    page.on('response', response => {
        if (new URL(response.url()).pathname === '/Videos/e2e-movie-2/stream') mediaEvents.push(`response:${response.status()}`);
    });
    page.on('requestfailed', request => {
        if (new URL(request.url()).pathname === '/Videos/e2e-movie-2/stream') mediaEvents.push(`failed:${request.failure()?.errorText || 'unknown'}`);
    });
    await page.route(url => url.pathname === '/Items/e2e-movie-1/Similar', route => route.fulfill({
        json: {
            Items: [ {
                Id: 'e2e-movie-2',
                Name: 'E2E Movie Two',
                Type: 'Movie',
                MediaType: 'Video',
                ParentId: 'e2e-movies-library',
                ProductionYear: 2023,
                RunTimeTicks: 300_000_000,
                ImageTags: { Primary: 'movie-2-image' },
                UserData: { Played: false, IsFavorite: true, PlaybackPositionTicks: 0 }
            } ],
            TotalRecordCount: 1
        }
    }));

    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await app.startMoviePlayback();

    const video = page.locator('video');
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The player video element is missing.');
        element.pause();
        element.dispatchEvent(new Event('ended'));
    });

    const endScreen = page.locator('.player-end-screen');
    await expect(endScreen).toBeVisible();
    await expect(page.locator('.player-stage')).toHaveAttribute('data-osd-open', 'false');
    await expect(page.locator('.player-osd-top')).toHaveCSS('opacity', '0');
    const recommendation = endScreen.getByRole('button', { name: 'Play E2E Movie Two' });
    await expect(recommendation).toBeVisible();
    const artwork = recommendation.locator('img');
    await expect(artwork).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => artwork.evaluate(image => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBeGreaterThan(0);
    await expect(endScreen.getByRole('button', { name: 'Replay' })).toBeVisible();

    await recommendation.click();
    await expect.poll(async () => (await fakeServerRequests()).filter(request => request.path === '/Items/e2e-movie-2/PlaybackInfo').length).toBe(1);
    await page.waitForTimeout(300);
    const playbackState = await video.evaluate(element => element instanceof HTMLVideoElement ? {
        currentSrc: element.currentSrc,
        paused: element.paused,
        currentTime: element.currentTime,
        readyState: element.readyState,
        networkState: element.networkState,
        error: element.error?.code
    } : null);
    expect(playbackState, JSON.stringify({ playbackState, mediaEvents })).toMatchObject({ paused: false });
    expect(playbackState?.currentTime).toBeGreaterThan(0);
});
