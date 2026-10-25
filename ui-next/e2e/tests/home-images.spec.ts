import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

test('home feed artwork loads with the signed-in Jellyfin session', async ({ page }) => {
    await resetFakeServer();
    let authorizedRequests = 0;
    let unauthorizedRequests = 0;

    await page.route('**/Items/*/Images/*', async route => {
        const authorization = route.request().headers().authorization || '';
        if (authorization.includes('Token="e2e-access-token"')) {
            authorizedRequests += 1;
            await route.continue();
            return;
        }

        unauthorizedRequests += 1;
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{"Message":"Unauthorized."}' });
    });

    await new UiNextPage(page).openHome();
    const firstCard = page.locator('.home-feed-card').first();
    await expect(firstCard).toBeVisible();
    await firstCard.scrollIntoViewIfNeeded();
    await expect.poll(() => authorizedRequests + unauthorizedRequests).toBeGreaterThan(0);
    expect(unauthorizedRequests).toBe(0);

    const artwork = firstCard.locator('img');
    await expect(artwork).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => artwork.evaluate(image => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBeGreaterThan(0);
});

test('home spotlight artwork loads with the signed-in Jellyfin session', async ({ page }) => {
    await resetFakeServer();
    let authorizedRequests = 0;
    let unauthorizedRequests = 0;

    await page.route(url => url.pathname === '/Items' && url.searchParams.get('IncludeItemTypes') === 'BoxSet', route => route.fulfill({
        json: {
            Items: [ {
                Id: 'e2e-home-spotlight',
                Name: 'E2E Spotlight Collection',
                Type: 'BoxSet',
                ChildCount: 3,
                ImageTags: { Primary: 'spotlight-primary' },
                BackdropImageTags: [ 'spotlight-backdrop' ]
            } ],
            TotalRecordCount: 1
        }
    }));
    await page.route('**/Items/*/Images/*', async route => {
        const authorization = route.request().headers().authorization || '';
        if (authorization.includes('Token="e2e-access-token"')) {
            authorizedRequests += 1;
            await route.continue();
            return;
        }

        unauthorizedRequests += 1;
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{"Message":"Unauthorized."}' });
    });

    await new UiNextPage(page).openHome();
    const requestsBeforeSpotlight = authorizedRequests + unauthorizedRequests;
    await page.locator('.home-feed-block-placeholder').first().scrollIntoViewIfNeeded();
    const spotlight = page.locator('.home-spotlight').first();
    await expect(spotlight).toBeVisible();
    await expect.poll(() => authorizedRequests + unauthorizedRequests).toBeGreaterThan(requestsBeforeSpotlight);
    expect(unauthorizedRequests).toBe(0);

    const artwork = spotlight.locator('.home-spotlight-background img');
    await expect(artwork).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => artwork.evaluate(image => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBeGreaterThan(0);
    expect(authorizedRequests).toBeGreaterThan(0);
});
