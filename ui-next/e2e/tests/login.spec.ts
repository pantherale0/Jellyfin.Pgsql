import { expect, test } from '@playwright/test';
import { fakeServerRequests, resetFakeServer } from '../support/control-client';
import { LoginPage } from '../support/login-page';

test.use({ storageState: { cookies: [], origins: [] } });

test('invalid credentials show an error without creating a session or logging the password', async ({ page }) => {
    await resetFakeServer();
    await page.addInitScript(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    const login = new LoginPage(page);
    await login.open();
    await login.signIn({
        serverUrl: new URL(page.url()).origin,
        username: 'e2e-user',
        password: 'incorrect-password'
    });

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveCount(0);

    const requests = await fakeServerRequests();
    const authentication = requests.find(request => request.path === '/Users/AuthenticateByName');
    expect(authentication?.status).toBe(401);
    expect(authentication?.body).toEqual({ Username: 'e2e-user', Pw: '[redacted]' });
    expect(requests.filter(request => request.status >= 400).map(request => request.path)).toEqual([ '/Users/AuthenticateByName' ]);
    expect(JSON.stringify(requests)).not.toContain('incorrect-password');
});
