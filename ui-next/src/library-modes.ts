import type { LibrarySource } from './library-query';
import type { MediaItem } from './types';

export interface LibraryMode {
    id: string;
    label: string;
    /** Item types to list; undefined keeps the library default. */
    itemTypes?: string[];
    /** Overrides whether the library is listed recursively. */
    recursive?: boolean;
    source?: LibrarySource;
    /** Library-local Continue watching / Next up / Latest / recommendation rows instead of a grid. */
    suggestions?: boolean;
    /** Square artwork (albums, artists, songs, photos). */
    square?: boolean;
    /** The server fixes the order and ignores filters (upcoming episodes). */
    fixedOrder?: boolean;
    /** Unit used in the count label. */
    noun: string;
}

/** Views offered per library type, mirroring Jellyfin Web's library tabs. The first entry is the default. */
export function libraryModes(library: Pick<MediaItem, 'Type' | 'CollectionType'>): LibraryMode[] {
    if (library.Type !== 'CollectionFolder' && library.Type !== 'UserView') return [ { id: 'all', label: 'All', noun: 'titles' } ];
    switch ((library.CollectionType || '').toLowerCase()) {
    case 'movies': return [
        { id: 'movies', label: 'Movies', noun: 'titles' },
        { id: 'suggestions', label: 'Suggestions', suggestions: true, noun: 'titles' },
    ];
    case 'tvshows': return [
        { id: 'shows', label: 'Shows', itemTypes: [ 'Series' ], recursive: false, noun: 'shows' },
        { id: 'suggestions', label: 'Suggestions', suggestions: true, noun: 'shows' },
        { id: 'upcoming', label: 'Upcoming', source: 'upcoming', fixedOrder: true, noun: 'episodes' },
        { id: 'episodes', label: 'Episodes', itemTypes: [ 'Episode' ], recursive: true, noun: 'episodes' },
    ];
    case 'music': return [
        { id: 'albums', label: 'Albums', itemTypes: [ 'MusicAlbum' ], recursive: true, square: true, noun: 'albums' },
        { id: 'suggestions', label: 'Suggestions', suggestions: true, square: true, noun: 'albums' },
        { id: 'albumartists', label: 'Album artists', source: 'albumArtists', square: true, noun: 'artists' },
        { id: 'artists', label: 'Artists', source: 'artists', square: true, noun: 'artists' },
        { id: 'songs', label: 'Songs', itemTypes: [ 'Audio' ], recursive: true, square: true, noun: 'songs' },
    ];
    case 'books': return [
        { id: 'books', label: 'Books', itemTypes: [ 'Book' ], recursive: true, noun: 'books' },
        { id: 'folders', label: 'Folders', recursive: false, noun: 'items' },
    ];
    case 'homevideos':
    case 'photos': return [
        { id: 'folders', label: 'Folders', recursive: false, square: true, noun: 'items' },
        { id: 'photos', label: 'Photos', itemTypes: [ 'Photo' ], recursive: true, square: true, noun: 'photos' },
        { id: 'videos', label: 'Videos', itemTypes: [ 'Video' ], recursive: true, noun: 'videos' },
    ];
    case 'musicvideos': return [
        { id: 'videos', label: 'Music videos', itemTypes: [ 'MusicVideo' ], recursive: true, noun: 'videos' },
        { id: 'folders', label: 'Folders', recursive: false, noun: 'items' },
    ];
    default: return [ { id: 'all', label: 'All', noun: 'titles' } ];
    }
}

export function currentMode(modes: LibraryMode[], id: string): LibraryMode {
    return modes.find(mode => mode.id === id) || modes[0];
}

/** Image type for a library card in the given layout, falling back to what the item actually has. */
export function cardImageType(item: Pick<MediaItem, 'ImageTags' | 'BackdropImageTags'>, view: string): string {
    const has = (type: string) => Boolean(item.ImageTags?.[type]);
    if (view === 'banner') return has('Banner') ? 'Banner' : has('Thumb') ? 'Thumb' : item.BackdropImageTags?.length ? 'Backdrop' : 'Primary';
    if (view === 'thumb') return has('Thumb') ? 'Thumb' : item.BackdropImageTags?.length ? 'Backdrop' : 'Primary';
    return 'Primary';
}
