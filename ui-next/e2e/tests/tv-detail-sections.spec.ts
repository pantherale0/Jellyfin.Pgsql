import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { box, disableCssGrid } from '../support/layout-assertions';
import { TvPage } from '../support/tv-page';

const similarItems = [
    { Id: 'e2e-similar-1', Name: 'Related Movie One', Type: 'Movie', ProductionYear: 2024, ImageTags: { Primary: 'movie-2-image' } },
    { Id: 'e2e-similar-2', Name: 'Related Movie Two', Type: 'Movie', ProductionYear: 2023, ImageTags: { Primary: 'movie-3-image' } },
    { Id: 'e2e-similar-3', Name: 'Related Movie Three', Type: 'Movie', ProductionYear: 2022, ImageTags: { Primary: 'movie-4-image' } }
];

test('webOS detail sections keep tags and related posters inside their TV layout', async ({ page }) => {
    await resetFakeServer();
    await disableCssGrid(page);
    await page.route(url => url.pathname === '/Items/e2e-movie-1/Similar', route => route.fulfill({
        json: { Items: similarItems, TotalRecordCount: similarItems.length }
    }));
    await page.route(url => url.pathname === '/Items' && url.searchParams.has('Tags'), route => route.fulfill({
        json: {
            Items: [ { Id: 'e2e-tag-result', Name: 'Tagged E2E Movie', Type: 'Movie', ImageTags: { Primary: 'movie-2-image' } } ],
            TotalRecordCount: 1
        }
    }));
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

    const tv = new TvPage(page);
    await tv.open();
    await page.addStyleTag({ content: 'html.tv-client .detail-chip-group { display: block; } html.tv-client .detail-chip-group .detail-chips { gap: 0; } html.tv-client.tv-no-grid .detail-card-art { width: auto; }' });
    await tv.openLibrary('Movies');
    await page.getByRole('button', { name: /^View E2E Movie One/ }).click();

    const topbar = page.locator('.topbar');
    const tags = page.locator('.detail-chip-group').filter({ has: page.getByRole('heading', { name: 'Tags', exact: true }) });
    const studio = page.locator('.detail-chip-group').filter({ has: page.getByRole('heading', { name: 'Studios', exact: true }) });
    const crew = page.locator('.detail-chip-group').filter({ has: page.getByRole('heading', { name: 'Crew', exact: true }) });
    const row = page.locator('.detail-row').filter({ has: page.getByRole('heading', { name: 'More like this', exact: true }) });
    const tagButtons = tags.locator('.detail-chip');
    const relatedCards = row.locator('.detail-card');

    await expect(tags).toBeVisible();
    await expect(studio).toBeVisible();
    await expect(relatedCards).toHaveCount(similarItems.length);

    for (let index = 0; index < similarItems.length; index++) {
        const card = relatedCards.nth(index);
        await expect(card.locator('.detail-card-open')).toHaveCSS('align-items', 'stretch');
        const cardBounds = await box(card);
        const artBounds = await box(card.locator('.detail-card-art'));
        expect(Math.abs(artBounds.width - cardBounds.width)).toBeLessThanOrEqual(1);
    }

    const tagHeading = await box(tags.locator('h3'));
    const tagContainer = await box(tags.locator('.detail-chips'));
    await expect(tags).toHaveCSS('display', 'flex');
    expect(tagContainer.x).toBeGreaterThanOrEqual(tagHeading.x + tagHeading.width);
    const firstTag = await box(tagButtons.nth(0));
    const secondTag = await box(tagButtons.nth(1));
    expect(secondTag.x - firstTag.x - firstTag.width).toBeGreaterThanOrEqual(8);
    const tvChip = await box(tagButtons.nth(0));
    expect(tvChip.height).toBeGreaterThanOrEqual(48);
    expect(tvChip.height).toBeLessThanOrEqual(52);
    const crewChip = crew.locator('.detail-chip').filter({ hasText: 'E2E Director' });
    const crewRole = crewChip.locator('small');
    await expect(crewRole).toHaveText('Director');
    const crewTextSize = await crewChip.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    const crewRoleSize = await crewRole.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    expect(crewRoleSize).toBeLessThan(crewTextSize);

    await expect(topbar).toHaveClass(/detail-view/);
    const topbarColor = await topbar.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(topbarColor).toMatch(/^rgb\(/);

    await tagButtons.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tagButtons.nth(1)).toBeFocused();

    const relatedButtons = row.locator('.detail-card-open');
    await relatedButtons.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(relatedButtons.nth(1)).toBeFocused();

    await tagButtons.nth(0).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.detail-page [role="alert"]')).toHaveCount(0);
    await expect(page.locator('.detail-related .media-card')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.detail-related .media-card')).toHaveCount(1);
    await expect(page.locator('.detail-page [role="alert"]')).toHaveCount(0);
});
