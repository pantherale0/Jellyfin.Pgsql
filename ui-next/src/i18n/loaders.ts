import type { LocaleLoader } from '../i18n';

const modules = import.meta.glob<{ default: Record<string, string> }>('./locales/*.json');

/** Lazy locale tables by Jellyfin Web language code (`fr`, `pt-br`); English needs no table. */
export const localeLoaders: Record<string, LocaleLoader> = Object.fromEntries(
    Object.entries(modules).map(([ path, load ]) => [ path.replace(/^.*\/([^/]+)\.json$/, '$1'), load ])
);
