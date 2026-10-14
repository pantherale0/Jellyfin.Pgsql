import type { MediaItem } from './types';

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
    { id: 'movies', title: 'Movies', types: [ 'Movie' ] },
    { id: 'shows', title: 'Shows', types: [ 'Series' ] },
    { id: 'episodes', title: 'Episodes', types: [ 'Episode' ] },
    { id: 'videos', title: 'Videos', types: [ 'Video', 'MusicVideo' ] },
    { id: 'collections', title: 'Collections', types: [ 'BoxSet' ] },
    { id: 'playlists', title: 'Playlists', types: [ 'Playlist' ] },
    { id: 'albums', title: 'Albums', types: [ 'MusicAlbum' ] },
    { id: 'songs', title: 'Songs', types: [ 'Audio' ] },
    { id: 'books', title: 'Books', types: [ 'Book' ] },
    { id: 'photos', title: 'Photos', types: [ 'Photo', 'PhotoAlbum' ] },
    { id: 'artists', title: 'Artists', path: '/Artists' },
    { id: 'people', title: 'People', path: '/Persons' },
];

export interface EntitySearchSection { id: string; title: string; path: '/Artists' | '/Persons' | '/Studios' | '/Genres' | '/MusicGenres' }

/** Named entities searched next to titles; `/Items` search does not return these. */
export const ENTITY_SEARCH_SECTIONS: EntitySearchSection[] = [
    { id: 'people', title: 'People', path: '/Persons' },
    { id: 'artists', title: 'Artists', path: '/Artists' },
    { id: 'genres', title: 'Genres', path: '/Genres' },
    { id: 'musicgenres', title: 'Music genres', path: '/MusicGenres' },
    { id: 'studios', title: 'Studios', path: '/Studios' },
];

/** Default entity types for responses that omit `Type`, so entity pages open with the right query. */
export function withEntityType(items: MediaItem[], path: EntitySearchSection['path'] | FavoriteGroup['path']): MediaItem[] {
    const type = { '/Artists': 'MusicArtist', '/Persons': 'Person', '/Studios': 'Studio', '/Genres': 'Genre', '/MusicGenres': 'MusicGenre' }[path || '/Artists'];
    return items.filter(item => item.Id && item.Name).map(item => item.Type ? item : { ...item, Type: type });
}

export type HomeSectionId = 'continue' | 'continue-listening' | 'continue-reading' | 'next-up' | 'for-you' | 'latest' | 'latest-libraries' | 'on-now' | 'recommendations' | 'explore';

export const HOME_SECTIONS: Array<{ id: HomeSectionId; label: string }> = [
    { id: 'continue', label: 'Continue watching' },
    { id: 'continue-listening', label: 'Continue listening' },
    { id: 'continue-reading', label: 'Continue reading' },
    { id: 'next-up', label: 'Next up' },
    { id: 'for-you', label: 'For you (taste profile)' },
    { id: 'latest', label: 'Just added' },
    { id: 'latest-libraries', label: 'Latest per library' },
    { id: 'on-now', label: 'On Now (Live TV)' },
    { id: 'recommendations', label: 'Because you watched' },
    { id: 'explore', label: 'Explore your library' },
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
    sectionIds.forEach(id => { if (!order.includes(id)) order.push(id); });
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
    if (tier === 'high') return 'Strong match';
    if (tier === 'mid') return 'Good match';
    return '';
}

/** Libraries that get a per-library Latest row. */
export function latestLibraries(views: MediaItem[], excluded: string[]): MediaItem[] {
    const skip = [ 'livetv', 'playlists', 'boxsets', 'folders' ];
    return views.filter(view => view.Id && !excluded.includes(view.Id) && !skip.includes((view.CollectionType || '').toLowerCase())).slice(0, 12);
}
