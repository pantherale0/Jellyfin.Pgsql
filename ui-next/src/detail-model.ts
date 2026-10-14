import type { JellyfinUser, MediaItem } from './types';

export interface DetailLink { label: string; url: string }

export interface DetailFacts {
    officialRating?: string;
    criticRating?: number;
    tagline?: string;
    links: DetailLink[];
    video?: string;
    audio: string[];
    subtitles: string[];
    container?: string;
    size?: string;
    bitrate?: string;
}

const streamType = (type: string | number | undefined) => type === 'Video' || type === 1 ? 'video' : type === 'Audio' || type === 0 ? 'audio' : type === 'Subtitle' || type === 2 ? 'subtitle' : 'other';

function resolutionLabel(width?: number, height?: number): string {
    if (!width && !height) return '';
    const w = width || 0, h = height || 0;
    if (w >= 3800 || h >= 2100) return '4K';
    if (w >= 2500 || h >= 1400) return '1440p';
    if (w >= 1900 || h >= 1000) return '1080p';
    if (w >= 1260 || h >= 700) return '720p';
    return h ? `${h}p` : `${w}w`;
}

export function formatSize(bytes?: number): string | undefined {
    if (!bytes || bytes <= 0) return undefined;
    const units = [ 'B', 'KB', 'MB', 'GB', 'TB' ];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Ratings, tagline, external links and technical media information for the details page. */
export function detailFacts(item: MediaItem): DetailFacts {
    const source = item.MediaSources?.[0];
    const streams = source?.MediaStreams || item.MediaStreams || [];
    const video = streams.find(stream => streamType(stream.Type) === 'video');
    const links = (item.ExternalUrls || []).filter(link => link.Name && link.Url && /^https:\/\//i.test(link.Url)).map(link => ({ label: link.Name as string, url: link.Url as string }));
    return {
        officialRating: item.OfficialRating || undefined,
        criticRating: typeof item.CriticRating === 'number' ? Math.round(item.CriticRating) : undefined,
        tagline: item.Taglines?.find(Boolean),
        links,
        video: video ? [ resolutionLabel(video.Width, video.Height), video.Codec?.toUpperCase(), video.VideoRangeType && video.VideoRangeType !== 'SDR' ? video.VideoRangeType : '' ].filter(Boolean).join(' · ') : undefined,
        audio: streams.filter(stream => streamType(stream.Type) === 'audio').map(stream => stream.DisplayTitle || [ stream.Language, stream.Codec?.toUpperCase() ].filter(Boolean).join(' · ')).filter(Boolean).slice(0, 6),
        subtitles: streams.filter(stream => streamType(stream.Type) === 'subtitle').map(stream => stream.DisplayTitle || stream.Language || '').filter(Boolean).slice(0, 8),
        container: source?.Container?.toUpperCase(),
        size: formatSize(source?.Size),
        bitrate: source?.Bitrate ? `${(source.Bitrate / 1_000_000).toFixed(1)} Mbps` : undefined,
    };
}

export interface LinkedMetadata {
    cast: MediaItem[];
    crew: Array<MediaItem & { role: string }>;
    genres: MediaItem[];
    studios: MediaItem[];
    tags: MediaItem[];
    artists: MediaItem[];
    albums: MediaItem[];
}

const CREW_ORDER = [ 'Director', 'Writer', 'Producer', 'Composer', 'Author', 'Creator' ];

export function tagEntity(tag: string): MediaItem {
    return { Id: `tag:${tag}`, Name: tag, Type: 'Tag' };
}

/** People, genres, studios, tags and artists as openable entities (anything without a server id is skipped, except tags). */
export function linkedMetadata(item: MediaItem): LinkedMetadata {
    const people = (item.People || []).filter(person => person.Id && person.Name);
    const cast = people.filter(person => person.Type === 'Actor' || person.Type === 'GuestStar').slice(0, 24)
        .map(person => ({ Id: person.Id as string, Name: person.Name as string, Type: 'Person', Overview: person.Role || undefined, ImageTags: person.PrimaryImageTag ? { Primary: person.PrimaryImageTag } : undefined }));
    const crew = people.filter(person => person.Type && CREW_ORDER.includes(person.Type))
        .sort((left, right) => CREW_ORDER.indexOf(left.Type as string) - CREW_ORDER.indexOf(right.Type as string))
        .slice(0, 12)
        .map(person => ({ Id: person.Id as string, Name: person.Name as string, Type: 'Person', role: person.Type as string }));
    const named = (entries: Array<{ Name?: string; Id?: string }> | undefined, type: string) => (entries || []).filter(entry => entry.Id && entry.Name).map(entry => ({ Id: entry.Id as string, Name: entry.Name as string, Type: type }));
    const genreType = item.Type === 'MusicAlbum' || item.Type === 'Audio' || item.Type === 'MusicArtist' ? 'MusicGenre' : 'Genre';
    return {
        cast,
        crew,
        genres: named(item.GenreItems, genreType),
        studios: named(item.Studios, 'Studio'),
        tags: (item.Tags || []).filter(Boolean).slice(0, 20).map(tagEntity),
        artists: named(item.AlbumArtists?.length ? item.AlbumArtists : item.ArtistItems, 'MusicArtist'),
        albums: item.AlbumId && item.Album && item.Type !== 'MusicAlbum' ? [ { Id: item.AlbumId, Name: item.Album, Type: 'MusicAlbum' } ] : [],
    };
}

export interface DiscGroup { disc: number | null; tracks: MediaItem[] }

/** Album tracks in disc/track order, grouped by disc when the album has more than one. */
export function discGroups(tracks: MediaItem[]): DiscGroup[] {
    const sorted = [ ...tracks ].sort((left, right) => (left.ParentIndexNumber ?? 1) - (right.ParentIndexNumber ?? 1) || (left.IndexNumber ?? 9999) - (right.IndexNumber ?? 9999) || (left.SortName || left.Name).localeCompare(right.SortName || right.Name));
    const groups: DiscGroup[] = [];
    sorted.forEach(track => {
        const disc = track.ParentIndexNumber ?? null;
        const last = groups[groups.length - 1];
        if (last && last.disc === disc) last.tracks.push(track);
        else groups.push({ disc, tracks: [ track ] });
    });
    if (groups.length === 1) groups[0].disc = null;
    return groups;
}

/** Which child view a detail page renders for its item type. */
export function childView(item: Pick<MediaItem, 'Type'>): 'tracks' | 'playlist' | 'photos' | 'members' | null {
    switch (item.Type) {
    case 'MusicAlbum': return 'tracks';
    case 'Playlist': return 'playlist';
    case 'PhotoAlbum': return 'photos';
    case 'BoxSet': return 'members';
    default: return null;
    }
}

export function canManageCollections(user: Pick<JellyfinUser, 'Policy'>): boolean {
    return user.Policy?.IsAdministrator === true || user.Policy?.EnableCollectionManagement === true;
}

export interface ItemActionSet { download: boolean; share: boolean; collection: boolean; remove: boolean }

/** Actions offered for an item, from the server's per-item capability flags and the user's policy. */
export function itemActions(item: Pick<MediaItem, 'Type' | 'CanDelete' | 'CanDownload' | 'Id'>, user: Pick<JellyfinUser, 'Policy'>): ItemActionSet {
    const real = !item.Id.startsWith('tag:');
    return {
        download: real && item.CanDownload === true,
        share: real,
        collection: real && canManageCollections(user) && [ 'Movie', 'Series', 'Episode', 'Video', 'MusicVideo', 'MusicAlbum', 'Audio', 'Book', 'Photo', 'Trailer' ].includes(item.Type || ''),
        remove: real && item.CanDelete === true,
    };
}

/** A link other signed-in users of this server can open in Jellyfin Web; no credentials are included. */
export function shareLink(server: string, item: Pick<MediaItem, 'Id'>, serverId: string): string {
    const params = new URLSearchParams({ id: item.Id });
    if (serverId) params.set('serverId', serverId);
    return `${server.replace(/\/+$/, '')}/web/#/details?${params}`;
}

export function wrapIndex(index: number, count: number, direction: 1 | -1): number {
    if (count <= 0) return 0;
    return (index + direction + count) % count;
}

export function withoutItem<T extends Pick<MediaItem, 'Id'>>(items: T[], id: string): T[] {
    return items.filter(item => item.Id !== id);
}

/** Extras grouped for display; trailers first, then special features, then additional parts. */
export function extrasSections(trailers: MediaItem[], features: MediaItem[], parts: MediaItem[]): Array<{ title: string; items: MediaItem[] }> {
    const label = (type?: string) => ({ BehindTheScenes: 'Behind the scenes', DeletedScene: 'Deleted scenes', Interview: 'Interviews', Featurette: 'Featurettes', Short: 'Shorts', Clip: 'Clips', Scene: 'Scenes', Sample: 'Samples', ThemeSong: 'Theme songs', ThemeVideo: 'Theme videos' } as Record<string, string>)[type || ''] || 'Extras';
    const sections: Array<{ title: string; items: MediaItem[] }> = [];
    if (trailers.length) sections.push({ title: 'Trailers', items: trailers });
    const grouped = new Map<string, MediaItem[]>();
    features.forEach(feature => {
        const title = label(feature.ExtraType);
        grouped.set(title, [ ...(grouped.get(title) || []), feature ]);
    });
    grouped.forEach((items, title) => sections.push({ title, items }));
    if (parts.length) sections.push({ title: 'Additional parts', items: parts });
    return sections;
}
