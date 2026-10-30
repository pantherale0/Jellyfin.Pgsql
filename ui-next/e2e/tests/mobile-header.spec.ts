import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { MobileUiNextPage } from '../support/mobile-ui-next-page';

test('header Search collapses on route navigation but retains its query', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');

    await page.getByRole('button', { name: 'Search your library', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Search your library', exact: true });
    await search.fill('space opera');

    await page.getByRole('button', { name: 'Open navigation menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Libraries' }).getByRole('button', { name: 'Home', exact: true }).click();

    await expect(search).toBeHidden();
    await page.getByRole('button', { name: 'Search your library', exact: true }).click();
    await expect(search).toHaveValue('space opera');
});

test('Search uses the compact placeholder only at phone widths', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');
    await page.getByRole('button', { name: 'Search your library', exact: true }).click();

    const search = page.getByRole('textbox', { name: 'Search your library', exact: true });
    await expect(search).toHaveAttribute('placeholder', 'Search…');

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(search).toHaveAttribute('placeholder', 'Search your library');

    await page.setViewportSize({ width: 411, height: 869 });
    await expect(search).toHaveAttribute('placeholder', 'Search…');
});

test('sticky header offsets include the top safe-area inset', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');
    await page.addStyleTag({ content: ':root { --safe-area-top: 24px; }' });

    const topbarHeight = await page.locator('.topbar').evaluate(element => getComputedStyle(element).height);
    const libraryStickyTop = await page.locator('.library-sticky').evaluate(element => getComputedStyle(element).top);

    expect(topbarHeight).toBe('80px');
    expect(libraryStickyTop).toBe('80px');
});

test('mobile season navigation and scroll offsets include the top safe-area inset', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Shows');
    await page.addStyleTag({ content: ':root { --safe-area-top: 24px; }' });
    await page.getByRole('button', { name: /^View E2E Series/ }).click();

    const seasonRail = page.locator('.season-mobile-rail');
    const seasonSection = page.locator('.season-section').first();
    const seasonHeader = page.locator('.season-section-header').first();
    await expect(seasonRail).toBeVisible();
    await expect(seasonSection).toBeVisible();

    const railTop = await seasonRail.evaluate(element => getComputedStyle(element).top);
    const sectionScrollMargin = await seasonSection.evaluate(element => getComputedStyle(element).scrollMarginTop);
    const sectionHeaderTop = await seasonHeader.evaluate(element => getComputedStyle(element).top);
    expect(railTop).toBe('80px');
    expect(sectionScrollMargin).toBe('150px');
    expect(sectionHeaderTop).toBe('142px');
});
