import type { MediaItem } from './types';
import { t } from './i18n';

export interface FavoriteGroup {
    id: string;
    title: string;
    /** `/Items` item types; omitted for entity endpoints. */
    types?: string[];
    /** Entity endpoint used instead of `/Items`. */
    path?: '/Artists' | '/Persons';
}

/** Global Favorites, grouped like Jellyfin Web's Favorites page. */
export const FAVORITE_GROUPS: FavoriteGroup[] = [
    { id: 'movies', title: t('Movies'), types: [ 'Movie' ] },
    { id: 'shows', title: t('Shows'), types: [ 'Series' ] },
    { id: 'episodes', title: t('Episodes'), types: [ 'Episode' ] },
    { id: 'videos', title: t('Videos'), types: [ 'Video', 'MusicVideo' ] },
    { id: 'collections', title: t('Collections'), types: [ 'BoxSet' ] },
    { id: 'playlists', title: t('Playlists'), types: [ 'Playlist' ] },
    { id: 'albums', title: t('Albums'), types: [ 'MusicAlbum' ] },
    { id: 'songs', title: t('Songs'), types: [ 'Audio' ] },
    { id: 'books', title: t('Books'), types: [ 'Book' ] },
    { id: 'photos', title: t('Photos'), types: [ 'Photo', 'PhotoAlbum' ] },
    { id: 'artists', title: t('Artists'), path: '/Artists' },
    { id: 'people', title: t('People'), path: '/Persons' },
];

export interface EntitySearchSection { id: string; title: string; path: '/Artists' | '/Persons' | '/Studios' | '/Genres' | '/MusicGenres' }

/** Named entities searched next to titles; `/Items` search does not return these. */
export const ENTITY_SEARCH_SECTIONS: EntitySearchSection[] = [
    { id: 'people', title: t('People'), path: '/Persons' },
    { id: 'artists', title: t('Artists'), path: '/Artists' },
    { id: 'genres', title: t('Genres'), path: '/Genres' },
    { id: 'musicgenres', title: t('Music genres'), path: '/MusicGenres' },
    { id: 'studios', title: t('Studios'), path: '/Studios' },
];

/** Default entity types for responses that omit `Type`, so entity pages open with the right query. */
export function withEntityType(items: MediaItem[], path: EntitySearchSection['path'] | FavoriteGroup['path']): MediaItem[] {
    const type = { '/Artists': 'MusicArtist', '/Persons': 'Person', '/Studios': 'Studio', '/Genres': 'Genre', '/MusicGenres': 'MusicGenre' }[path || '/Artists'];
    return items.filter(item => item.Id && item.Name).map(item => item.Type ? item : { ...item, Type: type });
}

export type HomeSectionId = 'continue' | 'continue-listening' | 'continue-reading' | 'next-up' | 'for-you' | 'latest' | 'latest-libraries' | 'on-now' | 'recommendations' | 'beyond' | 'explore';

export const HOME_SECTIONS: Array<{ id: HomeSectionId; label: string }> = [
    { id: 'continue', label: t('Continue watching') },
    { id: 'continue-listening', label: t('Continue listening') },
    { id: 'continue-reading', label: t('Continue reading') },
    { id: 'next-up', label: t('Next up') },
    { id: 'for-you', label: t('For you (taste profile)') },
    { id: 'latest', label: t('Just added') },
    { id: 'latest-libraries', label: t('Latest per library') },
    { id: 'on-now', label: t('On Now (Live TV)') },
    { id: 'recommendations', label: t('Recommendations') },
    { id: 'beyond', label: t('Beyond your library (Seerr)') },
    { id: 'explore', label: t('Explore your library') },
];

export interface HomePreferences {
    order: HomeSectionId[];
    hidden: HomeSectionId[];
    /** Library IDs left out of the per-library Latest rows. */
    excludedLatest: string[];
}

const DEFAULT_HIDDEN: HomeSectionId[] = [ 'latest-libraries' ];
const HOME_KEY = 'ui-next-home-sections';
const sectionIds = HOME_SECTIONS.map(section => section.id);

export const defaultHomePreferences = (): HomePreferences => ({ order: [ ...sectionIds ], hidden: [ ...DEFAULT_HIDDEN ], excludedLatest: [] });

export function normalizeHomePreferences(raw: unknown): HomePreferences {
    const value = raw && typeof raw === 'object' ? raw as Partial<Record<keyof HomePreferences, unknown>> : {};
    const known = (entries: unknown) => Array.isArray(entries) ? entries.filter((entry): entry is HomeSectionId => sectionIds.includes(entry as HomeSectionId)) : null;
    const order = Array.from(new Set(known(value.order) || []));
    // Sections added after a layout was saved follow their default predecessor, but never land behind Explore.
    sectionIds.forEach((id, index) => {
        if (order.includes(id)) return;
        const predecessor = sectionIds.slice(0, index).reverse().find(previous => order.includes(previous));
        let at = predecessor ? order.indexOf(predecessor) + 1 : order.length;
        const explore = order.indexOf('explore');
        if (id !== 'explore' && explore >= 0 && at > explore) at = explore;
        order.splice(at, 0, id);
    });
    const hidden = known(value.hidden);
    const excluded = Array.isArray(value.excludedLatest) ? value.excludedLatest.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 80).slice(0, 100) : [];
    return { order, hidden: hidden ? Array.from(new Set(hidden)) : [ ...DEFAULT_HIDDEN ], excludedLatest: excluded };
}

/** Home layout is per user on this device. */
export function loadHomePreferences(userId: string): HomePreferences {
    try {
        const raw = localStorage.getItem(`${HOME_KEY}:${userId}`);
        return normalizeHomePreferences(raw ? JSON.parse(raw) : null);
    } catch {
        return defaultHomePreferences();
    }
}

export function saveHomePreferences(userId: string, preferences: HomePreferences): void {
    try { localStorage.setItem(`${HOME_KEY}:${userId}`, JSON.stringify(normalizeHomePreferences(preferences))); } catch { /* Storage may be disabled. */ }
    try { window.dispatchEvent?.(new CustomEvent('ui-next-home-sections')); } catch { /* Older engines without CustomEvent. */ }
}

export function moveSection(order: HomeSectionId[], id: HomeSectionId, direction: -1 | 1): HomeSectionId[] {
    const index = order.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return order;
    const next = [ ...order ];
    [ next[index], next[target] ] = [ next[target], next[index] ];
    return next;
}

/** Which configurable section a home rail belongs to. */
export function sectionOfRail(id: string): HomeSectionId | null {
    if (id.startsWith('recommendation-')) return 'recommendations';
    if (id.startsWith('explore-')) return 'explore';
    if (id.startsWith('for-you-')) return 'for-you';
    if (id.startsWith('beyond-')) return 'beyond';
    if (id.startsWith('latest-library-')) return 'latest-libraries';
    return sectionIds.includes(id as HomeSectionId) ? id as HomeSectionId : null;
}

/** Orders rails by section preference (stable within a section) and drops hidden sections. */
export function arrangeRails<T extends { id: string }>(rails: T[], preferences: HomePreferences): T[] {
    const rank = (rail: T) => {
        const section = sectionOfRail(rail.id);
        return section ? preferences.order.indexOf(section) : preferences.order.length;
    };
    return rails
        .filter(rail => { const section = sectionOfRail(rail.id); return !section || !preferences.hidden.includes(section); })
        .map((rail, index) => ({ rail, index }))
        .sort((left, right) => rank(left.rail) - rank(right.rail) || left.index - right.index)
        .map(entry => entry.rail);
}

export function tasteTierLabel(tier?: string): string {
    if (tier === 'high') return t('Strong match');
    if (tier === 'mid') return t('Good match');
    return '';
}

/** Libraries that get a per-library Latest row. */
export function latestLibraries(views: MediaItem[], excluded: string[]): MediaItem[] {
    const skip = [ 'livetv', 'playlists', 'boxsets', 'folders' ];
    return views.filter(view => view.Id && !excluded.includes(view.Id) && !skip.includes((view.CollectionType || '').toLowerCase())).slice(0, 12);
}
