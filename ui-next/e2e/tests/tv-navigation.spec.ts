import { expect, test } from '@playwright/test';
import { resetFakeServer } from '../support/control-client';
import { TvPage } from '../support/tv-page';

test('the webOS user agent activates the TV layout', async ({ page }) => {
    await resetFakeServer();
    const tv = new TvPage(page);
    await tv.open();
});

test('an arrow key focuses the first control from a cold start', async ({ page }) => {
    await resetFakeServer();
    const tv = new TvPage(page);
    await tv.open();

    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await tv.active()).focusable).toBe(true);
});

test('the D-pad moves focus across the library grid and Enter opens details', async ({ page }) => {
    await resetFakeServer();
    const tv = new TvPage(page);
    await tv.open();
    await tv.openLibrary('Movies');

    const first = page.getByRole('button', { name: /^View E2E Movie One/ });
    await expect(first).toBeVisible();
    await first.focus();

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await tv.active()).label).toMatch(/E2E Movie Two/);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await tv.active()).label).toMatch(/E2E Movie One/);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await tv.active()).label).toMatch(/E2E Movie Six/);
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await tv.active()).label).toMatch(/E2E Movie One/);

    await page.keyboard.press('Enter');
    await expect(page.locator('.detail-page')).toBeVisible();
});

test('remote Back returns from item details to the library', async ({ page }) => {
    await resetFakeServer();
    const tv = new TvPage(page);
    await tv.open();
    await tv.openLibrary('Movies');
    await page.getByRole('button', { name: /^View E2E Movie One/ }).click();
    await expect(page.locator('.detail-page')).toBeVisible();

    await tv.pressRemoteBack();
    await expect(page.locator('.detail-page')).toBeHidden();
    await expect(page.getByRole('button', { name: /^View E2E Movie One/ })).toBeVisible();
});

test('show detail focus travels from the season sidebar into the episode feed', async ({ page }) => {
    await resetFakeServer();
    const tv = new TvPage(page);
    await tv.open();
    await tv.openLibrary('Shows');
    const series = page.getByRole('button', { name: /^View E2E Series/ });
    await series.focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('.season-sidebar [data-season-nav="e2e-season-1"]')).toBeVisible();
    await expect.poll(async () => (await tv.active()).seasonNav).toBe('e2e-season-1');

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await tv.active()).showControl).toBe('art');
    await expect.poll(async () => (await tv.active()).episodeId).toBe('e2e-episode-1');

    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await tv.active()).episodeId).toBe('e2e-episode-2');
});

test('the player OSD takes D-pad focus while playing', async ({ page }) => {
    await resetFakeServer();
    const tv = new TvPage(page);
    await tv.open();
    await tv.openLibrary('Movies');
    await page.getByRole('button', { name: /^View E2E Movie One/ }).click();
    await page.getByRole('button', { name: /^▶ Play$/ }).click();
    await expect(page.locator('video')).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.locator('.player-stage[data-osd-open="true"]')).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await tv.active()).inPlayerStage).toBe(true);
    await expect.poll(async () => (await tv.active()).focusable).toBe(true);
});
