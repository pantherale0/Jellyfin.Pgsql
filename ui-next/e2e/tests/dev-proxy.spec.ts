import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';

test('Vite serves the app shell and proxies unlisted API paths in development', async ({ request }) => {
    test.skip(process.env.E2E_APP !== 'dev', 'Vite development proxy is not used by preview builds.');
    await resetFakeServer();

    const app = await request.get('/');
    expect(app.status()).toBe(200);
    expect(app.headers()['content-type']).toContain('text/html');

    const probe = await request.get('/Branding/Configuration');
    expect(probe.status()).toBe(200);
    expect((await fakeServerRequests()).find(entry => entry.path === '/Branding/Configuration')).toMatchObject({
        method: 'GET',
        status: 200,
        unexpected: false
    });
});
