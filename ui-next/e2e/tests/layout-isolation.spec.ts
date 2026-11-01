import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { box, captureLayout, expectInViewport, expectNoPageOverflow, tvViewports } from '../support/layout-assertions';
import { UiNextPage } from '../support/ui-next-page';

for (const viewport of tvViewports) {
    test(`desktop remains a usable non-TV layout at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
        await resetFakeServer();
        await page.setViewportSize(viewport);
        const app = new UiNextPage(page);
        await app.openHome();
        await expect(page.locator('html.tv-client')).toHaveCount(0);
        await expectInViewport(page.getByRole('button', { name: 'Home', exact: true }), page);
        await app.openMoviesLibrary();
        const second = page.locator('[data-library-item-id="e2e-movie-2"]');
        const first = page.locator('[data-library-item-id="e2e-movie-1"]');
        await expectInViewport(first, page);
        expect((await box(first)).width).toBeGreaterThan(100);
        expect((await box(second)).x).toBeGreaterThan((await box(first)).x + (await box(first)).width);
        expect(Math.abs((await box(second)).y - (await box(first)).y)).toBeLessThanOrEqual(2);
        await expectNoPageOverflow(page);
        await captureLayout(page, testInfo, 'desktop-library');
        await app.openMovieDetails();
        await expectInViewport(page.getByRole('button', { name: /^▶ Play$/ }), page);
        await captureLayout(page, testInfo, 'desktop-detail');
    });
}
