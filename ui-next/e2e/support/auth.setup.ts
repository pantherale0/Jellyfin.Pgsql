import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from './control-client';
import { LoginPage } from './login-page';

test('sign in through the UI and save authenticated browser state', async ({ page }) => {
    await resetFakeServer();
    const login = new LoginPage(page);
    await login.open();
    const serverUrl = new URL(page.url()).origin;
    await login.signIn({
        serverUrl,
        username: 'e2e-user',
        password: 'e2e-password'
    });

    await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /View E2E Movie One/ }).first()).toBeVisible();

    await expect.poll(async () => {
        const paths = new Set((await fakeServerRequests()).map(request => request.path));
        return [ '/Users/AuthenticateByName', '/Users/Me', '/UserViews', '/Items/Latest' ].every(path => paths.has(path));
    }).toBe(true);
    const requests = await fakeServerRequests();
    const authentication = requests.find(request => request.path === '/Users/AuthenticateByName');
    expect(authentication?.status).toBe(200);
    const requestPaths = requests.map(request => request.path);
    for (const path of [ '/Users/AuthenticateByName', '/Users/Me', '/UserViews', '/Items/Latest' ]) {
        assert.ok(requestPaths.includes(path), `expected request to ${path}; received ${requestPaths.join(', ')}`);
    }
    expect(requests.filter(request => request.unexpected)).toEqual([]);
    expect(requests.filter(request => request.status >= 400)).toEqual([]);

    const authFile = process.env.E2E_AUTH_FILE;
    if (!authFile) throw new Error('E2E_AUTH_FILE is not configured.');
    await mkdir(dirname(authFile), { recursive: true });
    await page.context().storageState({ path: authFile });
});
