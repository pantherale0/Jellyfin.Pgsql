export type LayoutChoice = 'auto' | 'tv' | 'desktop';

export const LAYOUT_STORAGE_KEY = 'ui-next-layout';

const TV_USER_AGENT = /web0s|webos|tizen|smart[- ]?tv|samsungbrowser|netcast|vidaa|titanos|roku|playstation|xbox|android tv|jellyfin.*tv|aft[a-z0-9]+/;

export interface LayoutSignals {
    userAgent: string;
    /** Explicit choice from the URL (?layout=) or device settings. */
    choice?: string | null;
    /** Layout reported by a native wrapper's AppHost, when it exposes one. */
    nativeLayout?: string | null;
}

export function normalizeLayoutChoice(value: unknown): LayoutChoice {
    return value === 'tv' || value === 'desktop' ? value : 'auto';
}

/**
 * A native bridge alone does not mean TV: phone and desktop wrappers expose
 * NativeShell too. Prefer an explicit choice, then the wrapper's own layout,
 * then the user agent.
 */
export function classifyLayout(signals: LayoutSignals): 'tv' | 'desktop' {
    const choice = normalizeLayoutChoice(signals.choice);
    if (choice !== 'auto') return choice;
    const native = (signals.nativeLayout || '').toLowerCase();
    if (native === 'tv') return 'tv';
    if (native === 'mobile' || native === 'desktop') return 'desktop';
    return TV_USER_AGENT.test(signals.userAgent.toLowerCase()) ? 'tv' : 'desktop';
}

export function readLayoutChoice(): LayoutChoice {
    try {
        const fromUrl = new URL(window.location.href).searchParams.get('layout');
        if (fromUrl) return normalizeLayoutChoice(fromUrl);
    } catch (_error) { /* An unusual location keeps the stored choice. */ }
    try {
        return normalizeLayoutChoice(localStorage.getItem(LAYOUT_STORAGE_KEY));
    } catch (_error) {
        return 'auto';
    }
}

export function saveLayoutChoice(choice: LayoutChoice): void {
    try {
        if (choice === 'auto') localStorage.removeItem(LAYOUT_STORAGE_KEY);
        else localStorage.setItem(LAYOUT_STORAGE_KEY, choice);
    } catch (_error) { /* Storage can be disabled. */ }
}

export function nativeShellLayout(): string | null {
    const shell = (window as Window & { NativeShell?: { AppHost?: { getDefaultLayout?: () => unknown } } }).NativeShell;
    try {
        const layout = shell?.AppHost?.getDefaultLayout?.();
        return typeof layout === 'string' ? layout : null;
    } catch (_error) {
        return null;
    }
}

let cached: 'tv' | 'desktop' | null = null;

export function isTvLayout(): boolean {
    if (!cached) cached = classifyLayout({ userAgent: navigator.userAgent, choice: readLayoutChoice(), nativeLayout: nativeShellLayout() });
    return cached === 'tv';
}
