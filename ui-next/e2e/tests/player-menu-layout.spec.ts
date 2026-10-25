import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('playback track menu keeps long labels within a narrow screen', async ({ page }) => {
    await resetFakeServer();
    const longAudioLabel = 'English - Dolby Digital Plus - 5.1 - Director Commentary';
    const longSubtitleLabel = 'English - Hearing Impaired - SubRip - Extended Dialogue';

    await page.route('**/Items/e2e-movie-1/PlaybackInfo', async route => {
        const response = await route.fetch();
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.MediaSources)) throw new Error('Playback fixture did not return media sources.');
        const [ firstSource, ...otherSources ] = body.MediaSources;
        if (!isRecord(firstSource)) throw new Error('Playback fixture did not return a media source.');
        const streams = Array.isArray(firstSource.MediaStreams) ? firstSource.MediaStreams : [];
        await route.fulfill({
            response,
            json: {
                ...body,
                MediaSources: [ {
                    ...firstSource,
                    MediaStreams: [
                        ...streams,
                        { Type: 'Audio', Codec: 'ac3', Index: 2, DisplayTitle: longAudioLabel, Channels: 6 },
                        { Type: 'Subtitle', Codec: 'subrip', Index: 3, DisplayTitle: longSubtitleLabel, IsTextSubtitleStream: true }
                    ]
                }, ...otherSources ]
            }
        });
    });

    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await app.startMoviePlayback();
    await page.setViewportSize({ width: 300, height: 600 });
    await page.getByRole('button', { name: 'Audio and subtitles' }).click();

    const menu = page.getByRole('dialog', { name: 'Audio and subtitles' });
    await expect(menu).toBeVisible();
    const audioTrack = menu.getByRole('button', { name: longAudioLabel, exact: true });
    const subtitleTrack = menu.getByRole('button', { name: longSubtitleLabel, exact: true }).first();
    await expect(audioTrack).toBeVisible();
    await expect(subtitleTrack).toBeVisible();
    await expect.poll(() => menu.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(() => audioTrack.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(() => subtitleTrack.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

    const bounds = await menu.boundingBox();
    if (!bounds) throw new Error('The playback track menu has no visible bounds.');
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(300);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
});
