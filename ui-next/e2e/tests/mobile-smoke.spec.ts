import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { MobileUiNextPage } from '../support/mobile-ui-next-page';

test('mobile smoke opens Movies through the drawer', async ({ page }) => {
    await resetFakeServer();
    const app = new MobileUiNextPage(page);
    await app.openHome();

    const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        hasCoarsePointer: window.matchMedia('(pointer: coarse)').matches
    }));
    expect(viewport).toEqual({ width: 411, height: 869, hasCoarsePointer: true });
    await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible();

    await app.openLibrary('Movies');

    await expect(page.getByRole('searchbox', { name: 'Search Movies', exact: true })).toBeVisible();
});
