import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

test('profile menu does not expose the classic dashboard', async ({ page }) => {
    await resetFakeServer();
    await page.route('**/Users/Me', async route => {
        const response = await route.fetch();
        const user = await response.json();
        await route.fulfill({
            response,
            body: JSON.stringify({ ...user, Policy: { ...user.Policy, IsAdministrator: true } })
        });
    });

    const app = new UiNextPage(page);
    await app.openHome();
    await page.getByRole('button', { name: /Open .* menu/ }).click();

    await expect(page.getByRole('menuitem', { name: /Classic dashboard/ })).toHaveCount(0);
});
