import { expect, test, type Page } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { box, captureLayout, disableCssGrid, expectControl, expectNoPageOverflow, expectTextSize, tvMinimums, tvViewports } from '../support/layout-assertions';
import { TvPage } from '../support/tv-page';

type TvViewport = typeof tvViewports[number];

async function openPlaybackSettings(page: Page, viewport: TvViewport, withoutGrid = false): Promise<void> {
    await resetFakeServer();
    await page.setViewportSize(viewport);
    if (withoutGrid) await disableCssGrid(page);
    await new TvPage(page).open();

    await page.getByRole('button', { name: /^Open .* menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Playback', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Playback preferences', exact: true })).toBeVisible();
}

async function expectPlaybackSettingsLayout(page: Page, viewport: TvViewport, testInfo: Parameters<typeof captureLayout>[1]): Promise<void> {
    const settings = page.locator('.profile-settings-grid');
    const sections = settings.locator(':scope > .profile-form');
    await expect(sections).toHaveCount(4);

    const playback = await box(sections.nth(0));
    const qualitySection = sections.nth(1);
    const quality = await box(qualitySection);
    const skipping = await box(sections.nth(2));
    const music = await box(sections.nth(3));
    expect(playback.x).toBeLessThan(quality.x);
    expect(Math.abs(playback.y - quality.y)).toBeLessThanOrEqual(2);
    expect(skipping.x).toBe(playback.x);
    expect(music.x).toBe(quality.x);
    expect(skipping.y).toBeGreaterThan(playback.y);
    expect(Math.abs(skipping.y - music.y)).toBeLessThanOrEqual(2);
    expect(playback.width).toBeGreaterThanOrEqual(viewport.width * .35);
    expect(quality.width).toBeGreaterThanOrEqual(viewport.width * .35);

    const minimum = tvMinimums(viewport.height);
    const bitrate = page.getByRole('combobox', { name: 'Maximum bitrate' });
    await expectTextSize(bitrate.locator('xpath=..'), minimum.metadata);
    await expectControl(bitrate, page, minimum.control);
    await expectControl(page.locator('.profile-checkbox').filter({ hasText: 'Prefer default audio track' }), page, minimum.control);

    const save = page.getByRole('button', { name: 'Save playback preferences', exact: true });
    await save.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => qualitySection.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await expectNoPageOverflow(page);
    await captureLayout(page, testInfo, 'tv-playback-settings');
}

for (const viewport of tvViewports) {
    test(`playback settings use readable TV cards at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
        await openPlaybackSettings(page, viewport);
        await expectPlaybackSettingsLayout(page, viewport, testInfo);
    });
}

test('playback settings keep two columns in the webOS CSS-grid fallback', async ({ page }, testInfo) => {
    const viewport = tvViewports[1];
    await openPlaybackSettings(page, viewport, true);
    await expect(page.locator('html.tv-no-grid')).toHaveCount(1);
    await expectPlaybackSettingsLayout(page, viewport, testInfo);
});
