import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reportBody(request: Awaited<ReturnType<typeof fakeServerRequests>>[number] | undefined): Record<string, unknown> | null {
    return isRecord(request?.body) ? request.body : null;
}

test('play real WebM media and report start, progress, and stop', async ({ page }) => {
    await resetFakeServer();
    const streamPaths: string[] = [];
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/Videos/e2e-movie-1/stream') streamPaths.push(url.pathname);
    });

    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();
    await app.startMoviePlayback();

    const video = page.locator('video');
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);

    await page.setViewportSize({ width: 375, height: 812 });
    const buffering = page.getByRole('status').filter({ hasText: 'Buffering…' });
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The player video element is missing.');
        const currentTime = element.currentTime;
        Object.defineProperty(element, 'currentTime', { configurable: true, get: () => currentTime, set: () => undefined });
        element.dispatchEvent(new Event('waiting', { bubbles: true }));
    });
    await expect(buffering).toBeVisible({ timeout: 5000 });
    await video.evaluate(element => {
        if (!(element instanceof HTMLVideoElement)) throw new Error('The player video element is missing.');
        Reflect.deleteProperty(element, 'currentTime');
        element.dispatchEvent(new Event('playing', { bubbles: true }));
    });
    await expect(buffering).toHaveCount(0);

    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement ? element.duration : 0)).toBeGreaterThan(29);
    expect(streamPaths).toContain('/Videos/e2e-movie-1/stream');

    await expect.poll(async () => {
        const requests = await fakeServerRequests();
        return requests.find(request => request.path === '/Sessions/Playing')?.status || 0;
    }).toBe(204);

    await expect.poll(async () => {
        const requests = await fakeServerRequests();
        const report = reportBody(requests.find(request => request.path === '/Sessions/Playing/Progress'));
        return typeof report?.PositionTicks === 'number' ? report.PositionTicks : 0;
    }).toBeGreaterThan(0);

    await app.leavePlayer();
    await expect.poll(async () => {
        const requests = await fakeServerRequests();
        return requests.find(request => request.path === '/Sessions/Playing/Stopped')?.status || 0;
    }).toBe(204);

    const requests = await fakeServerRequests();
    const start = reportBody(requests.find(request => request.path === '/Sessions/Playing'));
    const progress = reportBody(requests.find(request => request.path === '/Sessions/Playing/Progress'));
    const stopped = reportBody(requests.find(request => request.path === '/Sessions/Playing/Stopped'));
    expect(start?.ItemId).toBe('e2e-movie-1');
    expect(start?.PlayMethod).toBe('DirectPlay');
    expect(progress?.PositionTicks).toBeGreaterThan(0);
    expect(stopped?.PositionTicks).toBeGreaterThan(0);
    expect(requests.filter(request => request.unexpected)).toEqual([]);
    expect(requests.filter(request => request.status >= 400)).toEqual([]);
});

test('Live TV playback error closes its stream before opening one fresh stream', async ({ page }) => {
    await resetFakeServer();
    const liveStreamIds: string[] = [];
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/Videos/e2e-live-channel/stream') {
            const liveStreamId = url.searchParams.get('LiveStreamId');
            if (liveStreamId) liveStreamIds.push(liveStreamId);
        }
    });

    await page.goto('/?live=channels');
    await page.getByRole('button', { name: '1 E2E Test Channel', exact: true }).click();

    await expect.poll(async () => (await fakeServerRequests()).filter(request => request.path === '/Items/e2e-live-channel/PlaybackInfo').length).toBe(1);
    const initialRequests = await fakeServerRequests();
    expect(initialRequests.filter(request => request.status >= 400)).toEqual([]);

    const video = page.locator('video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);
    await expect.poll(async () => {
        const requests = await fakeServerRequests();
        return reportBody(requests.find(request => request.path === '/Sessions/Playing'))?.LiveStreamId || '';
    }).toBe('e2e-live-stream-1');

    await video.evaluate(element => element.dispatchEvent(new Event('error', { bubbles: true })));

    await expect.poll(async () => (await fakeServerRequests()).filter(request => request.path === '/LiveStreams/Open').length).toBe(2);
    await expect.poll(() => video.evaluate(element => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0)).toBe(true);

    const requests = await fakeServerRequests();
    const negotiations = requests.filter(request => request.path === '/Items/e2e-live-channel/PlaybackInfo');
    const opens = requests.filter(request => request.path === '/LiveStreams/Open');
    const closes = requests.filter(request => request.path === '/LiveStreams/Close');
    const stops = requests.filter(request => request.path === '/Sessions/Playing/Stopped');
    const stopIndex = requests.indexOf(stops[0]);
    const secondNegotiationIndex = requests.indexOf(negotiations[1]);
    const secondOpenIndex = requests.indexOf(opens[1]);

    expect(negotiations).toHaveLength(2);
    expect(opens).toHaveLength(2);
    expect(stops).toHaveLength(1);
    expect(reportBody(stops[0])?.LiveStreamId).toBe('e2e-live-stream-1');
    expect(stopIndex).toBeGreaterThan(requests.indexOf(opens[0]));
    expect(secondNegotiationIndex).toBeGreaterThan(stopIndex);
    expect(secondOpenIndex).toBeGreaterThan(secondNegotiationIndex);
    expect(reportBody(negotiations[1])).not.toHaveProperty('LiveStreamId');
    expect(reportBody(negotiations[1])).not.toHaveProperty('MediaSourceId');
    expect(reportBody(opens[1])).not.toHaveProperty('LiveStreamId');
    expect(closes).toHaveLength(0);
    expect(liveStreamIds).toContain('e2e-live-stream-1');
    expect(liveStreamIds).toContain('e2e-live-stream-2');
    expect(requests.filter(request => request.unexpected)).toEqual([]);
    expect(requests.filter(request => request.status >= 400)).toEqual([]);
});
