import type { Page } from '@playwright/test';

type LiveTab = 'now' | 'guide' | 'channels' | 'dvr';

const liveTabNames: Record<LiveTab, string> = {
    now: 'On Now',
    guide: 'Guide',
    channels: 'Channels',
    dvr: 'DVR'
};

export class MobileUiNextPage {
    private readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    async openHome(): Promise<void> {
        await this.page.goto('/');
    }

    async openLibrary(name: string): Promise<void> {
        await this.page.getByRole('button', { name: 'Open navigation menu', exact: true }).click();
        await this.page.getByRole('dialog', { name: 'Libraries' }).getByRole('button', { name, exact: true }).click();
    }

    async openLiveTab(tab: LiveTab): Promise<void> {
        const tabs = this.page.getByRole('tablist', { name: 'Live TV' });
        if (!(await tabs.isVisible())) {
            await this.page.goto(`/?live=${tab}`);
            return;
        }
        await tabs.getByRole('tab', { name: liveTabNames[tab], exact: true }).click();
    }
}
