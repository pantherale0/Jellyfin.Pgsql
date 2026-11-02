import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { TvPage } from '../support/tv-page';

async function emulateWebOS4DotScroll(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const scrollIntoView = Element.prototype.scrollIntoView;
        Object.defineProperty(Element.prototype, 'scrollIntoView', {
            configurable: true,
            value: function (this: Element, options?: boolean | ScrollIntoViewOptions): void {
                if (options && typeof options === 'object' && this.classList.contains('recommendation-dot')) {
                    // Match the page scroll observed when webOS 4 reveals a carousel dot.
                    const bounds = this.getBoundingClientRect();
                    const header = document.querySelector('.topbar');
                    const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
                    window.scrollTo(0, window.scrollY + bounds.top - headerBottom);
                    return;
                }
                scrollIntoView.call(this, options);
            }
        });
    });
}

async function openTvHome(page: Page): Promise<void> {
    await resetFakeServer();
    await emulateWebOS4DotScroll(page);

    await new TvPage(page).open();
    await page.addStyleTag({ content: '.recommendation-pagination { width: 96px !important; max-width: 96px !important; flex: 0 0 96px !important; }' });
    await page.evaluate(() => {
        Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: undefined });
    });
}

async function expectActiveDotVisible(hero: Locator): Promise<void> {
    await expect.poll(() => hero.evaluate(element => {
        const pagination = element.querySelector<HTMLElement>('.recommendation-pagination');
        const dot = element.querySelector<HTMLElement>('.recommendation-dot.active');
        if (!pagination || !dot) return false;
        const viewport = pagination.getBoundingClientRect();
        const dotBounds = dot.getBoundingClientRect();
        const left = viewport.left + pagination.clientLeft;
        const right = left + pagination.clientWidth;
        return dotBounds.left >= left - 1 && dotBounds.right <= right + 1;
    }), { message: 'The selected recommendation dot stays visible in its horizontal scroller' }).toBe(true);
}

test('advancing the home carousel keeps the hero in place on webOS 4', async ({ page }) => {
    await openTvHome(page);
    const hero = page.locator('.recommendation-hero');
    await expect(hero).toBeVisible();
    const primary = hero.getByRole('button', { name: 'View details', exact: true });
    const currentDot = hero.locator('.recommendation-dot.active');
    await expect(primary).toBeVisible();
    await expect(currentDot).toBeVisible();
    await primary.focus();

    const initialLabel = await currentDot.getAttribute('aria-label');
    if (!initialLabel) throw new Error('The selected recommendation must have an accessible label.');
    const before = await hero.evaluate(element => ({
        top: element.getBoundingClientRect().top,
        scrollY: window.scrollY
    }));

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => hero.locator('.recommendation-dot.active').getAttribute('aria-label')).not.toBe(initialLabel);
    const after = await hero.evaluate(element => ({
        top: element.getBoundingClientRect().top,
        scrollY: window.scrollY
    }));

    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThanOrEqual(2);
    await expectActiveDotVisible(hero);
});

test('RTL carousel pagination keeps the selected dot visible', async ({ page }) => {
    await openTvHome(page);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const hero = page.locator('.recommendation-hero');
    const primary = hero.getByRole('button', { name: 'View details', exact: true });
    const activeDot = hero.locator('.recommendation-dot.active');
    await primary.focus();
    const previous = await activeDot.getAttribute('aria-label');
    const before = await hero.evaluate(element => ({ top: element.getBoundingClientRect().top, scrollY: window.scrollY }));
    await hero.getByRole('button', { name: 'Next recommendation', exact: true }).click();
    await expect.poll(() => activeDot.getAttribute('aria-label')).not.toBe(previous);
    const after = await hero.evaluate(element => ({ top: element.getBoundingClientRect().top, scrollY: window.scrollY }));
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThanOrEqual(2);
    await expectActiveDotVisible(hero);
});
