import { expect, test, type Page } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { box, captureLayout, disableCssGrid, expectControl, expectInViewport, expectLibraryRows, expectLoadedImage, expectNoPageOverflow, expectTextSize, removeModernSizing, tvMinimums, tvViewports } from '../support/layout-assertions';
import { installGuideFixture, installLogoFixture } from '../support/layout-fixtures';
import { TvPage } from '../support/tv-page';

async function expectEpisodeShape(page: Page): Promise<void> {
    const episode = page.locator('article[data-episode-id="e2e-episode-1"]');
    const art = episode.getByRole('button', { name: 'Play E2E Episode One', exact: true }).filter({ has: page.locator('.episode-art') });
    await art.scrollIntoViewIfNeeded();
    await expectInViewport(art, page);
    await expectLoadedImage(art.locator('img'));
    await expect.poll(async () => {
        const bounds = await box(art);
        return bounds.width / bounds.height;
    }).toBeGreaterThanOrEqual(1.5);
    const bounds = await box(art);
    expect(bounds.width / bounds.height).toBeLessThanOrEqual(2.1);
    expect(bounds.height).toBeGreaterThanOrEqual(96);
    const copy = await box(episode.locator('.episode-copy'));
    expect(copy.x).toBeGreaterThanOrEqual(bounds.x + bounds.width - 1);
    await art.focus();
    await expect(art).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.episode-art-button[data-episode-id="e2e-episode-2"]')).toBeFocused();
    const second = await box(page.locator('.episode-art-button[data-episode-id="e2e-episode-2"]'));
    expect(Math.abs(second.width - bounds.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(second.height - bounds.height)).toBeLessThanOrEqual(2);
    await expect.poll(() => page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('.episode-list');
        const first = document.querySelector<HTMLElement>('article[data-episode-id="e2e-episode-1"]');
        const second = document.querySelector<HTMLElement>('article[data-episode-id="e2e-episode-2"]');
        if (!list || !first || !second) return 0;
        const firstBounds = first.getBoundingClientRect();
        const secondBounds = second.getBoundingClientRect();
        return secondBounds.top - firstBounds.bottom;
    }), { message: 'Episode rows retain a visible gap after focus navigation' }).toBeGreaterThanOrEqual(12);
}

for (const viewport of tvViewports) {
    test.describe(`TV rendered layout ${viewport.width}x${viewport.height}`, () => {
        test.beforeEach(async ({ page }) => {
            await resetFakeServer();
            await page.setViewportSize(viewport);
        });

        test('home leaves a useful first shelf visible and aligns shelf headings with cards', async ({ page }, testInfo) => {
            await new TvPage(page).open();
            const minimum = tvMinimums(viewport.height);
            // The first DOM rail is the first feed shelf, not an arbitrary matching card.
            const rail = page.locator('.home-feed-rail').first();
            const heading = rail.getByRole('heading', { level: 2 });
            const card = rail.locator('.home-feed-card').first();
            await expect(heading).toBeVisible();
            await expectLoadedImage(card.locator('img'));
            await expectInViewport(heading, page);
            const art = await box(card.locator('.home-feed-card-art'));
            expect(art.y, 'First shelf must show at least 96px of artwork without scrolling').toBeLessThanOrEqual(viewport.height - 96);
            await expectTextSize(heading, minimum.primary);
            const headingBox = await box(heading);
            expect(Math.abs(headingBox.x - (await box(card)).x)).toBeLessThanOrEqual(3);
            await expectNoPageOverflow(page);
            await captureLayout(page, testInfo, 'tv-home-first-shelf');

            const secondTitle = await page.locator('.home-feed-rail').nth(1).getByRole('heading', { level: 2 }).textContent();
            if (!secondTitle) throw new Error('A second named shelf is required for gutter comparisons.');
            // Pin its heading before scrolling: virtualization can change rail DOM ordinals.
            const secondRail = page.locator('.home-feed-rail').filter({ has: page.getByRole('heading', { level: 2, name: secondTitle, exact: true }) });
            await secondRail.scrollIntoViewIfNeeded();
            const secondHeading = secondRail.getByRole('heading', { level: 2 });
            const secondCard = secondRail.locator('.home-feed-card').first();
            await expectLoadedImage(secondCard.locator('img'));
            expect(Math.abs((await box(secondHeading)).x - (await box(secondCard)).x)).toBeLessThanOrEqual(3);
            expect(Math.abs((await box(secondHeading)).x - headingBox.x)).toBeLessThanOrEqual(3);
            await captureLayout(page, testInfo, 'tv-home-second-shelf');
        });

        test('library has spaced multi-column rows and readable titles, metadata and controls', async ({ page }, testInfo) => {
            const tv = new TvPage(page);
            const minimum = tvMinimums(viewport.height);
            await tv.open();
            await expectControl(page.getByRole('button', { name: 'Home', exact: true }), page, minimum.control);
            await tv.openLibrary('Movies');
            await expectLibraryRows(page);
            const alphaScrubber = page.locator('.alpha-scrubber');
            if (viewport.width <= 1400 || viewport.height <= 800) await expect(alphaScrubber).toBeHidden();
            else await expect(alphaScrubber).toBeVisible();
            const first = page.locator('[data-library-item-id="e2e-movie-1"]');
            await expectTextSize(first.locator('.library-card-overlay strong'), minimum.primary);
            await expectTextSize(first.locator('.library-card-overlay small'), minimum.metadata);
            await expect(page.getByRole('searchbox', { name: 'Search Movies', exact: true })).toHaveCount(0);
            await expectControl(page.getByRole('button', { name: 'Search your library', exact: true }), page, minimum.control);
            await expectControl(page.getByRole('button', { name: 'Select', exact: true }), page, minimum.control);
            await expectControl(page.getByRole('combobox', { name: 'Sort', exact: true }), page, minimum.control);
            await captureLayout(page, testInfo, 'tv-library-first-row');
            const last = page.getByRole('button', { name: /^View E2E Movie Six/ });
            await last.focus();
            await expect(last).toBeFocused();
            await expectInViewport(last, page);
            const focusRing = await last.locator('.library-card-art').evaluate(element => parseFloat(getComputedStyle(element, '::after').borderTopWidth));
            expect(focusRing).toBeGreaterThanOrEqual(viewport.height >= 1080 ? 5 : 4);
            await captureLayout(page, testInfo, 'tv-library-second-row-focused');
        });

        for (const dimensions of [ { width: 1200, height: 180 }, { width: 240, height: 640 } ]) {
            test(`movie logo ${dimensions.width}x${dimensions.height} is bounded and leaves playback accessible`, async ({ page }, testInfo) => {
                await installLogoFixture(page, 'e2e-movie-1', dimensions);
                const tv = new TvPage(page);
                await tv.open();
                await tv.openLibrary('Movies');
                await page.getByRole('button', { name: /^View E2E Movie One/ }).click();
                const logo = page.getByRole('img', { name: 'E2E Movie One', exact: true });
                await expectLoadedImage(logo);
                await expectInViewport(logo, page);
                const bounds = await box(logo);
                expect(bounds.width).toBeLessThanOrEqual(viewport.width * 0.45);
                expect(bounds.height).toBeLessThanOrEqual(viewport.height * 0.25);
                expect(Math.abs(bounds.width / bounds.height - dimensions.width / dimensions.height)).toBeLessThan(0.1);
                await expectControl(page.getByRole('button', { name: /^▶ Play$/ }), page, tvMinimums(viewport.height).control);
                await expectNoPageOverflow(page);
                await captureLayout(page, testInfo, `tv-movie-logo-${dimensions.width}x${dimensions.height}`);
            });
        }

        test('series hero is bounded and episode thumbnails remain landscape during focus navigation', async ({ page }, testInfo) => {
            const tv = new TvPage(page);
            await tv.open();
            await tv.openLibrary('Shows');
            await page.getByRole('button', { name: /^View E2E Series/ }).click();
            const hero = page.locator('.show-backdrop');
            await expect(hero).toBeVisible();
            // Show entry focuses the season navigation; return to the hero for its screenshot.
            await hero.scrollIntoViewIfNeeded();
            expect((await box(hero)).height).toBeLessThanOrEqual(viewport.height * 0.65);
            await expectTextSize(page.getByRole('heading', { level: 1, name: 'E2E Series', exact: true }), tvMinimums(viewport.height).primary);
            await captureLayout(page, testInfo, 'tv-series-hero');
            await expectEpisodeShape(page);
            await expectTextSize(page.locator('article[data-episode-id="e2e-episode-2"] .episode-title > span:last-child'), tvMinimums(viewport.height).primary);
            await expectTextSize(page.locator('article[data-episode-id="e2e-episode-2"] .episode-meta'), tvMinimums(viewport.height).metadata);
            await expectNoPageOverflow(page);
            await captureLayout(page, testInfo, 'tv-series-episodes');
        });

        test('degraded aspect-ratio and flex-gap probe retains usable episode geometry', async ({ page }, testInfo) => {
            const tv = new TvPage(page);
            await tv.open();
            await tv.openLibrary('Shows');
            await page.getByRole('button', { name: /^View E2E Series/ }).click();
            await expect(page.locator('.episode-art-button[data-episode-id="e2e-episode-1"]')).toBeVisible();
            await removeModernSizing(page);
            await expectEpisodeShape(page);
            await expectNoPageOverflow(page);
            await captureLayout(page, testInfo, 'tv-degraded-css-episodes');
        });

        test('Chromium 53 flex fallback keeps library, search and episode cards in usable rows', async ({ page }, testInfo) => {
            await disableCssGrid(page);
            const searchMovies = Array.from({ length: 6 }, (_value, index) => ({
                Id: `gridless-search-${index + 1}`,
                Name: `Gridless Search ${index + 1}`,
                Type: 'Movie',
                ProductionYear: 2024,
                ImageTags: { Primary: `gridless-search-${index + 1}` },
                UserData: { IsFavorite: false }
            }));
            await page.route(url => url.pathname === '/Items' && new URL(url).searchParams.has('SearchTerm'), route => route.fulfill({
                json: { Items: searchMovies, TotalRecordCount: searchMovies.length }
            }));
            const tv = new TvPage(page);
            await tv.open();
            await removeModernSizing(page);
            await expect(page.locator('html.tv-no-grid')).toHaveCount(1);
            await expect(page.locator('.topbar')).toHaveCSS('position', 'fixed');
            const brandBox = await box(page.locator('.topbar .brand'));
            const navBox = await box(page.locator('.topbar .primary-nav'));
            const searchBox = await box(page.locator('.topbar .search-box'));
            const profileBox = await box(page.locator('.topbar .profile-menu-container'));
            const searchIconBox = await box(page.locator('.topbar .search-toggle svg'));
            expect(navBox.x - (brandBox.x + brandBox.width)).toBeGreaterThanOrEqual(16);
            expect(searchBox.x).toBeGreaterThanOrEqual(viewport.width * 0.65);
            expect(profileBox.x - (searchBox.x + searchBox.width)).toBeGreaterThanOrEqual(16);
            expect(searchIconBox.width).toBeGreaterThanOrEqual(20);
            expect(searchIconBox.height).toBeGreaterThanOrEqual(20);
            await tv.openLibrary('Movies');
            await expectLibraryRows(page);
            await expect(page.locator('.library-grid-window')).toHaveCSS('display', 'flex');
            const libraryRows = await page.locator('[data-library-item-id]').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y));
            const firstRowY = libraryRows[0] ?? 0;
            const posterColumns = viewport.height >= 1080 ? 5 : 4;
            expect(libraryRows.slice(0, posterColumns).every(rowY => Math.abs(rowY - firstRowY) <= 2)).toBe(true);
            expect(libraryRows[posterColumns] ?? 0).toBeGreaterThan(firstRowY);
            await captureLayout(page, testInfo, 'tv-no-grid-library');

            await page.getByRole('button', { name: 'Search your library', exact: true }).click();
            await page.getByRole('textbox', { name: 'Search query', exact: true }).fill('gridless');
            const posterGrid = page.locator('.poster-grid.virtualized-poster-grid');
            await expect(posterGrid).toHaveCSS('display', 'flex');
            const posterRows = await posterGrid.locator('.virtual-grid-cell').evaluateAll(elements => elements.map(element => {
                const rect = element.getBoundingClientRect();
                return { x: rect.x, y: rect.y };
            }));
            expect(posterRows).toHaveLength(6);
            const resultColumns = viewport.height >= 1080 ? 5 : 4;
            expect(posterRows.slice(0, resultColumns).every(row => Math.abs(row.y - (posterRows[0]?.y ?? 0)) <= 2)).toBe(true);
            expect((posterRows[resultColumns]?.y ?? 0)).toBeGreaterThan(posterRows[0]?.y ?? 0);
            await captureLayout(page, testInfo, 'tv-no-grid-poster-results');

            await tv.openLibrary('Shows');
            await page.getByRole('button', { name: /^View E2E Series/ }).click();
            await expect(page.locator('.episode-explorer')).toHaveCSS('display', 'flex');
            await expect(page.locator('.episode-card').first()).toHaveCSS('display', 'flex');
            await expectEpisodeShape(page);
            await expectNoPageOverflow(page);
            await captureLayout(page, testInfo, 'tv-no-grid-episodes');

            await installGuideFixture(page, 12);
            await page.goto('/?live=guide');
            const guide = page.locator('.live-guide-scroll');
            await expect(guide).toBeVisible();
            await expect(guide.locator('.live-row').first()).toBeVisible();
            // A late-day Today range can be shorter than the viewport; Tomorrow guarantees a scrollable timeline.
            await page.getByRole('button', { name: 'Tomorrow', exact: true }).click();
            await expect.poll(() => guide.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(420);
            await expect(guide.locator('.live-row').first()).toBeVisible();
            const guideMetrics = await guide.evaluate(element => ({
                scrollHeight: element.scrollHeight,
                clientHeight: element.clientHeight,
                canvasHeight: element.querySelector<HTMLElement>('.live-guide-canvas')?.style.height || '',
                rowHeight: getComputedStyle(element.querySelector<HTMLElement>('.live-row')!).height
            }));
            expect(guideMetrics.scrollHeight - guideMetrics.clientHeight, JSON.stringify(guideMetrics)).toBeGreaterThan(180);
            await guide.evaluate(element => { element.scrollTop = 180; element.scrollLeft = 420; });
            await expect.poll(() => guide.evaluate(element => element.scrollTop)).toBe(180);
            await expect.poll(() => guide.evaluate(element => element.scrollLeft)).toBe(420);
            await expect.poll(() => page.locator('.live-guide-head').evaluate(element => getComputedStyle(element).top)).toBe('180px');
            await expect.poll(() => page.locator('.live-ruler-corner').evaluate(element => getComputedStyle(element).left)).toBe('420px');
            await expect.poll(() => page.locator('.live-channel').first().evaluate(element => getComputedStyle(element).left)).toBe('420px');
            const pinned = await page.evaluate(() => {
                const scroller = document.querySelector<HTMLElement>('.live-guide-scroll');
                const header = scroller?.querySelector<HTMLElement>('.live-guide-head');
                const corner = scroller?.querySelector<HTMLElement>('.live-ruler-corner');
                const channel = scroller?.querySelector<HTMLElement>('.live-channel');
                if (!scroller || !header || !corner || !channel) return null;
                const scrollBox = scroller.getBoundingClientRect();
                return {
                    headerTop: header.getBoundingClientRect().top - scrollBox.top - scroller.clientTop,
                    cornerLeft: corner.getBoundingClientRect().left - scrollBox.left - scroller.clientLeft,
                    channelLeft: channel.getBoundingClientRect().left - scrollBox.left - scroller.clientLeft
                };
            });
            expect(pinned).not.toBeNull();
            if (!pinned) return;
            expect(Math.abs(pinned.headerTop), JSON.stringify(pinned)).toBeLessThanOrEqual(2);
            expect(Math.abs(pinned.cornerLeft)).toBeLessThanOrEqual(2);
            expect(Math.abs(pinned.channelLeft)).toBeLessThanOrEqual(2);
            await captureLayout(page, testInfo, 'tv-no-grid-live-guide');

            await page.evaluate(() => {
                document.documentElement.dir = 'rtl';
                const scroller = document.querySelector<HTMLElement>('.live-guide-scroll');
                if (!scroller) throw new Error('The RTL guide requires a scroll container.');
                scroller.scrollLeft = 480;
                scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
            await expect.poll(() => page.evaluate(() => {
                const scroller = document.querySelector<HTMLElement>('.live-guide-scroll');
                const channel = scroller?.querySelector<HTMLElement>('.live-channel');
                const corner = scroller?.querySelector<HTMLElement>('.live-ruler-corner');
                if (!scroller || !channel || !corner) return false;
                const edge = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
                return Math.abs(channel.getBoundingClientRect().right - edge) <= 2
                    && Math.abs(corner.getBoundingClientRect().right - edge) <= 2;
            })).toBe(true);
        });
    });
}
