import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { disableCssGrid, tvViewports } from '../support/layout-assertions';
import { TvPage } from '../support/tv-page';

for (const viewport of tvViewports) {
    test(`TV filters stay usable in a side panel at ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await resetFakeServer();
        await page.setViewportSize(viewport);
        await disableCssGrid(page);

        const genres = Array.from({ length: 32 }, (_value, index) => ({ Id: `filter-genre-${index}`, Name: `Genre ${index + 1}` }));
        const years = Array.from({ length: 30 }, (_value, index) => ({ Id: `filter-year-${index}`, Name: String(2020 - index) }));
        await page.route(url => url.pathname === '/Genres', route => route.fulfill({ json: { Items: genres } }));
        await page.route(url => url.pathname === '/Years', route => route.fulfill({ json: { Items: years } }));
        await page.route(url => url.pathname === '/Items/Filters', route => route.fulfill({ json: {
            Tags: Array.from({ length: 20 }, (_value, index) => `Tag ${index + 1}`),
            OfficialRatings: [ 'G', 'PG', 'PG-13', 'R', 'TV-14', 'TV-MA' ]
        } }));

        const tv = new TvPage(page);
        await tv.open();
        await tv.openLibrary('Movies');
        const opener = page.getByRole('button', { name: 'Filters', exact: true });
        await opener.click();

        const dialog = page.getByRole('dialog', { name: 'Filters', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAttribute('aria-modal', 'true');
        const bounds = await dialog.boundingBox();
        expect(bounds).not.toBeNull();
        if (!bounds) return;
        expect(bounds.width / viewport.width).toBeGreaterThanOrEqual(0.3);
        expect(bounds.width / viewport.width).toBeLessThanOrEqual(0.4);
        expect(bounds.x + bounds.width).toBeCloseTo(viewport.width, 0);
        expect(bounds.y).toBe(0);
        expect(bounds.height).toBeCloseTo(viewport.height, 0);

        const content = dialog.locator('.library-tv-filter-content');
        await expect(content).toHaveCSS('overflow-y', 'auto');
        await expect.poll(() => content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
        await expect(dialog.getByRole('button', { name: 'Apply filters', exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Clear filters', exact: true })).toBeVisible();

        const genre = dialog.getByRole('button', { name: 'Genre 1', exact: true });
        await expect(genre).toHaveAttribute('aria-pressed', 'false');
        await genre.click();
        await expect(genre).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(async () => (await fakeServerRequests()).some(request => request.path === '/Items' && request.query.Genres === 'Genre 1')).toBe(false);

        const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
        await cancel.focus();
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await cancel.click();
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();

        await opener.click();
        const reopened = page.getByRole('dialog', { name: 'Filters', exact: true });
        await expect(reopened.getByRole('button', { name: 'Genre 1', exact: true })).toHaveAttribute('aria-pressed', 'false');
        await reopened.getByRole('button', { name: 'Genre 1', exact: true }).click();
        await reopened.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await expect(reopened).toHaveCount(0);
        await expect.poll(async () => (await fakeServerRequests()).some(request => request.path === '/Items' && request.query.Genres === 'Genre 1')).toBe(true);
    });
}
