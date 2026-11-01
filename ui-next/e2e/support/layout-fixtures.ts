import type { Page } from '@playwright/test';

export const longAudioLabel = 'English - Dolby Digital Plus - 5.1 - Director Commentary';
export const guideChannelName = 'World News International';
export const guideProgramName = 'Evening News and Weather Around the World';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new Error('Invalid layout fixture response.');
    return value;
}

export async function installLogoFixture(page: Page, itemId: string, dimensions: { width: number; height: number }): Promise<void> {
    await page.route(url => url.pathname === `/Users/e2e-user-id/Items/${itemId}`, async route => {
        const response = await route.fetch();
        const payload = record(await response.json());
        const tags = payload.ImageTags ? record(payload.ImageTags) : {};
        await route.fulfill({ response, json: { ...payload, ImageTags: { ...tags, Logo: 'layout-logo' } } });
    });
    await page.route(url => url.pathname === `/Items/${itemId}/Images/Logo`, route => route.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}"><rect width="100%" height="100%" fill="#b2ef5a"/><text x="10" y="30" font-size="24">E2E TITLE</text></svg>`
    }));
}

export async function installGuideFixture(page: Page): Promise<void> {
    const now = Date.now();
    await page.route('**/LiveTv/Channels*', route => route.fulfill({ json: {
        Items: [ { Id: 'layout-channel', Name: guideChannelName, Type: 'TvChannel', ChannelNumber: '8', UserData: { IsFavorite: false } } ],
        TotalRecordCount: 1
    } }));
    await page.route('**/LiveTv/Programs*', route => route.fulfill({ json: {
        Items: [ {
            Id: 'layout-program', Name: guideProgramName, Type: 'Program', ChannelId: 'layout-channel',
            StartDate: new Date(now - 30 * 60_000).toISOString(), EndDate: new Date(now + 90 * 60_000).toISOString(),
            Overview: 'News, weather and discussion from our international correspondents.'
        } ], TotalRecordCount: 1
    } }));
}

export async function installTrackFixture(page: Page): Promise<void> {
    await page.route('**/Items/e2e-movie-1/PlaybackInfo', async route => {
        const response = await route.fetch();
        const payload = record(await response.json());
        if (!Array.isArray(payload.MediaSources)) throw new Error('Missing playback sources.');
        const [ first, ...rest ] = payload.MediaSources;
        const source = record(first);
        if (!Array.isArray(source.MediaStreams)) throw new Error('Missing playback streams.');
        await route.fulfill({ response, json: { ...payload, MediaSources: [ {
            ...source, MediaStreams: [ ...source.MediaStreams,
                { Type: 'Audio', Codec: 'ac3', Index: 2, DisplayTitle: longAudioLabel, Channels: 6 }
            ]
        }, ...rest ] } });
    });
}
