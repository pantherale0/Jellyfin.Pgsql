import { expect, test, type Locator, type Page } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

async function openRecommendationHome(page: Page): Promise<{ hero: Locator; button: Locator }> {
    await resetFakeServer();
    await page.route(url => url.pathname === '/Movies/Recommendations', route => route.fulfill({
        json: [ {
            RecommendationType: 'HasLikedActor',
            Items: [
                { Id: 'e2e-movie-1', Name: 'E2E Movie One', Type: 'Movie', MediaType: 'Video', Overview: 'A deterministic movie.' },
                { Id: 'e2e-movie-2', Name: 'E2E Movie Two', Type: 'Movie', MediaType: 'Video', Overview: 'Another deterministic movie.' }
            ]
        } ]
    }));

    await new UiNextPage(page).openHome();
    const hero = page.locator('.recommendation-hero');
    const button = hero.getByRole('button', { name: 'View details', exact: true });
    await expect(button).toBeVisible();
    await hero.locator('.recommendation-copy').evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)));
    });
    return { hero, button };
}

test('View details opens immediately while the prefetched item continues loading', async ({ page }) => {
    let releaseDetails: () => void = () => undefined;
    let notifyRequestStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>(resolve => { notifyRequestStarted = resolve; });
    const detailsGate = new Promise<void>(resolve => { releaseDetails = resolve; });

    try {
        await page.route(url => url.pathname === '/Users/e2e-user-id/Items/e2e-movie-1', async route => {
            notifyRequestStarted();
            await detailsGate;
            await route.continue().catch(() => undefined);
        });
        const { hero, button } = await openRecommendationHome(page);
        await requestStarted;

        await button.click();
        await expect(page.locator('.detail-page')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'E2E Movie One', exact: true })).toBeVisible();
        await expect(page.getByText('Loading full details…', { exact: true })).toBeVisible();
        await expect(hero).toHaveCount(0);

        releaseDetails();
        await expect(page.getByText('Loading full details…', { exact: true })).toHaveCount(0);
        await expect.poll(async () => (await fakeServerRequests()).filter(request => request.path === '/Users/e2e-user-id/Items/e2e-movie-1').length).toBe(1);
    } finally {
        releaseDetails();
    }
});

test('a failed prefetch stays quiet on Home and is reported after detail navigation retries it', async ({ page }) => {
    await page.route(url => url.pathname === '/Users/e2e-user-id/Items/e2e-movie-1', route => route.fulfill({
        status: 503,
        contentType: 'application/json',
        json: { Message: 'Details are unavailable.' }
    }));
    const { hero, button } = await openRecommendationHome(page);
    await expect(hero.getByRole('alert')).toHaveCount(0);

    await button.click();

    const detailPage = page.locator('.detail-page');
    await expect(detailPage).toBeVisible();
    await expect(detailPage.getByRole('alert')).toBeVisible();
    await expect(detailPage.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    await expect(hero).toHaveCount(0);
});
