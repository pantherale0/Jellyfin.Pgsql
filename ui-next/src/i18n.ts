/**
 * Messages are keyed by their English text, so untranslated strings render as written and
 * module-level labels need no lookup table. Locale tables map that English text to a translation.
 * Placeholders use Jellyfin's `{0}`, `{1}` form.
 */
export type MessageTable = Readonly<Record<string, string>>;
export type LocaleLoader = () => Promise<MessageTable | { default: MessageTable }>;

export const DEFAULT_LANGUAGE = 'en-us';
const RTL_LANGUAGES = [ 'ar', 'fa', 'ur', 'he' ];

let table: MessageTable = {};
let language = DEFAULT_LANGUAGE;

/** Translates `message` (English text) and fills `{0}`-style placeholders. */
export function t(message: string, ...args: unknown[]): string {
    const text = table[message] || message;
    return args.length ? format(text, args) : text;
}

export function format(text: string, args: readonly unknown[]): string {
    return text.replace(/\{(\d+)\}/g, (match, index: string) => {
        const value = args[Number(index)];
        return value === undefined || value === null ? match : String(value);
    });
}

/** Jellyfin Web language codes are lower-case with `-` (`pt-br`); files may use `_` (`ar_SA.json`). */
export function normalizeLanguage(code: string | null | undefined): string {
    return (code || '').trim().replace(/_/g, '-').toLowerCase();
}

/** Candidate locale files for a language: exact, then base language, then English. */
export function languageCandidates(code: string | null | undefined, available: readonly string[]): string[] {
    const wanted = normalizeLanguage(code);
    const base = wanted.split('-')[0];
    const candidates: string[] = [];
    if (base === 'en') return [ DEFAULT_LANGUAGE ];
    if (wanted && available.includes(wanted)) candidates.push(wanted);
    if (base && base !== wanted && available.includes(base)) candidates.push(base);
    else if (base && !candidates.length) {
        const regional = available.find(entry => entry.split('-')[0] === base);
        if (regional) candidates.push(regional);
    }
    if (!candidates.includes(DEFAULT_LANGUAGE)) candidates.push(DEFAULT_LANGUAGE);
    return candidates;
}

export function isRtlLanguage(code: string | null | undefined): boolean {
    return RTL_LANGUAGES.includes(normalizeLanguage(code).split('-')[0]);
}

/** BCP 47 tag of the active language, for `Intl` and `toLocale*String`. */
export function locale(): string {
    const [ base, region ] = language.split('-');
    return region ? `${base}-${region.toUpperCase()}` : base;
}

export function currentLanguage(): string {
    return language;
}

export function textDirection(): 'rtl' | 'ltr' {
    return isRtlLanguage(language) ? 'rtl' : 'ltr';
}

/** Multiplier for horizontal scroll deltas: forward is negative `scrollLeft` in a right-to-left layout. */
export function inlineSign(): 1 | -1 {
    return textDirection() === 'rtl' ? -1 : 1;
}

/** Jellyfin's per-user language key. */
export function languageStorageKey(userId: string): string {
    return `${userId}-language`;
}

export function readStoredLanguage(userId: string | null | undefined): string {
    if (!userId) return '';
    try { return localStorage.getItem(languageStorageKey(userId)) || ''; } catch { return ''; }
}

export function storeLanguage(userId: string, code: string): void {
    try {
        if (code) localStorage.setItem(languageStorageKey(userId), normalizeLanguage(code));
        else localStorage.removeItem(languageStorageKey(userId));
    } catch { /* Private browsing: applies to this page only. */ }
}

/** The browser's preferred language when the user has not chosen one ("Auto"). */
export function browserLanguage(): string {
    if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE;
    return normalizeLanguage(navigator.languages?.[0] || navigator.language || DEFAULT_LANGUAGE);
}

/** The language `setLocale` would pick for this user, so a sign-in can tell whether the page must reload. */
export function resolveLanguage(code: string | null | undefined, available: readonly string[]): string {
    return languageCandidates(normalizeLanguage(code) || browserLanguage(), available)[0] || DEFAULT_LANGUAGE;
}

/** Loads the best table for `code`; a failed or missing file falls back along the candidate list. */
export async function setLocale(code: string | null | undefined, loaders: Readonly<Record<string, LocaleLoader>>): Promise<string> {
    const wanted = normalizeLanguage(code) || browserLanguage();
    for (const candidate of languageCandidates(wanted, Object.keys(loaders))) {
        if (candidate === DEFAULT_LANGUAGE) break;
        try {
            const loaded = await loaders[candidate]();
            table = 'default' in loaded && typeof loaded.default === 'object' ? loaded.default as MessageTable : loaded as MessageTable;
            language = candidate;
            return language;
        } catch { /* Try the next candidate. */ }
    }
    table = {};
    language = DEFAULT_LANGUAGE;
    return language;
}

/** Installs a table directly (tests, and resetting to English). */
export function loadMessages(code: string, messages: MessageTable): void {
    table = messages;
    language = normalizeLanguage(code) || DEFAULT_LANGUAGE;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    try { return new Intl.NumberFormat(locale(), options).format(value); } catch { return String(value); }
}

export function formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try { return new Intl.DateTimeFormat(locale(), options).format(date); } catch { return date.toISOString(); }
}

/** Display name of a language in that language ("Français"), falling back to the code. */
export function languageName(code: string): string {
    const tag = code.replace(/-([a-z]+)$/, (_match, region: string) => `-${region.toUpperCase()}`);
    const DisplayNames = (Intl as unknown as { DisplayNames?: new (locales: string[], options: { type: 'language' }) => { of(code: string): string | undefined } }).DisplayNames;
    if (!DisplayNames) return code;
    try {
        const name = new DisplayNames([ tag ], { type: 'language' }).of(tag);
        return name ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : code;
    } catch {
        return code;
    }
}
