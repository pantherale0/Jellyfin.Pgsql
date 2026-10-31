import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';

test('Guide uses channel logos and falls back to readable names when they are unavailable', async ({ page }) => {
    await resetFakeServer();
    await page.setViewportSize({ width: 820, height: 900 });
    const imagePaths: string[] = [];
    const channels = [
        {
            Id: 'e2e-logo-channel',
            Name: 'Family News',
            Type: 'TvChannel',
            ChannelNumber: '7',
            ImageTags: { Primary: 'family-logo' }
        },
        {
            Id: 'e2e-no-logo-channel',
            Name: 'World News International',
            Type: 'TvChannel',
            ChannelNumber: '8',
            ImageTags: {},
            BackdropImageTags: [ 'generic-backdrop' ]
        },
        {
            Id: 'e2e-broken-logo-channel',
            Name: 'Community Television',
            Type: 'TvChannel',
            ChannelNumber: '9',
            ImageTags: { Logo: 'broken-logo' }
        }
    ];

    await page.route('**/LiveTv/Channels*', route => route.fulfill({ json: { Items: channels, TotalRecordCount: channels.length } }));
    await page.route('**/LiveTv/Programs*', route => route.fulfill({ json: { Items: [], TotalRecordCount: 0 } }));
    await page.route('**/Items/*/Images/*', async route => {
        const pathname = new URL(route.request().url()).pathname;
        imagePaths.push(pathname);
        if (pathname.includes('/e2e-broken-logo-channel/')) {
            await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
            return;
        }
        await route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="48"><rect width="180" height="48" fill="#8bd450"/></svg>'
        });
    });

    await page.goto('/?live=guide');

    const logoChannel = page.locator('#live-channel-e2e-logo-channel');
    await expect(logoChannel).toBeVisible();
    const logo = logoChannel.locator('img');
    await expect(logo).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => logo.evaluate(image => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBeGreaterThan(0);
    await expect(logoChannel).not.toContainText('Family News');
    await expect(logoChannel).toHaveAttribute('aria-label', 'Channel 7: Family News');
    const logoSlot = logoChannel.locator('.live-logo');
    await expect(logoSlot).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const logoSlotBounds = await logoSlot.boundingBox();
    expect(logoSlotBounds).not.toBeNull();
    if (logoSlotBounds) expect(logoSlotBounds.width).toBeLessThanOrEqual(96);

    const missingLogo = page.locator('#live-channel-e2e-no-logo-channel');
    await expect(missingLogo).toHaveAttribute('aria-label', 'Channel 8: World News International');
    await expect(missingLogo.getByText('World News International', { exact: true })).toBeVisible();
    await expect(missingLogo.locator('img')).toHaveCount(0);

    const brokenLogo = page.locator('#live-channel-e2e-broken-logo-channel');
    await expect(brokenLogo.getByText('Community Television', { exact: true })).toBeVisible();
    await expect(brokenLogo.locator('img')).toHaveCount(0);
    expect(imagePaths).not.toContain('/Items/e2e-no-logo-channel/Images/Backdrop');
    expect(imagePaths).toContain('/Items/e2e-logo-channel/Images/Primary');
    expect(imagePaths).toContain('/Items/e2e-broken-logo-channel/Images/Logo');

    const channelCell = page.locator('.live-channel').first();
    const programTrack = page.locator('.live-track').first();
    const channelBounds = await channelCell.boundingBox();
    const trackBounds = await programTrack.boundingBox();
    expect(channelBounds).not.toBeNull();
    expect(trackBounds).not.toBeNull();
    if (channelBounds && trackBounds) expect(Math.abs(trackBounds.x - (channelBounds.x + channelBounds.width))).toBeLessThan(1);

    const favoriteBounds = await page.getByRole('button', { name: 'Add Family News to favorites', exact: true }).boundingBox();
    expect(favoriteBounds).not.toBeNull();
    if (favoriteBounds) expect(favoriteBounds.width).toBeGreaterThanOrEqual(48);
});
