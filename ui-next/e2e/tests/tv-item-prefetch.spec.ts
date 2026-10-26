import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { TvPage } from '../support/tv-page';

test('TV focus starts a prefetch for the focused poster', async ({ page }) => {
    await resetFakeServer();
    await page.route(url => url.pathname === '/Movies/Recommendations', route => route.fulfill({
        json: [ {
            RecommendationType: 'HasLikedActor',
            Items: [
                { Id: 'e2e-movie-2', Name: 'E2E Movie Two', Type: 'Movie', MediaType: 'Video' },
                { Id: 'e2e-movie-3', Name: 'E2E Movie Three', Type: 'Movie', MediaType: 'Video' }
            ]
        } ]
    }));

    const tv = new TvPage(page);
    await tv.open();
    await tv.openLibrary('Movies');
    await page.getByRole('button', { name: /^View E2E Movie One/ }).focus();
    await expect.poll(async () => (await fakeServerRequests()).filter(request =>
        request.path === '/Users/e2e-user-id/Items/e2e-movie-1' && request.query.Fields?.includes('MediaSources')
    ).length).toBe(1);
});
