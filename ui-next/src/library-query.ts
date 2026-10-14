export type LibrarySort = 'SortName' | 'PremiereDate' | 'DateCreated' | 'CriticRating' | 'CommunityRating' | 'Runtime' | 'Random' | 'DatePlayed' | 'PlayCount' | 'OfficialRating';

export const librarySortOptions: Array<[string, string]> = [
    [ 'SortName:Ascending', 'Sort: Title (A-Z)' ],
    [ 'SortName:Descending', 'Sort: Title (Z-A)' ],
    [ 'PremiereDate:Descending', 'Sort: Release date (newest)' ],
    [ 'PremiereDate:Ascending', 'Sort: Release date (oldest)' ],
    [ 'DateCreated:Descending', 'Sort: Date added (newest)' ],
    [ 'DatePlayed:Descending', 'Sort: Recently played' ],
    [ 'PlayCount:Descending', 'Sort: Most played' ],
    [ 'CommunityRating:Descending', 'Sort: Community rating (high-low)' ],
    [ 'CriticRating:Descending', 'Sort: Critic rating (high-low)' ],
    [ 'OfficialRating:Ascending', 'Sort: Parental rating' ],
    [ 'Runtime:Descending', 'Sort: Runtime' ],
    [ 'Random:Ascending', 'Sort: Random' ]
];
export type LibraryResolution = '' | '4k' | '1080p';
/** `favorite` is kept so restored bookmarks from before the separate Favorites toggle still apply. */
export type LibraryWatchStatus = '' | 'unplayed' | 'played' | 'resumable' | 'favorite';
export type LibraryFeature = 'subtitles' | 'trailer' | 'special';
export type LibraryEpisodeAvailability = '' | 'missing' | 'unaired';
export type LibrarySeriesStatus = '' | 'Continuing' | 'Ended';

export interface LibraryQuery {
    /** Pipe-separated genre names (Jellyfin's `Genres` delimiter). */
    Genre: string;
    /** Pipe-separated decade starts, e.g. `1990|2000`. */
    Decade: string;
    Resolution: LibraryResolution;
    WatchStatus: LibraryWatchStatus;
    SortBy: LibrarySort;
    SortOrder: 'Ascending' | 'Descending';
    Title: string;
    Mode: string;
    Favorite: boolean;
    /** Pipe-separated tags. */
    Tags: string;
    /** Pipe-separated official ratings. */
    Ratings: string;
    SeriesStatus: LibrarySeriesStatus;
    Features: LibraryFeature[];
    Availability: LibraryEpisodeAvailability;
}

export interface LibraryItemsOptions {
    StartIndex?: number;
    Limit?: number;
    Query?: LibraryQuery;
    Years?: number[];
    IncludeItemTypes?: string[];
    Recursive?: boolean;
    IncludePeople?: boolean;
    Fields?: string;
    Signal?: AbortSignal;
    /** Which list endpoint backs the view; `/Items` unless a library mode lists artists or upcoming episodes. */
    Source?: LibrarySource;
}

export type LibrarySource = 'items' | 'albumArtists' | 'artists' | 'upcoming';

export const defaultLibraryQuery = (): LibraryQuery => ({
    Genre: '', Decade: '', Resolution: '', WatchStatus: '', SortBy: 'SortName', SortOrder: 'Ascending', Title: '',
    Mode: '', Favorite: false, Tags: '', Ratings: '', SeriesStatus: '', Features: [], Availability: ''
});

export const splitValues = (value: string | undefined): string[] => (value || '').split('|').map(entry => entry.trim()).filter(Boolean);

/** Adds or removes one value from a pipe-separated multi-value filter. */
export function toggleValue(value: string | undefined, entry: string): string {
    const values = splitValues(value);
    return (values.includes(entry) ? values.filter(current => current !== entry) : [ ...values, entry ]).join('|');
}

/** Every year covered by the selected decades. */
export function decadeYears(decades: string): number[] | undefined {
    const years = splitValues(decades).map(Number).filter(Number.isFinite).flatMap(start => Array.from({ length: 10 }, (_value, offset) => start + offset));
    return years.length ? years : undefined;
}

export function activeFilterCount(query: LibraryQuery): number {
    return splitValues(query.Genre).length + splitValues(query.Decade).length + splitValues(query.Tags).length + splitValues(query.Ratings).length
        + Number(Boolean(query.Resolution)) + Number(Boolean(query.WatchStatus)) + Number(Boolean(query.Favorite))
        + Number(Boolean(query.SeriesStatus)) + (query.Features?.length || 0) + Number(Boolean(query.Availability));
}

/** Server filter flags; watch state and Favorites combine instead of excluding each other. */
export function libraryFilters(query: LibraryQuery): string | undefined {
    const filters = [
        query.WatchStatus === 'unplayed' ? 'IsUnplayed' : query.WatchStatus === 'played' ? 'IsPlayed' : query.WatchStatus === 'resumable' ? 'IsResumable' : '',
        query.Favorite || query.WatchStatus === 'favorite' ? 'IsFavorite' : ''
    ].filter(Boolean);
    return filters.length ? filters.join(',') : undefined;
}

export function mapLibraryQuery(query: LibraryQuery, options: LibraryItemsOptions = {}): Record<string, string | number | undefined> {
    const features = query.Features || [];
    const params: Record<string, string | number | undefined> = {
        StartIndex: options.StartIndex ?? 0,
        Limit: options.Limit ?? 80,
        SortBy: query.SortBy,
        SortOrder: query.SortOrder,
        Genres: query.Genre || undefined,
        SearchTerm: query.Title.trim() || undefined,
        IncludeItemTypes: options.IncludeItemTypes?.join(','),
        Recursive: options.Recursive === undefined ? 'true' : String(options.Recursive),
        Is4K: query.Resolution === '4k' ? 'true' : query.Resolution === '1080p' ? 'false' : undefined,
        MinWidth: query.Resolution === '1080p' ? 1400 : undefined,
        MaxWidth: query.Resolution === '1080p' ? 2200 : undefined,
        Filters: libraryFilters(query),
        Tags: query.Tags || undefined,
        OfficialRatings: query.Ratings || undefined,
        SeriesStatus: query.SeriesStatus || undefined,
        HasSubtitles: features.includes('subtitles') ? 'true' : undefined,
        HasTrailer: features.includes('trailer') ? 'true' : undefined,
        HasSpecialFeature: features.includes('special') ? 'true' : undefined,
        IsMissing: query.Availability === 'missing' ? 'true' : undefined,
        IsUnaired: query.Availability === 'unaired' ? 'true' : undefined,
        Years: options.Years?.join(','),
        Fields: options.Fields ?? `SortName,Overview,PrimaryImageAspectRatio,UserData,ProductionYear,RunTimeTicks,CommunityRating,PremiereDate,Width,Height,MediaStreams,CanDelete,SeriesName,IndexNumber,ParentIndexNumber${options.IncludePeople ? ',People' : ''}`
    };
    return params;
}
