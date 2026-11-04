import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { disableCssGrid } from '../support/layout-assertions';
import { TvPage } from '../support/tv-page';

test('TV home feed reuses measured block heights without ResizeObserver', async ({ page }) => {
    await resetFakeServer();
    await page.addInitScript(() => {
        Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: undefined });
    });
    await disableCssGrid(page);
    await page.route(url => url.pathname === '/Items' && url.searchParams.get('IncludeItemTypes') === 'BoxSet', route => route.fulfill({
        json: {
            Items: [ {
                Id: 'e2e-home-spotlight',
                Name: 'E2E Spotlight Collection',
                Type: 'BoxSet',
                ChildCount: 3,
                ImageTags: { Primary: 'spotlight-primary' },
                BackdropImageTags: [ 'spotlight-backdrop' ]
            } ],
            TotalRecordCount: 1
        }
    }));

    await new TvPage(page).open();
    await expect.poll(() => page.evaluate(() => typeof window.ResizeObserver)).toBe('undefined');

    const feed = page.locator('.home-feed-blocks');
    const measuredBlock = feed.locator('> [data-block-index="2"]');
    await expect(measuredBlock).toHaveAttribute('data-placeholder', 'true');

    await page.evaluate(() => {
        const block = document.querySelector<HTMLElement>('.home-feed-blocks > [data-block-index="2"]');
        if (!block) throw new Error('Missing target home-feed block.');
        const bounds = block.getBoundingClientRect();
        window.scrollTo(0, Math.max(0, window.scrollY + bounds.top + bounds.height / 2 - window.innerHeight / 2));
    });
    await expect(measuredBlock).not.toHaveAttribute('data-placeholder', 'true');
    const measuredHeight = await measuredBlock.evaluate(element => element.getBoundingClientRect().height);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(measuredBlock).toHaveAttribute('data-placeholder', 'true');

    const placeholderHeight = await measuredBlock.evaluate(element => element.getBoundingClientRect().height);
    expect(Math.abs(placeholderHeight - measuredHeight)).toBeLessThanOrEqual(2);
});

test('TV focus keeps the home rail overline below the fixed topbar', async ({ page }) => {
    await resetFakeServer();
    await page.addInitScript(() => {
        Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: undefined });
    });
    await disableCssGrid(page);
    await new TvPage(page).open();

    const rail = page.locator('.home-feed-rail').first();
    const eyebrow = rail.locator('.home-feed-rail-heading .eyebrow');
    const card = rail.locator('.home-feed-rail-items .home-feed-card').first();
    await expect(eyebrow).toBeVisible();
    await expect(card).toBeVisible();

    const headerBottom = await page.locator('.topbar').evaluate(element => element.getBoundingClientRect().bottom);
    await eyebrow.evaluate(element => {
        const header = document.querySelector<HTMLElement>('.topbar');
        if (!header) throw new Error('Missing fixed TV header.');
        const bounds = element.getBoundingClientRect();
        window.scrollTo(0, window.scrollY + bounds.top - (header.getBoundingClientRect().bottom - 25));
    });
    await expect.poll(() => eyebrow.evaluate(element => element.getBoundingClientRect().top))
        .toBeLessThan(headerBottom);

    await page.keyboard.press('Shift');
    await card.evaluate(element => element.focus({ preventScroll: true }));
    await expect.poll(() => eyebrow.evaluate(element => element.getBoundingClientRect().top))
        .toBeGreaterThanOrEqual(headerBottom + 15);
});
