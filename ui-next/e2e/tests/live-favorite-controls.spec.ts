import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';

test('Guide favorites stay visible and the Channels directory has no favorite control', async ({ page }) => {
    await resetFakeServer();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/LiveTv/Channels*', route => route.fulfill({
        json: {
            Items: [ {
                Id: 'e2e-family-channel',
                Name: 'Family News',
                Type: 'TvChannel',
                ChannelNumber: '7',
                UserData: { IsFavorite: false }
            } ],
            TotalRecordCount: 1
        }
    }));
    await page.route('**/LiveTv/Programs*', route => route.fulfill({ json: { Items: [], TotalRecordCount: 0 } }));

    await page.goto('/?live=channels');
    const directoryRow = page.locator('.live-channel-list li').filter({ hasText: 'Family News' });
    await expect(directoryRow).toBeVisible();
    await expect(directoryRow.getByRole('button', { name: 'Add Family News to favorites', exact: true })).toHaveCount(0);

    const directoryTune = directoryRow.locator('.live-directory-tune');
    const moveEarlier = directoryRow.getByRole('button', { name: 'Move Family News earlier', exact: true });
    const tuneBounds = await directoryTune.boundingBox();
    const moveBounds = await moveEarlier.boundingBox();
    expect(tuneBounds).not.toBeNull();
    expect(moveBounds).not.toBeNull();
    if (tuneBounds && moveBounds) expect(moveBounds.x - (tuneBounds.x + tuneBounds.width)).toBeLessThan(12);

    await page.goto('/?live=guide');
    const guideRow = page.locator('.live-channel').filter({ hasText: 'Family News' });
    const guideStar = guideRow.getByRole('button', { name: 'Add Family News to favorites', exact: true });
    await expect(guideStar).toHaveCSS('opacity', '1');
    const guideStarBounds = await guideStar.boundingBox();
    expect(guideStarBounds).not.toBeNull();
    if (guideStarBounds) expect(guideStarBounds.width).toBeGreaterThanOrEqual(48);

    await guideRow.locator('.live-channel-tune').focus();
    await page.keyboard.press('Tab');
    await expect(guideStar).toBeFocused();
});
