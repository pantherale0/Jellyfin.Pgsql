import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';

test('Favorites starts close below the navigation bar', async ({ page }) => {
    await resetFakeServer();
    await page.goto('/');
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();

    const topbar = await page.locator('.topbar').boundingBox();
    const developmentWarning = await page.locator('.notice.storage-warning').boundingBox();
    const eyebrow = await page.locator('.favorites-page .catalog-heading .eyebrow').boundingBox();
    expect(topbar).not.toBeNull();
    expect(eyebrow).not.toBeNull();
    if (topbar && eyebrow) {
        const precedingContentBottom = developmentWarning ? developmentWarning.y + developmentWarning.height : topbar.y + topbar.height;
        expect(eyebrow.y - precedingContentBottom).toBeLessThanOrEqual(56);
    }
});

test('Favorites lists this profile’s Live TV channels and lets the user undo removal', async ({ page }) => {
    await resetFakeServer();
    let requestedUserId = '';
    let requestedFavoriteFilter = '';
    const favoriteActions: string[] = [];
    const favoriteChannel = {
        Id: 'e2e-family-channel',
        Name: 'Family News',
        Type: 'TvChannel',
        ChannelNumber: '7',
        UserData: { IsFavorite: true },
        CurrentProgram: { Id: 'e2e-family-program', Name: 'Evening News', Type: 'Program' }
    };

    await page.route(url => url.pathname === '/Items' && url.searchParams.get('Filters') === 'IsFavorite', route => {
        const isMovies = new URL(route.request().url()).searchParams.get('IncludeItemTypes') === 'Movie';
        return route.fulfill({
            json: {
                Items: isMovies ? [ { Id: 'e2e-movie-2', Name: 'E2E Movie Two', Type: 'Movie', UserData: { IsFavorite: true } } ] : [],
                TotalRecordCount: isMovies ? 1 : 0
            }
        });
    });
    await page.route(url => url.pathname === '/LiveTv/Channels', route => {
        const requestUrl = new URL(route.request().url());
        requestedUserId = requestUrl.searchParams.get('UserId') || '';
        requestedFavoriteFilter = requestUrl.searchParams.get('IsFavorite') || '';
        return route.fulfill({ json: { Items: [ favoriteChannel ], TotalRecordCount: 1 } });
    });
    await page.route(url => url.pathname.startsWith('/Users/e2e-user-id/FavoriteItems/'), route => {
        const requestUrl = new URL(route.request().url());
        favoriteActions.push(`${route.request().method()} ${requestUrl.pathname}`);
        return route.fulfill({ status: 204 });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    const categories = page.getByRole('group', { name: 'Favorite categories', exact: true });
    const liveTvFilter = categories.getByRole('button', { name: 'Live TV', exact: true });
    const filterBox = await liveTvFilter.boundingBox();
    expect(filterBox).not.toBeNull();
    if (filterBox) expect(filterBox.height).toBeGreaterThanOrEqual(48);
    await liveTvFilter.click();

    await expect(page.getByText('Family News', { exact: true })).toBeVisible();
    await expect(page.getByText('Evening News', { exact: true })).toBeVisible();
    expect(requestedUserId).toBe('e2e-user-id');
    expect(requestedFavoriteFilter).toBe('true');

    const removeChannel = page.getByRole('button', { name: 'Remove Family News from favorites', exact: true });
    const starBox = await removeChannel.boundingBox();
    expect(starBox).not.toBeNull();
    if (starBox) expect(starBox.width).toBeGreaterThanOrEqual(48);
    await removeChannel.click();
    await expect(page.getByText('Family News', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('Family News', { exact: true })).toBeVisible();
    expect(favoriteActions).toEqual([
        'DELETE /Users/e2e-user-id/FavoriteItems/e2e-family-channel',
        'POST /Users/e2e-user-id/FavoriteItems/e2e-family-channel'
    ]);
});

test('a favourite title can be removed and restored without leaving Favorites', async ({ page }) => {
    await resetFakeServer();
    const favoriteActions: string[] = [];

    await page.route(url => url.pathname === '/Items' && url.searchParams.get('Filters') === 'IsFavorite', route => {
        const isMovies = new URL(route.request().url()).searchParams.get('IncludeItemTypes') === 'Movie';
        return route.fulfill({
            json: {
                Items: isMovies ? [ { Id: 'e2e-movie-2', Name: 'E2E Movie Two', Type: 'Movie', UserData: { IsFavorite: true } } ] : [],
                TotalRecordCount: isMovies ? 1 : 0
            }
        });
    });
    await page.route(url => url.pathname.startsWith('/Users/e2e-user-id/FavoriteItems/'), route => {
        favoriteActions.push(route.request().method());
        return route.fulfill({ status: 204 });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await page.getByRole('group', { name: 'Favorite categories', exact: true }).getByRole('button', { name: 'Movies', exact: true }).click();
    await expect(page.getByText('E2E Movie Two', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Remove E2E Movie Two from favorites', exact: true }).click();
    await expect(page.getByText('E2E Movie Two', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('E2E Movie Two', { exact: true })).toBeVisible();
    expect(favoriteActions).toEqual([ 'DELETE', 'POST' ]);
});

test('Show more loads the next page of favorite titles', async ({ page }) => {
    await resetFakeServer();
    const movies = Array.from({ length: 25 }, (_, index) => ({
        Id: `e2e-favorite-movie-${index + 1}`,
        Name: `Favorite Movie ${index + 1}`,
        Type: 'Movie',
        UserData: { IsFavorite: true }
    }));

    await page.route(url => url.pathname === '/Items' && url.searchParams.get('Filters') === 'IsFavorite', route => {
        const requestUrl = new URL(route.request().url());
        const isMovies = requestUrl.searchParams.get('IncludeItemTypes') === 'Movie';
        const startIndex = Number(requestUrl.searchParams.get('StartIndex')) || 0;
        const limit = Number(requestUrl.searchParams.get('Limit')) || 24;
        return route.fulfill({
            json: {
                Items: isMovies ? movies.slice(startIndex, startIndex + limit) : [],
                TotalRecordCount: isMovies ? movies.length : 0
            }
        });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await page.getByRole('group', { name: 'Favorite categories', exact: true }).getByRole('button', { name: 'Movies', exact: true }).click();
    await expect(page.getByText('Favorite Movie 24', { exact: true })).toBeVisible();
    await expect(page.getByText('Favorite Movie 25', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Show more (1 remaining)', exact: true }).click();
    await expect(page.getByText('Favorite Movie 25', { exact: true })).toBeVisible();
});
