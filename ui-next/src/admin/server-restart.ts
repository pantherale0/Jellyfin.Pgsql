import type { AdminApi } from './admin-api';
import { t } from '../i18n';

export interface RestartMessages {
    started: string;
    down: string;
    failed: string;
}

export const RESTORE_MESSAGES: RestartMessages = {
    started: t('Restore started. Waiting for the server to restart…'),
    down: t('The server is restarting and restoring data…'),
    failed: t('The server did not restart. Check its logs for restore errors.')
};

export const RESTART_MESSAGES: RestartMessages = {
    started: t('Restarting the server…'),
    down: t('The server is restarting…'),
    failed: t('The server did not restart. Check its logs.')
};

/** Polls the public system info until the server has gone down and come back, for up to 10 minutes. */
export async function waitForRestart(api: Pick<AdminApi, 'getPublicSystemInfo'>, report: (state: string) => void, messages: RestartMessages = RESTART_MESSAGES): Promise<boolean> {
    report(messages.started);
    const deadline = Date.now() + 10 * 60_000;
    let wentDown = false;
    while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 3000));
        try {
            await api.getPublicSystemInfo();
            if (wentDown) { report(t('The server is back online. Sign in again if your session was reset.')); return true; }
        } catch {
            wentDown = true;
            report(messages.down);
        }
    }
    report(wentDown ? t('The server has not come back within 10 minutes. Check its logs.') : messages.failed);
    return false;
}
