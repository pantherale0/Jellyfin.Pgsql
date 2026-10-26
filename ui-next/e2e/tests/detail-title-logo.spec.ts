import { expect, test, type Page } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function addLogoTag(page: Page, itemId: string): Promise<void> {
    await page.route(url => url.pathname === `/Users/e2e-user-id/Items/${itemId}`, async route => {
        const response = await route.fetch();
        const payload: unknown = await response.json();
        if (!isRecord(payload)) throw new Error(`The ${itemId} detail fixture is invalid.`);
        const imageTags = isRecord(payload.ImageTags) ? payload.ImageTags : {};
        await route.fulfill({ response, json: { ...payload, ImageTags: { ...imageTags, Logo: `${itemId}-logo` } } });
    });
}

async function addSeriesLogoToLibrary(page: Page): Promise<void> {
    await page.route(url => url.pathname === '/Items' && url.searchParams.get('ParentId') === 'e2e-shows-library', async route => {
        const response = await route.fetch();
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.Items)) throw new Error('The shows library fixture is invalid.');
        const items = payload.Items.map(item => {
            if (!isRecord(item) || item.Id !== 'e2e-series-1') return item;
            const imageTags = isRecord(item.ImageTags) ? item.ImageTags : {};
            return { ...item, ImageTags: { ...imageTags, Logo: 'e2e-series-logo' } };
        });
        await route.fulfill({ response, json: { ...payload, Items: items } });
    });
}

async function expectLoadedTitleLogo(page: Page, name: string): Promise<void> {
    const logo = page.getByRole('img', { name, exact: true });
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate(image => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}

test('item details use the available media logo and retain a text title when no logo exists', async ({ page }) => {
    await resetFakeServer();
    await addLogoTag(page, 'e2e-movie-1');

    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await expectLoadedTitleLogo(page, 'E2E Movie One');

    await app.returnToMoviesLibrary();
    await page.getByRole('button', { name: /^View E2E Movie Two/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Movie Two', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'E2E Movie Two', exact: true })).toHaveCount(0);
});

test('TV-series details use their media logo in the show hero', async ({ page }) => {
    await resetFakeServer();
    await addSeriesLogoToLibrary(page);
    await addLogoTag(page, 'e2e-series-1');

    const app = new UiNextPage(page);
    await app.openHome();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Shows', exact: true }).click();
    await page.getByRole('button', { name: /^View E2E Series/ }).click();
    await expect(page.locator('.show-detail-view')).toBeVisible();
    await expectLoadedTitleLogo(page, 'E2E Series');
});
