import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

export const tvViewports = [ { width: 1920, height: 1080 }, { width: 1280, height: 720 } ];

export function tvMinimums(height: number) {
    return height >= 1080 ? { primary: 26, metadata: 22, control: 60 } : { primary: 22, metadata: 20, control: 56 };
}

export async function box(locator: Locator) {
    await expect(locator).toBeVisible();
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error(`Missing rendered bounds: ${locator}`);
    return bounds;
}

export async function expectInViewport(locator: Locator, page: Page): Promise<void> {
    await expect.poll(async () => {
        const bounds = await box(locator);
        const viewport = page.viewportSize();
        if (!viewport) throw new Error('Layout tests require a fixed viewport.');
        return bounds.x >= -1 && bounds.y >= -1
            && bounds.x + bounds.width <= viewport.width + 1
            && bounds.y + bounds.height <= viewport.height + 1;
    }, { message: `${locator} must fit entirely inside the viewport` }).toBe(true);
}

export async function expectNoPageOverflow(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
}

export async function expectTextSize(locator: Locator, minimum: number): Promise<void> {
    await expect(locator).toBeVisible();
    await expect.poll(() => locator.evaluate(element => parseFloat(getComputedStyle(element).fontSize)), {
        message: `${locator} needs at least ${minimum}px text`
    }).toBeGreaterThanOrEqual(minimum);
}

export async function expectControl(locator: Locator, page: Page, minimum: number): Promise<void> {
    await expectInViewport(locator, page);
    const bounds = await box(locator);
    expect(bounds.width, `${locator} target width`).toBeGreaterThanOrEqual(minimum);
    expect(bounds.height, `${locator} target height`).toBeGreaterThanOrEqual(minimum);
}

export async function expectLoadedImage(image: Locator): Promise<void> {
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
}

/** Exercise TV fallback CSS with the modern test browser's Grid parser disabled. */
export async function disableCssGrid(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const original = CSS.supports.bind(CSS);
        Object.defineProperty(CSS, 'supports', {
            configurable: true,
            value: (feature: string, value?: string) => {
                if (feature === 'display' && value === 'grid') return false;
                return value === undefined ? original(feature) : original(feature, value);
            }
        });
    });
}

export async function captureLayout(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const viewport = page.viewportSize();
    await testInfo.attach(`${name}-${viewport?.width}x${viewport?.height}`, {
        body: await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' }),
        contentType: 'image/png'
    });
}

export async function expectLibraryRows(page: Page): Promise<void> {
    const cards = page.locator('[data-library-item-id]');
    await expect(cards).toHaveCount(6);
    await expect.poll(async () => {
        const bounds = await cards.evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        }));
        const first = bounds[0];
        if (!first) return false;
        const row = bounds.filter(item => Math.abs(item.y - first.y) <= 2).sort((a, b) => a.x - b.x);
        const next = bounds.filter(item => item.y > first.y + 2).sort((a, b) => a.y - b.y)[0];
        if (row.length < 2 || !next) return false;
        return row.every((item, index) => item.width > 100 && item.height > 150
            && (index === 0 || item.x - (row[index - 1]?.right ?? item.x) >= 12))
            && next.y - Math.max(...row.map(item => item.bottom)) >= 16
            && Math.abs(next.x - first.x) <= 2;
    }, { message: 'Six library cards must form aligned multi-column rows with >=12px column and >=16px row gaps' }).toBe(true);
    await expectNoPageOverflow(page);
}

/** A degraded-layout probe, not emulation of the webOS browser's CSS parser. */
export async function removeModernSizing(page: Page): Promise<void> {
    const removed = await page.evaluate(() => {
        let aspectRatios = 0;
        let flexGaps = 0;
        let logicalProperties = 0;
        const logicalAndInset = [
            'inset',
            'inset-inline',
            'inset-inline-start',
            'inset-inline-end',
            'inset-block',
            'inset-block-start',
            'inset-block-end',
            'margin-inline',
            'margin-inline-start',
            'margin-inline-end',
            'padding-inline',
            'padding-inline-start',
            'padding-inline-end'
        ];
        function visit(rules: CSSRuleList): void {
            for (const rule of Array.from(rules)) {
                if (rule instanceof CSSStyleRule) {
                    if (rule.style.getPropertyValue('aspect-ratio')) {
                        rule.style.removeProperty('aspect-ratio');
                        aspectRatios++;
                    }
                    for (const property of logicalAndInset) {
                        if (rule.style.getPropertyValue(property)) {
                            rule.style.removeProperty(property);
                            logicalProperties++;
                        }
                    }
                    let targetsFlex = false;
                    try {
                        targetsFlex = Array.from(document.querySelectorAll(rule.selectorText)).some(element => /^(inline-)?flex$/.test(getComputedStyle(element).display));
                    } catch { /* Pseudo-element selectors cannot be queried. */ }
                    if (targetsFlex) {
                        for (const property of [ 'gap', 'row-gap', 'column-gap' ]) {
                            if (rule.style.getPropertyValue(property)) {
                                rule.style.removeProperty(property);
                                flexGaps++;
                            }
                        }
                    }
                } else if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) {
                    visit(rule.cssRules);
                }
            }
        }
        for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
        return { aspectRatios, flexGaps, logicalProperties };
    });
    expect(removed.aspectRatios, 'The fallback probe must actually remove aspect-ratio declarations').toBeGreaterThan(0);
    expect(removed.flexGaps, 'The fallback probe must actually remove flex gap declarations').toBeGreaterThan(0);
    expect(removed.logicalProperties, 'The fallback probe must actually remove logical and inset declarations').toBeGreaterThan(0);
}
