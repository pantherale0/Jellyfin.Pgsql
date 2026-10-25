export type NormalizationMode = 'track' | 'album' | 'off';
export interface MusicSettings { normalization: NormalizationMode; crossfadeSeconds: number; gapless: boolean; volume: number }

const STORAGE_KEY = 'ui-next-music';
export const MAX_CROSSFADE_SECONDS = 12;
export const DEFAULT_MUSIC: MusicSettings = { normalization: 'album', crossfadeSeconds: 0, gapless: true, volume: 1 };

export function normalizeMusicSettings(raw: unknown): MusicSettings {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const crossfade = Number(value.crossfadeSeconds);
    const volume = Number(value.volume);
    return {
        normalization: value.normalization === 'track' || value.normalization === 'off' || value.normalization === 'album' ? value.normalization : DEFAULT_MUSIC.normalization,
        crossfadeSeconds: Number.isFinite(crossfade) ? Math.min(MAX_CROSSFADE_SECONDS, Math.max(0, Math.round(crossfade))) : DEFAULT_MUSIC.crossfadeSeconds,
        gapless: typeof value.gapless === 'boolean' ? value.gapless : DEFAULT_MUSIC.gapless,
        volume: value.volume !== undefined && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_MUSIC.volume,
    };
}

export function loadMusicSettings(): MusicSettings {
    try {
        return normalizeMusicSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch (_error) {
        return DEFAULT_MUSIC;
    }
}

export function saveMusicSettings(change: Partial<MusicSettings>): MusicSettings {
    const next = normalizeMusicSettings({ ...loadMusicSettings(), ...change });
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_error) { /* Private browsing: the setting applies to this page only. */ }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('ui-next-music', { detail: next }));
    }
    return next;
}
