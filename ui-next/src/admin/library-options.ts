export type LibraryOptions = Record<string, any> & {
    PathInfos?: Array<{ Path?: string; NetworkPath?: string }>;
    TypeOptions?: Array<Record<string, any> & { Type?: string }>;
};

export interface LibraryOptionInfo { Name?: string; DefaultEnabled?: boolean }

export interface AvailableTypeOptions {
    Type?: string;
    MetadataFetchers?: LibraryOptionInfo[];
    ImageFetchers?: LibraryOptionInfo[];
}

export interface AvailableLibraryOptions {
    MetadataSavers?: LibraryOptionInfo[];
    MetadataReaders?: LibraryOptionInfo[];
    SubtitleFetchers?: LibraryOptionInfo[];
    LyricFetchers?: LibraryOptionInfo[];
    MediaSegmentProviders?: LibraryOptionInfo[];
    TypeOptions?: AvailableTypeOptions[];
}

export interface PluginEntry { name: string; enabled: boolean }

export type TypeFetcherKind = 'Metadata' | 'Image';

export type DisabledListKind = 'Subtitle' | 'Lyric' | 'MediaSegment';

const DISABLED_LIST_KEYS: Record<DisabledListKind, { disabled: string; order: string }> = {
    Subtitle: { disabled: 'DisabledSubtitleFetchers', order: 'SubtitleFetcherOrder' },
    Lyric: { disabled: 'DisabledLyricFetchers', order: 'LyricFetcherOrder' },
    MediaSegment: { disabled: 'DisabledMediaSegmentProviders', order: 'MediaSegmentProviderOrder' },
};

const CHAPTER_CONTENT_TYPES = ['homevideos', 'movies', 'musicvideos', 'tvshows'];

export function cloneLibraryOptions(options: LibraryOptions | null | undefined): LibraryOptions {
    return options ? JSON.parse(JSON.stringify(options)) as LibraryOptions : {};
}

function pluginNames(plugins: LibraryOptionInfo[] | undefined): LibraryOptionInfo[] {
    const seen = new Set<string>();
    return (plugins || []).filter(plugin => {
        const key = plugin.Name?.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Configured names first in their saved order, then newly available plugins in server order. */
export function orderPlugins(plugins: LibraryOptionInfo[] | undefined, configuredOrder: string[] | undefined): LibraryOptionInfo[] {
    const order = configuredOrder || [];
    return pluginNames(plugins)
        .map((plugin, index) => ({ plugin, index, rank: order.indexOf(plugin.Name!) }))
        .sort((a, b) => {
            if (a.rank === -1 && b.rank === -1) return a.index - b.index;
            if (a.rank === -1) return 1;
            if (b.rank === -1) return -1;
            return a.rank - b.rank;
        })
        .map(row => row.plugin);
}

export function getTypeOptions(options: LibraryOptions, type: string): Record<string, any> | undefined {
    return (options.TypeOptions || []).find(row => row.Type === type);
}

export function readTypeFetchers(available: AvailableTypeOptions, options: LibraryOptions, kind: TypeFetcherKind): PluginEntry[] {
    const typeOptions = getTypeOptions(options, available.Type || '') || {};
    const enabled: string[] | undefined = typeOptions[`${kind}Fetchers`];
    return orderPlugins(available[`${kind}Fetchers`], typeOptions[`${kind}FetcherOrder`])
        .map(plugin => ({ name: plugin.Name!, enabled: enabled ? enabled.includes(plugin.Name!) : plugin.DefaultEnabled === true }));
}

export function writeTypeFetchers(options: LibraryOptions, type: string, kind: TypeFetcherKind, entries: PluginEntry[]): LibraryOptions {
    const rows = (options.TypeOptions || []).slice();
    const index = rows.findIndex(row => row.Type === type);
    const next = {
        ...(index >= 0 ? rows[index] : { Type: type }),
        [`${kind}Fetchers`]: entries.filter(entry => entry.enabled).map(entry => entry.name),
        [`${kind}FetcherOrder`]: entries.map(entry => entry.name),
    };
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    return { ...options, TypeOptions: rows };
}

export function readDisabledList(available: LibraryOptionInfo[] | undefined, options: LibraryOptions, kind: DisabledListKind): PluginEntry[] {
    const keys = DISABLED_LIST_KEYS[kind];
    const disabled: string[] | undefined = options[keys.disabled];
    return orderPlugins(available, options[keys.order])
        .map(plugin => ({ name: plugin.Name!, enabled: disabled ? !disabled.includes(plugin.Name!) : plugin.DefaultEnabled === true }));
}

export function writeDisabledList(options: LibraryOptions, kind: DisabledListKind, entries: PluginEntry[]): LibraryOptions {
    const keys = DISABLED_LIST_KEYS[kind];
    return {
        ...options,
        [keys.disabled]: entries.filter(entry => !entry.enabled).map(entry => entry.name),
        [keys.order]: entries.map(entry => entry.name),
    };
}

export function readMetadataSavers(available: LibraryOptionInfo[] | undefined, options: LibraryOptions): PluginEntry[] {
    const savers: string[] | undefined = options.MetadataSavers;
    return pluginNames(available).map(plugin => ({ name: plugin.Name!, enabled: savers ? savers.includes(plugin.Name!) : plugin.DefaultEnabled === true }));
}

export function writeMetadataSavers(options: LibraryOptions, entries: PluginEntry[]): LibraryOptions {
    return { ...options, MetadataSavers: entries.filter(entry => entry.enabled).map(entry => entry.name) };
}

export function readLocalReaders(available: LibraryOptionInfo[] | undefined, options: LibraryOptions): PluginEntry[] {
    const disabled: string[] = options.DisabledLocalMetadataReaders || [];
    return orderPlugins(available, options.LocalMetadataReaderOrder).map(plugin => ({ name: plugin.Name!, enabled: !disabled.includes(plugin.Name!) }));
}

export function writeLocalReaders(options: LibraryOptions, entries: PluginEntry[]): LibraryOptions {
    return {
        ...options,
        LocalMetadataReaderOrder: entries.map(entry => entry.name),
        DisabledLocalMetadataReaders: entries.filter(entry => !entry.enabled).map(entry => entry.name),
    };
}

export function moveEntry<T>(entries: T[], index: number, delta: -1 | 1): T[] {
    const target = index + delta;
    if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) return entries;
    const next = entries.slice();
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

/**
 * Library options are replaced as a whole document by the server, so the draft must start from the
 * complete stored options. Paths are managed through their own endpoints and always come from the
 * latest server copy, otherwise a stale draft would resurrect a removed folder.
 */
export function buildLibraryOptionsPayload(draft: LibraryOptions, latest: LibraryOptions | null | undefined): LibraryOptions {
    return { ...cloneLibraryOptions(draft), PathInfos: cloneLibraryOptions(latest).PathInfos || [] };
}

export function libraryFieldVisibility(collectionType: string | null | undefined) {
    const type = collectionType || '';
    const mixed = !type || type === 'mixed';
    const video = mixed || ['movies', 'tvshows', 'musicvideos', 'homevideos'].includes(type);
    return {
        photos: type === 'homevideos' || type === 'photos',
        chapters: mixed || CHAPTER_CONTENT_TYPES.includes(type),
        seriesGrouping: type === 'tvshows',
        seasonZero: type === 'tvshows',
        embeddedTitles: !['books', 'boxsets', 'playlists', 'music'].includes(type),
        embeddedEpisodeInfos: type === 'tvshows',
        lufs: type === 'music',
        musicTags: type === 'music',
        embeddedSubtitles: mixed || ['movies', 'tvshows', 'musicvideos'].includes(type),
        subtitles: video,
        lyrics: type === 'music' || mixed,
        addToCollection: type === 'movies' || mixed,
    };
}

/** Tracks which library an editor load belongs to so late responses cannot populate another draft. */
export class LibraryLoadTracker {
    private generation = 0;
    private libraryId = '';

    begin(libraryId: string): number {
        this.generation += 1;
        this.libraryId = libraryId;
        return this.generation;
    }

    isCurrent(token: number, libraryId: string): boolean {
        return token === this.generation && libraryId === this.libraryId;
    }

    cancel(): void {
        this.generation += 1;
        this.libraryId = '';
    }
}

export type LibraryDraftStatus = 'loading' | 'ready' | 'error';

export function canSaveLibraryDraft(status: LibraryDraftStatus, draftLibraryId: string | undefined, selectedLibraryId: string | undefined, busy: boolean): boolean {
    return status === 'ready' && !busy && !!draftLibraryId && draftLibraryId === selectedLibraryId;
}
