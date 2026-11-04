import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { box } from '../support/layout-assertions';
import { TvPage } from '../support/tv-page';

test('TV Home returns to the hero after scroll restoration and navigation', async ({ page }) => {
    await resetFakeServer();
    const tv = new TvPage(page);
    await tv.open();

    const hero = page.locator('.recommendation-hero, .welcome-hero').first();
    const eyebrow = hero.locator('.eyebrow');
    await expect(hero).toBeVisible();
    await expect(page.locator('.home-feed-rail').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(212);

    // Keep the document scroll range stable when changing views, as webOS does.
    await page.addStyleTag({ content: '.app-shell { min-height: 3000px !important; }' });
    await tv.openLibrary('Movies');
    await expect(page.getByRole('button', { name: /^View E2E Movie One/ })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 212));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(212);
    await page.locator('.primary-nav').getByRole('button', { name: 'Home', exact: true }).dispatchEvent('click');
    await expect(page.locator('.home-feed-rail').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    const headerBounds = await box(page.locator('.topbar'));
    const eyebrowBounds = await box(eyebrow);
    expect(eyebrowBounds.y).toBeGreaterThanOrEqual(headerBounds.y + headerBounds.height);
    await expect(hero.locator('h1')).toBeInViewport();

    const firstRail = page.locator('.home-feed-rail').first();
    await expect(firstRail).toBeVisible();
    const firstArtwork = await box(firstRail.locator('.home-feed-card-art').first());
    expect(firstArtwork.y).toBeLessThanOrEqual(1080 - 96);

    await page.evaluate(() => window.scrollTo(0, 212));
    await page.locator('.home-feed-card').first().dispatchEvent('click');
    await expect(page.locator('.detail-page')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(212);
    await tv.pressRemoteBack();
    await expect(page.locator('.detail-page')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(212);

    await page.evaluate(() => window.scrollTo(0, 212));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(212);
    await page.reload();
    await expect(page.locator('html.tv-client')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(eyebrow).toBeInViewport();
});
