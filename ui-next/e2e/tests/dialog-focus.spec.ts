import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

const focusIsInMenu = () => Boolean((document.activeElement as HTMLElement | null)?.closest('[role="menu"]'));

test('a library card menu traps focus and remote Back restores it to the opener', async ({ page }) => {
    await resetFakeServer();
    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();

    const card = page.locator('.library-card[data-library-item-id="e2e-movie-1"]');
    await card.hover();
    await card.getByRole('button', { name: 'More actions' }).click();

    const menu = page.getByRole('menu', { name: 'Actions for E2E Movie One' });
    await expect(menu).toBeVisible();
    await expect.poll(() => page.evaluate(focusIsInMenu)).toBe(true);

    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(focusIsInMenu)).toBe(true);

    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'GoBack', bubbles: true })));
    await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'))).toBe('More actions');
});
