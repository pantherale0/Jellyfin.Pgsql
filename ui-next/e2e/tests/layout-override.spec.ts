import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';

test('an explicit tv layout choice overrides a desktop user agent', async ({ page }) => {
    await resetFakeServer();
    await page.goto('/?layout=tv');
    await expect(page.locator('html.tv-client')).toHaveCount(1);
});

test('the default desktop user agent stays in the desktop layout', async ({ page }) => {
    await resetFakeServer();
    await page.goto('/');
    await expect(page.locator('html.tv-client')).toHaveCount(0);
});
