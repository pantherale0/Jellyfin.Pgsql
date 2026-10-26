import { expect, test, type Page } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { UiNextPage } from '../support/ui-next-page';

async function openRecommendationHome(page: Page): Promise<void> {
    await resetFakeServer();
    await page.route(url => url.pathname === '/Movies/Recommendations', route => route.fulfill({
        json: [ {
            RecommendationType: 'HasLikedActor',
            Items: [
                { Id: 'e2e-movie-1', Name: 'E2E Movie One', Type: 'Movie', MediaType: 'Video', Overview: 'A deterministic movie.' },
                { Id: 'e2e-movie-2', Name: 'E2E Movie Two', Type: 'Movie', MediaType: 'Video', Overview: 'Another deterministic movie.' }
            ]
        } ]
    }));
    await new UiNextPage(page).openHome();
    await expect(page.locator('.recommendation-hero')).toBeVisible();
}

async function openMoviesLibrary(page: Page): Promise<void> {
    await resetFakeServer();
    await page.route(url => url.pathname === '/Movies/Recommendations', route => route.fulfill({
        json: [ {
            RecommendationType: 'HasLikedActor',
            Items: [
                { Id: 'e2e-movie-2', Name: 'E2E Movie Two', Type: 'Movie', MediaType: 'Video' },
                { Id: 'e2e-movie-3', Name: 'E2E Movie Three', Type: 'Movie', MediaType: 'Video' }
            ]
        } ]
    }));
    const app = new UiNextPage(page);
    await app.openHome();
    await app.openMoviesLibrary();
}

async function detailRequestCount(): Promise<number> {
    return (await fakeServerRequests()).filter(request => request.path === '/Users/e2e-user-id/Items/e2e-movie-1' && request.query.Fields?.includes('MediaSources')).length;
}

test('the active recommendation is prefetched and View details reuses its full item', async ({ page }) => {
    await openRecommendationHome(page);
    await expect.poll(detailRequestCount).toBe(1);
    await expect.poll(async () => (await fakeServerRequests()).find(request => request.path === '/Users/e2e-user-id/Items/e2e-movie-1')?.status).toBe(200);

    await page.getByRole('button', { name: 'View details', exact: true }).click();
    await expect(page.locator('.detail-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'E2E Movie One', exact: true })).toBeVisible();
    expect(await detailRequestCount()).toBe(1);
});

test('changing the recommendation releases the previous hero prefetch', async ({ page }) => {
    let releaseRequest: () => void = () => undefined;
    let notifyFirstRequest: () => void = () => undefined;
    const firstRequestStarted = new Promise<void>(resolve => { notifyFirstRequest = resolve; });
    const requestGate = new Promise<void>(resolve => { releaseRequest = resolve; });
    await page.route(url => url.pathname === '/Users/e2e-user-id/Items/e2e-movie-1', async route => {
        notifyFirstRequest();
        await requestGate;
        await route.continue().catch(() => undefined);
    });
    await openRecommendationHome(page);

    try {
        await firstRequestStarted;
        const firstRequestFailed = page.waitForEvent('requestfailed', {
            predicate: request => new URL(request.url()).pathname === '/Users/e2e-user-id/Items/e2e-movie-1',
            timeout: 5000
        });
        await page.getByRole('button', { name: 'Next recommendation', exact: true }).click();
        await firstRequestFailed;
        await expect.poll(async () => (await fakeServerRequests()).filter(request => request.path === '/Users/e2e-user-id/Items/e2e-movie-2' && request.query.Fields?.includes('MediaSources')).length).toBe(1);
    } finally {
        releaseRequest();
    }
});

test('a fast pointer sweep starts no item request, but a settled hover prefetches and leaving cancels it', async ({ page }) => {
    await openMoviesLibrary(page);
    const card = page.getByRole('button', { name: /^View E2E Movie One/ });
    await expect(card).toBeVisible();

    let releaseRequest: () => void = () => undefined;
    let startedRequests = 0;
    const requestGate = new Promise<void>(resolve => { releaseRequest = resolve; });
    await page.route(url => url.pathname === '/Users/e2e-user-id/Items/e2e-movie-1', async route => {
        startedRequests++;
        await requestGate;
        await route.continue().catch(() => undefined);
    });

    try {
        await card.hover();
        await page.waitForTimeout(100);
        expect(startedRequests).toBe(0);
        await expect.poll(() => startedRequests, { timeout: 2000 }).toBe(1);
        const requestFailed = page.waitForEvent('requestfailed', {
            predicate: request => new URL(request.url()).pathname === '/Users/e2e-user-id/Items/e2e-movie-1',
            timeout: 5000
        });
        await page.mouse.move(0, 0);
        await requestFailed;
    } finally {
        releaseRequest();
    }
});

test('keyboard focus starts an item prefetch without a pointer hover', async ({ page }) => {
    await openMoviesLibrary(page);
    await page.getByRole('button', { name: /^View E2E Movie One/ }).focus();
    await expect.poll(detailRequestCount).toBe(1);
});

test('clicking a card transfers its pending prefetch to the detail view', async ({ page }) => {
    await openMoviesLibrary(page);
    const card = page.getByRole('button', { name: /^View E2E Movie One/ });

    let releaseRequest: () => void = () => undefined;
    let startedRequests = 0;
    const requestGate = new Promise<void>(resolve => { releaseRequest = resolve; });
    await page.route(url => url.pathname === '/Users/e2e-user-id/Items/e2e-movie-1', async route => {
        startedRequests++;
        await requestGate;
        await route.continue().catch(() => undefined);
    });

    try {
        await card.hover();
        await expect.poll(() => startedRequests, { timeout: 2000 }).toBe(1);
        await card.click();
        await expect(page.locator('.detail-page')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'E2E Movie One', exact: true })).toBeVisible();
        expect(startedRequests).toBe(1);

        releaseRequest();
        await expect(page.getByText('Loading full details…', { exact: true })).toHaveCount(0);
        const requests = (await fakeServerRequests()).filter(request => request.path === '/Users/e2e-user-id/Items/e2e-movie-1' && request.query.Fields?.includes('MediaSources'));
        expect(requests, JSON.stringify(requests)).toHaveLength(1);
    } finally {
        releaseRequest();
    }
});
