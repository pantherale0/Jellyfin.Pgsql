import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { captureLayout, expectInViewport, expectNoPageOverflow } from '../support/layout-assertions';
import { MobileUiNextPage } from '../support/mobile-ui-next-page';

for (const width of [ 411, 360, 320 ]) {
    test(`TV sizing does not leak into the ${width}px mobile library`, async ({ page }, testInfo) => {
        await resetFakeServer();
        await page.setViewportSize({ width, height: 869 });
        const app = new MobileUiNextPage(page);
        await app.openHome();
        await expect(page.locator('html.tv-client')).toHaveCount(0);
        await app.openLibrary('Movies');
        for (const control of [
            page.getByRole('button', { name: 'Search your library', exact: true }),
            page.getByRole('button', { name: 'Filters', exact: true }),
            page.getByRole('combobox', { name: 'Sort', exact: true })
        ]) await expectInViewport(control, page);
        await expect(page.getByRole('searchbox', { name: 'Search Movies', exact: true })).toHaveCount(0);
        await expectInViewport(page.locator('[data-library-item-id="e2e-movie-1"]'), page);
        await expectNoPageOverflow(page);
        await captureLayout(page, testInfo, 'mobile-library');
    });
}
