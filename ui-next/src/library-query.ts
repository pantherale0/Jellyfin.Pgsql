export type LibrarySort = 'SortName' | 'PremiereDate' | 'DateCreated' | 'CriticRating' | 'Runtime';
export type LibraryResolution = '' | '4k' | '1080p';
export type LibraryWatchStatus = '' | 'unplayed' | 'resumable' | 'favorite';

export interface LibraryQuery {
    Genre: string;
    Decade: string;
    Resolution: LibraryResolution;
    WatchStatus: LibraryWatchStatus;
    SortBy: LibrarySort;
    SortOrder: 'Ascending' | 'Descending';
    Title: string;
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
}

export const defaultLibraryQuery = (): LibraryQuery => ({
    Genre: '', Decade: '', Resolution: '', WatchStatus: '', SortBy: 'SortName', SortOrder: 'Ascending', Title: ''
});

export function mapLibraryQuery(query: LibraryQuery, options: LibraryItemsOptions = {}): Record<string, string | number | undefined> {
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
        Filters: query.WatchStatus === 'unplayed' ? 'IsUnplayed' : query.WatchStatus === 'resumable' ? 'IsResumable' : query.WatchStatus === 'favorite' ? 'IsFavorite' : undefined,
        Years: options.Years?.join(','),
        Fields: options.Fields ?? `SortName,Overview,PrimaryImageAspectRatio,UserData,ProductionYear,RunTimeTicks,CommunityRating,PremiereDate,Width,Height,MediaStreams${options.IncludePeople ? ',People' : ''}`
    };
    return params;
}
