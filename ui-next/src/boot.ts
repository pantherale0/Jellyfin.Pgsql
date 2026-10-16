import { locale, readStoredLanguage, setLocale, textDirection } from './i18n';
import { localeLoaders } from './i18n/loaders';
import { applyDisplaySettings, loadDisplaySettings } from './display-settings';

/** Must match `SESSION_KEY` in main.tsx; read here so the signed-in user's language loads before any UI module. */
const SESSION_KEY = 'jellyfin-ui-next-session';

function storedUserId(): string | undefined {
    try {
        return (JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as { user?: { Id?: string } } | null)?.user?.Id;
    } catch {
        return undefined;
    }
}

export function applyDocumentLanguage(): void {
    document.documentElement.lang = locale();
    document.documentElement.dir = textDirection();
}

applyDisplaySettings(loadDisplaySettings());

// Module-level labels call t() when their module first evaluates, so the locale table has to be
// in place before the app is imported. Changing language therefore reloads the page.
void setLocale(readStoredLanguage(storedUserId()), localeLoaders)
    .catch(() => undefined)
    .then(() => {
        applyDocumentLanguage();
        return import('./main');
    });
