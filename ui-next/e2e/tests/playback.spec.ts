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
