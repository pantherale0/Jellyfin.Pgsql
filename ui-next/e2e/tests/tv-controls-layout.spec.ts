import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { box, captureLayout, expectControl, expectInViewport, expectNoPageOverflow, expectTextSize, tvMinimums, tvViewports } from '../support/layout-assertions';
import { guideChannelName, guideProgramName, installGuideFixture, installTrackFixture, longAudioLabel } from '../support/layout-fixtures';
import { TvPage } from '../support/tv-page';
import { UiNextPage } from '../support/ui-next-page';

for (const viewport of tvViewports) {
    test.describe(`TV controls ${viewport.width}x${viewport.height}`, () => {
        test.beforeEach(async ({ page }) => {
            await resetFakeServer();
            await page.setViewportSize(viewport);
        });

        test('guide names are readable and favorites remain inside aligned channel rows', async ({ page }, testInfo) => {
            await installGuideFixture(page);
            await page.goto('/?live=guide');
            await expect(page.locator('html.tv-client')).toHaveCount(1);
            const minimum = tvMinimums(viewport.height);
            const tune = page.getByRole('button', { name: `Channel 8: ${guideChannelName}`, exact: true });
            const favorite = page.getByRole('button', { name: `Add ${guideChannelName} to favorites`, exact: true });
            await expectControl(tune, page, minimum.control);
            await expectControl(favorite, page, minimum.control);
            await expectTextSize(tune.getByText(guideChannelName, { exact: true }), minimum.metadata);
            const title = page.locator('[data-program-id="layout-program"] .live-program-title');
            await expect(title).toHaveText(guideProgramName);
            await expectTextSize(title, minimum.primary);
            const channel = await box(page.getByRole('rowheader'));
            const track = await box(page.getByRole('gridcell'));
            expect(Math.abs(channel.y - track.y)).toBeLessThanOrEqual(1);
            expect(Math.abs(channel.height - track.height)).toBeLessThanOrEqual(1);
            expect(Math.abs(channel.x + channel.width - track.x)).toBeLessThanOrEqual(1);
            const favoriteBox = await box(favorite);
            expect(favoriteBox.x + favoriteBox.width).toBeLessThanOrEqual(channel.x + channel.width + 1);
            expect(favoriteBox.y + favoriteBox.height).toBeLessThanOrEqual(channel.y + channel.height + 1);
            await tune.focus();
            await page.keyboard.press('ArrowRight');
            await expect(favorite).toBeFocused();
            await expectNoPageOverflow(page);
            await captureLayout(page, testInfo, 'tv-guide-focused-favorite');
        });

        test('player OSD and long track labels fit without shrinking TV controls', async ({ page }, testInfo) => {
            await installTrackFixture(page);
            await new TvPage(page).open();
            const app = new UiNextPage(page);
            await app.openMoviesLibrary();
            await app.openMovieDetails();
            await app.startMoviePlayback();
            const video = page.locator('video');
            await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && element.currentTime > 0 && !element.paused)).toBe(true);
            // Pause via the user control to keep the OSD stable without freezing the app clock.
            await page.mouse.move(viewport.width / 2, viewport.height - 80);
            const pause = page.getByRole('button', { name: 'Pause', exact: true });
            await pause.click();
            const minimum = tvMinimums(viewport.height);
            await expectTextSize(page.locator('.player-osd-top h1'), minimum.primary);
            await expectTextSize(page.locator('.player-time').first(), minimum.metadata);
            for (const label of [ 'Play', 'Rewind 10 seconds', 'Fast forward 10 seconds', 'Audio and subtitles', 'Playback settings' ]) {
                await expectControl(page.getByRole('button', { name: label, exact: true }), page, minimum.control);
            }
            await captureLayout(page, testInfo, 'tv-player-osd');
            await page.getByRole('button', { name: 'Audio and subtitles', exact: true }).click();
            const menu = page.getByRole('dialog', { name: 'Audio and subtitles', exact: true });
            await expectInViewport(menu, page);
            const track = menu.getByRole('button', { name: longAudioLabel, exact: true });
            await track.scrollIntoViewIfNeeded();
            await expectControl(track, page, minimum.control);
            await expectTextSize(track, minimum.primary);
            await expect.poll(() => track.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            await expect.poll(() => menu.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            await track.focus();
            await page.keyboard.press('ArrowUp');
            await expect.poll(() => menu.evaluate(element => element.contains(document.activeElement))).toBe(true);
            await expectNoPageOverflow(page);
            await captureLayout(page, testInfo, 'tv-player-track-menu');
        });
    });
}
