import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

test('home Explore loads another page in the same rail', async ({ page }) => {
    await resetFakeServer();
    const exploreItems = Array.from({ length: 48 }, (_item, index) => ({
        Id: `home-explore-${index + 1}`,
        Name: `Home Explore Movie ${index + 1}`,
        Type: 'Movie',
        MediaType: 'Video',
        ParentId: 'e2e-movies-library',
        ProductionYear: 2024,
        UserData: { Played: false, IsFavorite: false, PlaybackPositionTicks: 0 }
    }));

    let homePageRequests = 0;
    await page.route('**/Items*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname !== '/Items' || url.searchParams.get('SortBy') !== 'DateCreated,SortName') {
            await route.continue();
            return;
        }

        homePageRequests++;
        const start = Number(url.searchParams.get('StartIndex')) || 0;
        const limit = Number(url.searchParams.get('Limit')) || 24;
        await route.fulfill({
            contentType: 'application/json',
            json: { Items: exploreItems.slice(start, start + limit), TotalRecordCount: exploreItems.length }
        });
    });

    const app = new UiNextPage(page);
    await app.openHome();
    await expect.poll(() => homePageRequests).toBeGreaterThan(0);
    await expect.poll(async () => (await fakeServerRequests()).filter(request => request.path === '/Items' && request.query.SortBy === 'Random').length).toBe(5);
    const themeRequests = (await fakeServerRequests()).filter(request => request.path === '/Items' && request.query.SortBy === 'Random');
    expect(themeRequests.every(request => request.status === 200)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    const exploreRail = page.locator('.home-feed-rail').filter({ has: page.getByRole('heading', { name: 'Explore your library', exact: true }) });
    await expect(exploreRail).toHaveCount(1);
    await expect(exploreRail.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
    await exploreRail.getByRole('button', { name: 'Show more', exact: true }).click();

    await expect(exploreRail.getByRole('button', { name: /^View Home Explore Movie 25/ })).toBeVisible();
    await expect(page.locator('.home-feed-rail-heading h2', { hasText: 'More from your library' })).toHaveCount(0);
});

test('retrying Home starts a fresh Explore request while the stale theme request is pending', async ({ page }) => {
    await resetFakeServer();
    let themeRequests = 0;
    let firstThemeUrl = '';
    let releaseFirstTheme: () => void = () => undefined;
    let notifyFirstTheme: () => void = () => undefined;
    const firstThemeStarted = new Promise<void>(resolve => { notifyFirstTheme = resolve; });
    const holdFirstTheme = new Promise<void>(resolve => { releaseFirstTheme = resolve; });

    await page.route('**/Items*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname !== '/Items' || url.searchParams.get('SortBy') !== 'Random' || url.searchParams.get('Limit') !== '36') {
            await route.continue();
            return;
        }

        themeRequests += 1;
        if (themeRequests === 1) {
            firstThemeUrl = route.request().url();
            notifyFirstTheme();
            await holdFirstTheme;
            await route.fulfill({
                status: 503,
                contentType: 'application/json',
                json: { Message: 'The prior home load failed.' }
            });
            return;
        }
        await route.fulfill({ contentType: 'application/json', json: { Items: [], TotalRecordCount: 0 } });
    });
    await page.route('**/Movies/Recommendations*', route => route.fulfill({
        status: 503,
        contentType: 'application/json',
        json: { Message: 'Temporary recommendation failure.' }
    }));

    try {
        await new UiNextPage(page).openHome();
        await firstThemeStarted;
        const discoveryNotice = page.getByRole('status').filter({ hasText: 'Some discovery rows could not load.' });
        await expect(discoveryNotice).toBeVisible();
        await discoveryNotice.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect.poll(() => themeRequests).toBeGreaterThan(1);
        const staleResponse = page.waitForResponse(response => response.url() === firstThemeUrl && response.status() === 503);
        releaseFirstTheme();
        await staleResponse;
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(page.getByRole('heading', { name: 'More titles could not load', exact: true })).toHaveCount(0);
    } finally {
        releaseFirstTheme();
    }
});
