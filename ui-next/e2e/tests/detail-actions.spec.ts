import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

test('a shared item link opens the title in UI Next', async ({ page }) => {
    await resetFakeServer();
    await page.goto('/?item=e2e-movie-1');
    await expect(page.locator('.detail-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'E2E Movie One', exact: true })).toBeVisible();
    await expect.poll(() => page.url()).not.toContain('item=');

    await expect(page.locator('.detail-page > .detail-content')).toBeVisible();
    const hero = await page.locator('.detail-content').boundingBox();
    const body = await page.locator('.detail-body').boundingBox();
    expect(body!.width).toBeGreaterThan(hero!.width);
});

test('detail actions live behind the More menu and copy a deep link', async ({ page }) => {
    await resetFakeServer();
    await page.context().grantPermissions([ 'clipboard-read', 'clipboard-write' ]);
    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();

    await page.getByRole('button', { name: 'More', exact: true }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Share', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Add to playlist', exact: true })).toBeVisible();

    await menu.getByRole('menuitem', { name: 'Share', exact: true }).click();
    await expect(page.getByText('Link copied.', { exact: false })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('item=e2e-movie-1');
});
