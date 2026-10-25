import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

test('browse a library item, inspect its details, and return to the library', async ({ page }) => {
    await resetFakeServer();
    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
    await app.openMovieDetails();

    const requiredPaths = [
        '/Items',
        '/Items/Filters',
        '/Users/e2e-user-id/Items/e2e-movie-1',
        '/Items/e2e-movie-1/Similar',
        '/Items/e2e-movie-1/Collections'
    ];
    await expect.poll(async () => {
        const paths = new Set((await fakeServerRequests()).map(request => request.path));
        return requiredPaths.every(path => paths.has(path));
    }).toBe(true);

    const requests = await fakeServerRequests();
    expect(requests.some(request => request.path === '/Items' && request.query.ParentId === 'e2e-movies-library')).toBe(true);
    expect(requests.filter(request => request.unexpected)).toEqual([]);
    expect(requests.filter(request => request.status >= 400)).toEqual([]);

    await app.returnToMoviesLibrary();
});
