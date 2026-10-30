import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { MobileUiNextPage } from '../support/mobile-ui-next-page';

test('Home hero reveals the first card', async ({ page }) => {
    await resetFakeServer();
    const recentMovie = {
        Id: 'e2e-movie-1',
        Name: 'E2E Movie One',
        Type: 'Movie',
        MediaType: 'Video',
        ParentId: 'e2e-movies-library',
        ProductionYear: 2024,
        PremiereDate: new Date().toISOString(),
        RunTimeTicks: 300_000_000,
        ImageTags: { Primary: 'movie-1-image' },
        UserData: { Played: false, IsFavorite: false, PlaybackPositionTicks: 0 }
    };
    await page.route(url => {
        const requestUrl = new URL(url);
        return requestUrl.pathname === '/Items' && requestUrl.searchParams.has('MinPremiereDate');
    }, route => route.fulfill({ json: { Items: [ recentMovie ], TotalRecordCount: 1 } }));

    const app = new MobileUiNextPage(page);
    await app.openHome();
    await expect(page.getByRole('region', { name: 'Recommended for you' })).toBeVisible();

    const nextSection = page.locator('.home-feed-block').first();
    const heading = nextSection.getByRole('heading').first();
    const firstCard = nextSection.getByRole('button', { name: /^View / }).first();
    await expect(heading).toBeVisible();
    await expect(firstCard).toBeVisible();

    const headingBox = await heading.boundingBox();
    const cardBox = await firstCard.boundingBox();
    const visualHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
    expect(headingBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    if (!headingBox || !cardBox) return;

    expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(visualHeight);
    const visibleCardHeight = Math.max(0, Math.min(cardBox.y + cardBox.height, visualHeight) - Math.max(0, cardBox.y));
    expect(visibleCardHeight).toBeGreaterThanOrEqual(120);

    await page.setViewportSize({ width: 360, height: 800 });
    const narrowHeadingBox = await heading.boundingBox();
    const narrowVisualHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
    expect(narrowHeadingBox).not.toBeNull();
    if (!narrowHeadingBox) return;
    expect(narrowHeadingBox.y + narrowHeadingBox.height).toBeLessThanOrEqual(narrowVisualHeight);
});
