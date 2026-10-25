export type ThemeChoice = 'dark' | 'light' | 'system';
export type TextSize = 90 | 100 | 115 | 130;
export interface DisplaySettings { theme: ThemeChoice; textSize: TextSize; reducedMotion: boolean }

const STORAGE_KEY = 'ui-next-display';
export const THEME_CHOICES: ThemeChoice[] = [ 'dark', 'light', 'system' ];
export const TEXT_SIZES: TextSize[] = [ 90, 100, 115, 130 ];
export const DEFAULT_DISPLAY: DisplaySettings = { theme: 'dark', textSize: 100, reducedMotion: false };

export function normalizeDisplaySettings(raw: unknown): DisplaySettings {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const size = typeof value.textSize === 'string' ? Number(value.textSize) : value.textSize;
    return {
        theme: THEME_CHOICES.includes(value.theme as ThemeChoice) ? value.theme as ThemeChoice : DEFAULT_DISPLAY.theme,
        textSize: TEXT_SIZES.includes(size as TextSize) ? size as TextSize : DEFAULT_DISPLAY.textSize,
        reducedMotion: typeof value.reducedMotion === 'boolean' ? value.reducedMotion : DEFAULT_DISPLAY.reducedMotion,
    };
}

export function loadDisplaySettings(): DisplaySettings {
    try {
        return normalizeDisplaySettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch (_error) {
        return DEFAULT_DISPLAY;
    }
}

/** Theme, text size and motion live on `<html>` so the stylesheet and every module read the same values. */
export function applyDisplaySettings(settings: DisplaySettings, root: HTMLElement = document.documentElement): void {
    root.dataset.theme = settings.theme;
    root.style.fontSize = settings.textSize === 100 ? '' : `${settings.textSize}%`;
    if (settings.reducedMotion) root.dataset.motion = 'reduce';
    else delete root.dataset.motion;
}

export function saveDisplaySettings(change: Partial<DisplaySettings>): DisplaySettings {
    const next = normalizeDisplaySettings({ ...loadDisplaySettings(), ...change });
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_error) { /* Private browsing: the setting applies to this page only. */ }
    if (typeof document !== 'undefined') applyDisplaySettings(next);
    return next;
}

export function prefersReducedMotion(): boolean {
    if (typeof document !== 'undefined' && document.documentElement?.dataset.motion === 'reduce') return true;
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_error) {
        return false;
    }
}
