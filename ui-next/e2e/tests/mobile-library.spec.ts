import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { MobileUiNextPage } from '../support/mobile-ui-next-page';

test('library controls fit at 411, 360, and 320 pixels', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');

    const controls = [
        page.getByRole('searchbox', { name: 'Search Movies', exact: true }),
        page.getByRole('button', { name: 'Filters', exact: true }),
        page.getByRole('button', { name: 'Select', exact: true }),
        page.getByRole('combobox', { name: 'Sort', exact: true })
    ];

    for (const { width, columns } of [ { width: 411, columns: 2 }, { width: 360, columns: 2 }, { width: 320, columns: 1 } ]) {
        await page.setViewportSize({ width, height: 869 });
        for (const control of controls) await expect(control).toBeVisible();

        const bounds = await Promise.all(controls.map(control => control.boundingBox()));
        for (const box of bounds) {
            expect(box).not.toBeNull();
            if (!box) continue;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
        }

        const hasHorizontalOverflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth);
        expect(hasHorizontalOverflow).toBe(false);
        const actualColumns = await page.locator('.library-grid-items').evaluate(element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length);
        expect(actualColumns).toBe(columns);
    }
});

test('poster actions stay inside cards with 48-pixel targets', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');

    const card = page.locator('.library-card').filter({ has: page.getByRole('button', { name: /^View E2E Movie One/ }) });
    await expect(card).toHaveCount(1);
    const cardBox = await card.boundingBox();
    const artworkBox = await card.locator('.library-card-art').boundingBox();
    expect(cardBox).not.toBeNull();
    expect(artworkBox).not.toBeNull();
    if (!cardBox || !artworkBox) return;

    for (const name of [ 'Play E2E Movie One', 'Toggle favorite', 'More actions' ]) {
        const action = card.getByRole('button', { name, exact: true });
        await expect(action).toBeVisible();
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        if (!box) continue;
        expect(box.width).toBeGreaterThanOrEqual(48);
        expect(box.height).toBeGreaterThanOrEqual(48);
        expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
        expect(box.y).toBeGreaterThanOrEqual(artworkBox.y + artworkBox.height);
    }
});

test('list actions stay below card content with 48-pixel targets', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('group', { name: 'Library view' }).getByRole('button', { name: 'List view', exact: true }).click();
    await page.setViewportSize({ width: 411, height: 869 });

    const card = page.locator('.library-card-list').filter({ has: page.getByRole('button', { name: /^View E2E Movie One/ }) });
    const content = card.getByRole('button', { name: /^View E2E Movie One/ });
    const cardBox = await card.boundingBox();
    const contentBox = await content.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    if (!cardBox || !contentBox) return;

    for (const name of [ 'Play E2E Movie One', 'Toggle favorite', 'More actions' ]) {
        const action = card.getByRole('button', { name, exact: true });
        await expect(action).toBeVisible();
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        if (!box) continue;
        expect(box.width).toBeGreaterThanOrEqual(48);
        expect(box.height).toBeGreaterThanOrEqual(48);
        expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
        expect(box.y).toBeGreaterThanOrEqual(contentBox.y + contentBox.height);
    }
});

test('Filters closes on Escape and Android Back without leaving Movies', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');

    const filtersButton = page.getByRole('button', { name: 'Filters', exact: true });
    const filtersDialog = page.getByRole('dialog', { name: 'Filters', exact: true });
    const librarySearch = page.getByRole('searchbox', { name: 'Search Movies', exact: true });

    await filtersButton.click();
    await expect(filtersDialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(filtersDialog).toBeHidden();
    await expect(filtersButton).toBeFocused();
    await expect(librarySearch).toBeVisible();

    await filtersButton.click();
    await expect(filtersDialog).toBeVisible();
    await page.locator('body').dispatchEvent('keydown', { key: 'Unidentified', keyCode: 461 });
    await expect(filtersDialog).toBeHidden();
    await expect(filtersButton).toBeFocused();
    await expect(librarySearch).toBeVisible();
});

test('opening Filters closes expanded Search', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');

    await page.getByRole('button', { name: 'Search your library', exact: true }).click();
    const globalSearch = page.getByRole('textbox', { name: 'Search your library', exact: true });
    await globalSearch.fill('space opera');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();

    const filtersDialog = page.getByRole('dialog', { name: 'Filters', exact: true });
    await expect(globalSearch).toBeHidden();
    await expect(filtersDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(filtersDialog).toBeHidden();

    await page.getByRole('button', { name: 'Search your library', exact: true }).click();
    await expect(globalSearch).toHaveValue('space opera');
});
