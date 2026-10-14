import type { LibraryQuery } from './library-query';
import type { MediaItem } from './types';

export type UserData = NonNullable<MediaItem['UserData']>;

export const SEARCH_PAGE_SIZE = 40;

export function searchSummary(loaded: number, total: number): string {
    if (!loaded) return 'No titles';
    if (total > loaded) return `Showing ${loaded.toLocaleString()} of ${total.toLocaleString()} titles`;
    return `${loaded.toLocaleString()} ${loaded === 1 ? 'title' : 'titles'}`;
}

export function hasMoreResults(loaded: number, total: number): boolean {
    return loaded < total;
}

/** Appends a page by id so overlapping pages after a server-side change do not duplicate cards. */
export function appendPage(current: MediaItem[], page: MediaItem[]): MediaItem[] {
    const seen = new Set(current.map(item => item.Id));
    return current.concat(page.filter(item => item.Id && !seen.has(item.Id)));
}

export type LibraryView = 'poster' | 'compact' | 'list' | 'thumb' | 'banner';

export interface LibraryBookmark {
    query: LibraryQuery;
    view: LibraryView;
    sortControl: string;
    startIndex: number;
    scrollY: number;
}

const libraryBookmarks = new Map<string, LibraryBookmark>();

export function saveLibraryBookmark(libraryId: string, bookmark: LibraryBookmark): void {
    libraryBookmarks.set(libraryId, { ...bookmark, startIndex: Math.max(0, bookmark.startIndex), scrollY: Math.max(0, bookmark.scrollY) });
}

export function peekLibraryBookmark(libraryId: string): LibraryBookmark | null {
    return libraryBookmarks.get(libraryId) || null;
}

export function clearLibraryBookmark(libraryId?: string): void {
    if (libraryId) libraryBookmarks.delete(libraryId);
    else libraryBookmarks.clear();
}

/** Folders and collections list their direct children; top-level typed libraries flatten into a catalog. */
export function listsDirectChildren(library: Pick<MediaItem, 'Type' | 'CollectionType'>): boolean {
    if (library.Type === 'Folder' || library.Type === 'BoxSet' || library.Type === 'Playlist') return true;
    return library.Type === 'CollectionFolder' && !library.CollectionType;
}

export function isContainer(item: Pick<MediaItem, 'Type'>): boolean {
    return [ 'Folder', 'CollectionFolder', 'BoxSet', 'Playlist', 'UserView' ].indexOf(item.Type || '') >= 0;
}

export function pushTrail(trail: MediaItem[], current: MediaItem | null, next: MediaItem): MediaItem[] {
    if (!current || current.Id === next.Id) return trail;
    const existing = trail.findIndex(entry => entry.Id === next.Id);
    if (existing >= 0) return trail.slice(0, existing);
    return trail.concat(current);
}

export function popTrail(trail: MediaItem[]): { parent: MediaItem | null; trail: MediaItem[] } {
    if (!trail.length) return { parent: null, trail };
    return { parent: trail[trail.length - 1], trail: trail.slice(0, -1) };
}

export function mergeUserData<T extends MediaItem>(items: T[], itemId: string, userData: UserData): T[] {
    let changed = false;
    const next = items.map(item => {
        if (item.Id !== itemId) return item;
        changed = true;
        return { ...item, UserData: { ...item.UserData, ...userData } };
    });
    return changed ? next : items;
}

/** Whether an item still belongs to a filtered catalog after its user data changes. */
export function matchesWatchFilter(item: Pick<MediaItem, 'UserData'>, filter: LibraryQuery['WatchStatus']): boolean {
    const data = item.UserData || {};
    if (filter === 'favorite') return data.IsFavorite === true;
    if (filter === 'unplayed') return data.Played !== true;
    if (filter === 'played') return data.Played === true;
    if (filter === 'resumable') return data.Played !== true && (data.PlaybackPositionTicks || 0) > 0;
    return true;
}

export function applyUserDataChange(items: MediaItem[], itemId: string, userData: UserData, filter: LibraryQuery['WatchStatus'], favoriteOnly = false): { items: MediaItem[]; removed: number } {
    const merged = mergeUserData(items, itemId, userData);
    const kept = merged.filter(item => item.Id !== itemId || (matchesWatchFilter(item, filter) && (!favoriteOnly || item.UserData?.IsFavorite === true)));
    return { items: kept, removed: merged.length - kept.length };
}

/** Played toggles clear progress locally when the server returns only the changed flag. */
export function playedUserData(current: UserData | undefined, played: boolean, returned?: UserData | null): UserData {
    if (returned && Object.keys(returned).length) return returned;
    return { ...current, Played: played, PlaybackPositionTicks: played ? 0 : current?.PlaybackPositionTicks, PlayedPercentage: played ? undefined : current?.PlayedPercentage, UnplayedItemCount: played ? 0 : current?.UnplayedItemCount };
}

const PLAYABLE_TYPES = [ 'Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer', 'TvChannel', 'Program', 'Recording' ];
const ENTITY_TYPES = [ 'Person', 'Genre', 'MusicGenre', 'Studio', 'MusicArtist', 'Tag' ];
const UNPLAYED_STATE_TYPES = [ ...ENTITY_TYPES, 'Photo', 'PhotoAlbum', 'TvChannel', 'Program', 'Folder', 'CollectionFolder', 'UserView', 'Playlist' ];

export interface ItemCapabilities {
    playable: boolean;
    canMarkPlayed: boolean;
    canFavorite: boolean;
    entity: boolean;
    container: boolean;
}

export function itemCapabilities(item: Pick<MediaItem, 'Type' | 'MediaType'>): ItemCapabilities {
    const type = item.Type || '';
    const entity = ENTITY_TYPES.indexOf(type) >= 0;
    return {
        playable: PLAYABLE_TYPES.indexOf(type) >= 0 || (item.MediaType === 'Video' && type !== 'Photo'),
        canMarkPlayed: UNPLAYED_STATE_TYPES.indexOf(type) < 0,
        canFavorite: type !== 'UserView' && type !== 'CollectionFolder' && type !== 'Tag',
        entity,
        container: isContainer(item)
    };
}

export function entityQuery(item: Pick<MediaItem, 'Type' | 'Id'>): Record<string, string> | null {
    switch (item.Type) {
    case 'Person': return { PersonIds: item.Id };
    case 'Genre': return { GenreIds: item.Id };
    case 'MusicGenre': return { GenreIds: item.Id };
    case 'Studio': return { StudioIds: item.Id };
    case 'MusicArtist': return { ArtistIds: item.Id };
    case 'Tag': return item.Id.startsWith('tag:') ? { Tags: item.Id.slice(4) } : null;
    default: return null;
    }
}

export function adjacentEpisodes(items: MediaItem[], currentId: string): { previous: MediaItem | null; next: MediaItem | null } {
    const index = items.findIndex(item => item.Id === currentId);
    if (index < 0) return { previous: null, next: null };
    return { previous: items[index - 1] || null, next: items[index + 1] || null };
}

/** Series/season watched changes apply to every loaded episode below them. */
export function markEpisodesPlayed(bySeason: Record<string, MediaItem[]>, seasonIds: string[] | null, played: boolean): Record<string, MediaItem[]> {
    const next: Record<string, MediaItem[]> = {};
    Object.keys(bySeason).forEach(seasonId => {
        next[seasonId] = !seasonIds || seasonIds.includes(seasonId)
            ? bySeason[seasonId].map(episode => ({ ...episode, UserData: playedUserData(episode.UserData, played) }))
            : bySeason[seasonId];
    });
    return next;
}
