import { type Locator, type Page } from '@playwright/test';

export class LoginPage {
    private readonly page: Page;
    private readonly passwordLogin: Locator;
    private readonly serverAddress: Locator;
    private readonly username: Locator;
    private readonly password: Locator;
    private readonly submit: Locator;

    constructor(page: Page) {
        this.page = page;
        this.passwordLogin = page.getByRole('button', { name: /Username and password/ });
        this.serverAddress = page.getByLabel('Server address');
        this.username = page.getByLabel('Username');
        this.password = page.getByLabel('Password');
        this.submit = page.getByRole('button', { name: 'Sign in', exact: true });
    }

    async open(): Promise<void> {
        await this.page.goto('/');
    }

    async signIn(input: { serverUrl: string; username: string; password: string }): Promise<void> {
        await this.passwordLogin.click();
        if (await this.serverAddress.isVisible()) await this.serverAddress.fill(input.serverUrl);
        await this.username.fill(input.username);
        await this.password.fill(input.password);
        await this.submit.click();
    }
}
