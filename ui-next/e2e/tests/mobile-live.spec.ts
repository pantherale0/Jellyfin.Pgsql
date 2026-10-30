import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { MobileUiNextPage } from '../support/mobile-ui-next-page';

test('Guide first row clears the header after switching from a scrolled tab', async ({ page }) => {
    await resetFakeServer();
    const now = Date.now();
    const startsAt = new Date(now - 15 * 60_000).toISOString();
    const endsAt = new Date(now + 45 * 60_000).toISOString();
    const channels = Array.from({ length: 24 }, (_, index) => ({
        Id: `e2e-channel-${index + 1}`,
        Name: `E2E Channel ${index + 1}`,
        Type: 'TvChannel',
        ChannelNumber: String(index + 1),
        ImageTags: { Primary: `channel-${index + 1}` },
        UserData: { IsFavorite: false }
    }));
    const programs = channels.slice(0, -1).map((channel, index) => ({
        Id: `e2e-program-${index + 1}`,
        Name: `E2E Program ${index + 1}`,
        Type: 'Program',
        MediaType: 'Video',
        ChannelId: channel.Id,
        ChannelName: channel.Name,
        ChannelNumber: channel.ChannelNumber,
        StartDate: startsAt,
        EndDate: endsAt,
        ImageTags: { Primary: `program-${index + 1}` },
        UserData: { IsFavorite: false, Played: false }
    }));
    await page.route('**/LiveTv/Channels*', route => route.fulfill({ json: { Items: channels, TotalRecordCount: channels.length } }));
    await page.route('**/LiveTv/Programs*', route => route.fulfill({ json: { Items: programs, TotalRecordCount: programs.length } }));

    const app = new MobileUiNextPage(page);
    await app.openLiveTab('now');
    const onNowTab = page.getByRole('tab', { name: 'On Now', exact: true });
    await expect(onNowTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /E2E Program/ })).toHaveCount(23);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await app.openLiveTab('guide');
    await expect(page.getByRole('tab', { name: 'Guide', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('No program data available').first()).toBeVisible();

    const header = await page.locator('.topbar').boundingBox();
    const firstChannel = await page.locator('.live-now-next-card').first().boundingBox();
    expect(header).not.toBeNull();
    expect(firstChannel).not.toBeNull();
    if (!header || !firstChannel) return;
    expect(firstChannel.y).toBeGreaterThanOrEqual(header.y + header.height);
});
