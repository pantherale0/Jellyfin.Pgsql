import { expect, type Page } from '@playwright/test';

export class UiNextPage {
    private readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    async openHome(): Promise<void> {
        await this.page.goto('/');
        await expect(this.page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
    }

    async openMoviesLibrary(): Promise<void> {
        const navigation = this.page.getByRole('navigation', { name: 'Main navigation' });
        await navigation.getByRole('button', { name: 'Movies', exact: true }).click();
        await expect(this.movieCard()).toBeVisible();
    }

    async openMovieDetails(): Promise<void> {
        await this.movieCard().click();
        await expect(this.page.getByRole('heading', { name: 'E2E Movie One', exact: true })).toBeVisible();
        await expect(this.page.getByText('A deterministic movie for browser playback tests.', { exact: true })).toBeVisible();
    }

    async returnToMoviesLibrary(): Promise<void> {
        await this.page.getByRole('button', { name: 'Back to library', exact: true }).first().click();
        await expect(this.movieCard()).toBeVisible();
    }

    async startMoviePlayback(): Promise<void> {
        await this.page.getByRole('button', { name: /^▶ Play$/ }).click();
        await expect(this.page.locator('video')).toBeVisible();
    }

    async leavePlayer(): Promise<void> {
        await this.page.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(this.page.getByRole('heading', { name: 'E2E Movie One', exact: true })).toBeVisible();
    }

    private movieCard() {
        return this.page.getByRole('button', { name: /^View E2E Movie One/ });
    }
}
