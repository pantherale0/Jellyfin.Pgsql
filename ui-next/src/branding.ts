export interface Branding { loginDisclaimer: string; customCss: boolean; splashscreen: boolean }

export const NO_BRANDING: Branding = { loginDisclaimer: '', customCss: false, splashscreen: false };

/** Normalizes the anonymous /Branding/Configuration payload; the disclaimer is shown as plain text. */
export function normalizeBranding(raw: unknown): Branding {
    if (!raw || typeof raw !== 'object') return NO_BRANDING;
    const value = raw as Record<string, unknown>;
    const disclaimer = typeof value.LoginDisclaimer === 'string' ? value.LoginDisclaimer.trim().slice(0, 2000) : '';
    return {
        loginDisclaimer: disclaimer,
        customCss: typeof value.CustomCss === 'string' && value.CustomCss.trim().length > 0,
        splashscreen: value.SplashscreenEnabled === true,
    };
}

export function brandingAssets(server: string, branding: Branding): { cssUrl?: string; splashUrl?: string } {
    const base = server.replace(/\/+$/, '');
    return {
        cssUrl: branding.customCss ? `${base}/Branding/Css.css` : undefined,
        splashUrl: branding.splashscreen ? `${base}/Branding/Splashscreen` : undefined,
    };
}
