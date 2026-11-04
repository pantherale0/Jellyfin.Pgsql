import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { box, expectNoPageOverflow } from '../support/layout-assertions';
import { MobileUiNextPage } from '../support/mobile-ui-next-page';

test('detail metadata chips wrap, stay tappable, and separate crew roles on mobile', async ({ page }) => {
    await resetFakeServer();
    await page.route(url => url.pathname === '/Users/e2e-user-id/Items/e2e-movie-1', route => route.fulfill({
        json: {
            Id: 'e2e-movie-1',
            Name: 'E2E Movie One',
            Type: 'Movie',
            MediaType: 'Video',
            ParentId: 'e2e-movies-library',
            ProductionYear: 2024,
            RunTimeTicks: 300_000_000,
            ImageTags: { Primary: 'movie-1-image' },
            UserData: { Played: false, IsFavorite: false, PlaybackPositionTicks: 0 },
            Studios: [ { Id: 'e2e-studio-1', Name: 'Agile Films' } ],
            Tags: [ 'London, England', 'drag queen', 'film noir', 'social issues' ],
            People: [
                { Id: 'e2e-director', Name: 'E2E Director', Type: 'Director' },
                { Id: 'e2e-writer', Name: 'E2E Writer', Type: 'Writer' },
                { Id: 'e2e-producer', Name: 'E2E Producer', Type: 'Producer' }
            ]
        }
    }));
    const app = new MobileUiNextPage(page);
    await app.openHome();
    await app.openLibrary('Movies');
    await page.getByRole('button', { name: /^View E2E Movie One/ }).click();

    const crew = page.locator('.detail-chip-group').filter({ has: page.getByRole('heading', { name: 'Crew', exact: true }) });
    const tags = page.locator('.detail-chip-group').filter({ has: page.getByRole('heading', { name: 'Tags', exact: true }) });
    await expect(crew).toBeVisible();
    await expect(tags).toBeVisible();
    await expect(tags.locator('.detail-chip')).toHaveCount(4);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('Detail layout tests require a fixed viewport.');

    for (const group of [ crew, tags ]) {
        const heading = await box(group.locator('h3'));
        const chips = group.locator('.detail-chips');
        const chipsBounds = await box(chips);
        expect(chipsBounds.y).toBeGreaterThanOrEqual(heading.y + heading.height);
        const buttons = group.locator('.detail-chip');
        const count = await buttons.count();
        for (let index = 0; index < count; index++) {
            const bounds = await box(buttons.nth(index));
            expect(bounds.height).toBeGreaterThanOrEqual(44);
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
        }
    }

    const crewRole = crew.locator('.detail-chip').filter({ hasText: 'E2E Director' }).locator('small');
    await expect(crewRole).toHaveText('Director');
    await expectNoPageOverflow(page);
});
