import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { box, disableCssGrid, expectLoadedImage, expectNoPageOverflow } from '../support/layout-assertions';
import { TvPage } from '../support/tv-page';

test('webOS 4 library poster art fills its card with legacy button alignment', async ({ page }) => {
    await resetFakeServer();
    await disableCssGrid(page);
    const tv = new TvPage(page);
    await tv.open();
    await page.addStyleTag({ content: 'html.tv-client .library-card-open { display: flex; flex-direction: column; align-items: flex-start; } html.tv-client.tv-no-grid .library-card-art { width: auto; }' });
    await tv.openLibrary('Movies');

    const card = page.locator('.library-card[data-library-item-id]').first();
    const artwork = card.locator('.library-card-art');
    await expect(card).toBeVisible();

    const cardBounds = await box(card.locator('.library-card-open'));
    await expect.poll(() => artwork.evaluate(element => element.getBoundingClientRect().width))
        .toBeGreaterThanOrEqual(cardBounds.width * .95);
    await expectLoadedImage(artwork.locator('img'));
    await expectNoPageOverflow(page);
});
