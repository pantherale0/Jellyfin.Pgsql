import { expect, type Page } from '@playwright/test';

export interface ActiveElement {
    label: string | null;
    showControl: string | null;
    seasonNav: string | null;
    episodeId: string | null;
    inPlayerStage: boolean;
    focusable: boolean;
}

export class TvPage {
    private readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    /** Opens the app and confirms the TV layout is active for the emulated user agent. */
    async open(): Promise<void> {
        await this.page.goto('/');
        await expect(this.page.locator('html.tv-client')).toHaveCount(1);
        await expect(this.page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
    }

    /** A serializable view of the focused element, for behaviour-level assertions. */
    async active(): Promise<ActiveElement> {
        return this.page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;
            return {
                label: element?.getAttribute('aria-label') ?? null,
                showControl: element?.getAttribute('data-show-control') ?? null,
                seasonNav: element?.getAttribute('data-season-nav') ?? null,
                episodeId: element?.getAttribute('data-episode-id') ?? null,
                inPlayerStage: Boolean(element?.closest('.player-stage')),
                focusable: element?.getAttribute('data-focusable') === 'true'
            };
        });
    }

    async openLibrary(name: string): Promise<void> {
        await this.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
    }

    /** Presses the webOS/Tizen remote Back key (keyCode 10009, key "GoBack") as a remote would send it. */
    async pressRemoteBack(): Promise<void> {
        await this.page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'GoBack', bubbles: true }));
        });
    }
}
