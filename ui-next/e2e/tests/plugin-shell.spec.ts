import { expect, test } from '@playwright/test';

test('plugin settings do not link to the classic dashboard', async ({ page }) => {
    await page.goto('/e2e/fixtures/plugin-shell.html');

    await expect(page.getByRole('heading', { name: 'Fixture plugin' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Classic dashboard' })).toHaveCount(0);
});
