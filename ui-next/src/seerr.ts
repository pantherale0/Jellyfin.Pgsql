import type { TasteProfile } from './types';
import { t } from './i18n';

/** Seerr media status as reported by `Jellyfin.Plugin.Seerr` (`SeerrMediaStatus`). */
export const SeerrStatus = {
    Unknown: 0,
    Pending: 1,
    Processing: 2,
    PartiallyAvailable: 3,
    Available: 4,
    Blocklisted: 5,
    Deleted: 6
} as const;

export type SeerrMediaType = 'movie' | 'tv';

export interface SeerrItem {
    mediaType: SeerrMediaType;
    mediaId: number;
    title: string;
    year?: number;
    overview?: string;
    posterUrl?: string;
    status: number;
    canRequest: boolean;
}

export interface SeerrPersonalization {
    genreIds: number[];
    voteAverageGte?: number;
}

const MAX_TITLE = 300;
const MAX_OVERVIEW = 2000;
const MAX_ITEMS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function posterUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 500) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'image.tmdb.org' ? url.href : undefined;
    } catch {
        return undefined;
    }
}

function asSeerrItem(raw: unknown): SeerrItem | null {
    if (!isRecord(raw)) return null;
    const mediaType = raw.mediaType;
    const mediaId = raw.mediaId;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof mediaId !== 'number' || !Number.isInteger(mediaId) || mediaId <= 0 || !title) return null;
    const status = typeof raw.status === 'number' && Number.isInteger(raw.status) ? raw.status : SeerrStatus.Unknown;
    const item: SeerrItem = { mediaType, mediaId, title: title.slice(0, MAX_TITLE), status, canRequest: raw.canRequest === true };
    if (typeof raw.year === 'number' && Number.isInteger(raw.year) && raw.year > 1800 && raw.year < 3000) item.year = raw.year;
    if (typeof raw.overview === 'string' && raw.overview.trim()) item.overview = raw.overview.trim().slice(0, MAX_OVERVIEW);
    const poster = posterUrl(raw.posterUrl);
    if (poster) item.posterUrl = poster;
    return item;
}

/** `{ items }` from Search/Discover: malformed entries and duplicates are dropped, posters only from TMDB. */
export function asSeerrItems(raw: unknown): SeerrItem[] {
    const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
    const seen = new Set<string>();
    const result: SeerrItem[] = [];
    for (const entry of items) {
        const item = asSeerrItem(entry);
        if (!item || seen.has(seerrKey(item))) continue;
        seen.add(seerrKey(item));
        result.push(item);
        if (result.length >= MAX_ITEMS) break;
    }
    return result;
}

export function asSeerrEnabled(raw: unknown): boolean {
    return isRecord(raw) && (raw.enabled === true || raw.Enabled === true);
}

export function seerrKey(item: Pick<SeerrItem, 'mediaType' | 'mediaId'>): string {
    return `${item.mediaType}:${item.mediaId}`;
}

/** Search shows what can be requested plus what is already on its way. */
export function searchVisible(items: SeerrItem[]): SeerrItem[] {
    return items.filter(item => item.canRequest || item.status === SeerrStatus.Pending || item.status === SeerrStatus.Processing || item.status === SeerrStatus.PartiallyAvailable);
}

/** Discovery rows only suggest titles that can be requested. */
export function discoverVisible(items: SeerrItem[]): SeerrItem[] {
    return items.filter(item => item.canRequest);
}

export function seerrStatusLabel(item: Pick<SeerrItem, 'status'>): string | null {
    switch (item.status) {
    case SeerrStatus.Pending: return t('Requested');
    case SeerrStatus.Processing: return t('Processing');
    case SeerrStatus.PartiallyAvailable: return t('Partially available');
    default: return null;
    }
}

export function seerrMeta(item: Pick<SeerrItem, 'year' | 'mediaType'>): string {
    return [ item.year, item.mediaType === 'tv' ? t('Series') : t('Movie') ].filter(Boolean).join(' · ');
}

/** The item after a successful request: no longer requestable, shown as requested. */
export function markRequested(item: SeerrItem): SeerrItem {
    return { ...item, status: SeerrStatus.Pending, canRequest: false };
}

export function requestErrorMessage(error: unknown): string {
    const status = (error as { status?: unknown } | null)?.status;
    switch (status) {
    case 403: return t('This title can’t be requested on your account. It may be blocked by parental controls or your Seerr permissions.');
    case 409: return t('This title has already been requested.');
    case 429: return t('Too many requests right now. Try again in a moment.');
    case 503: return t('Requests are unavailable right now.');
    default: return t('The request could not be sent. Try again.');
    }
}

const GENRE_NAME_TO_TMDB_ID: Record<string, number> = {
    action: 28,
    adventure: 12,
    animation: 16,
    comedy: 35,
    crime: 80,
    documentary: 99,
    drama: 18,
    family: 10751,
    fantasy: 14,
    history: 36,
    horror: 27,
    music: 10402,
    mystery: 9648,
    romance: 10749,
    'science fiction': 878,
    'sci fi': 878,
    scifi: 878,
    thriller: 53,
    war: 10752,
    western: 37,
    'tv movie': 10770,
    'action adventure': 10759,
    'action and adventure': 10759,
    kids: 10762,
    news: 10763,
    reality: 10764,
    soap: 10766,
    talk: 10767,
    'war politics': 10768,
    'war and politics': 10768,
    'sci fi fantasy': 10765,
    'science fiction fantasy': 10765
};

export function normalizeGenreLabel(label: string): string {
    return label
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function mapGenreLabelsToTmdbIds(labels: string[], max = 5): number[] {
    const ids: number[] = [];
    for (const label of labels) {
        const id = GENRE_NAME_TO_TMDB_ID[normalizeGenreLabel(label)];
        if (id === undefined || ids.includes(id)) continue;
        ids.push(id);
        if (ids.length >= max) break;
    }
    return ids;
}

/** Top taste genres and the user's low-end rating become the Discover filters. */
export function seerrPersonalization(profile: TasteProfile | null | undefined): SeerrPersonalization {
    if (!profile?.HasProfile) return { genreIds: [] };
    const labels = (profile.Genres || [])
        .filter(genre => typeof genre?.Label === 'string' && genre.Label)
        .slice()
        .sort((a, b) => (b.Weight || 0) - (a.Weight || 0))
        .map(genre => genre.Label as string);
    const result: SeerrPersonalization = { genreIds: mapGenreLabelsToTmdbIds(labels, 5) };
    const floor = profile.RatingP25;
    if (typeof floor === 'number' && Number.isFinite(floor) && floor > 0) result.voteAverageGte = Math.min(10, Math.max(0, floor));
    return result;
}
