import type { JellyfinUser, MediaItem } from './types';
import { t } from './i18n';

export interface DetailLink { label: string; url: string }

export interface MediaTag { label: string; title: string }

export interface DetailFacts {
    officialRating?: string;
    criticRating?: number;
    tagline?: string;
    links: DetailLink[];
    tags: MediaTag[];
}

const streamType = (type: string | number | undefined) => type === 'Video' || type === 1 ? 'video' : type === 'Audio' || type === 0 ? 'audio' : type === 'Subtitle' || type === 2 ? 'subtitle' : 'other';

function resolutionTag(width?: number, height?: number): MediaTag | undefined {
    if (!width && !height) return undefined;
    const w = width || 0, h = height || 0;
    if (w >= 3800 || h >= 2100) return { label: '4K', title: '4K UHD' };
    if (w >= 1260 || h >= 700) return { label: 'HD', title: 'High definition' };
    return { label: 'SD', title: 'Standard definition' };
}

/** Compact Netflix-style capability tags (resolution, HDR range, subtitles) for the details page. */
export function mediaTags(item: MediaItem): MediaTag[] {
    const source = item.MediaSources?.[0];
    const streams = source?.MediaStreams || item.MediaStreams || [];
    const video = streams.find(stream => streamType(stream.Type) === 'video');
    const tags: MediaTag[] = [];
    if (video) {
        const resolution = resolutionTag(video.Width, video.Height);
        if (resolution) tags.push(resolution);
        const range = video.VideoRangeType || video.VideoRange;
        if (range && range.toUpperCase() !== 'SDR') tags.push(/DOVI|DOLBY/i.test(range) ? { label: 'Dolby Vision', title: 'Dolby Vision' } : { label: 'HDR', title: 'High dynamic range' });
    }
    if (streams.some(stream => streamType(stream.Type) === 'subtitle')) tags.push({ label: 'CC', title: 'Subtitles available' });
    return tags;
}

/** Ratings, tagline, external links and media capability tags for the details page. */
export function detailFacts(item: MediaItem): DetailFacts {
    const links = (item.ExternalUrls || []).filter(link => link.Name && link.Url && /^https:\/\//i.test(link.Url)).map(link => ({ label: link.Name as string, url: link.Url as string }));
    return {
        officialRating: item.OfficialRating || undefined,
        criticRating: typeof item.CriticRating === 'number' ? Math.round(item.CriticRating) : undefined,
        tagline: item.Taglines?.find(Boolean),
        links,
        tags: mediaTags(item),
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

export interface ItemActionSet { download: boolean; share: boolean; collection: boolean; playlist: boolean; remove: boolean }

/** Types a playlist can hold; folders (series, seasons, albums) add their playable children. */
const PLAYLIST_ITEM_TYPES = [ 'Movie', 'Series', 'Season', 'Episode', 'Video', 'MusicVideo', 'MusicAlbum', 'Audio', 'Trailer', 'AudioBook' ];

/** Any signed-in user can keep their own playlists. */
export function canAddToPlaylist(item: Pick<MediaItem, 'Type' | 'Id'>): boolean {
    return !item.Id.startsWith('tag:') && PLAYLIST_ITEM_TYPES.includes(item.Type || '');
}

/** Actions offered for an item, from the server's per-item capability flags and the user's policy. */
export function itemActions(item: Pick<MediaItem, 'Type' | 'CanDelete' | 'CanDownload' | 'Id'>, user: Pick<JellyfinUser, 'Policy'>): ItemActionSet {
    const real = !item.Id.startsWith('tag:');
    return {
        download: real && item.CanDownload === true,
        share: real,
        collection: real && canManageCollections(user) && [ 'Movie', 'Series', 'Episode', 'Video', 'MusicVideo', 'MusicAlbum', 'Audio', 'Book', 'Photo', 'Trailer' ].includes(item.Type || ''),
        playlist: canAddToPlaylist(item),
        remove: real && item.CanDelete === true,
    };
}

/** A link other signed-in users of this server can open in UI Next; no credentials are included. */
export function shareLink(appUrl: string, item: Pick<MediaItem, 'Id'>): string {
    const url = new URL(appUrl);
    url.search = '';
    url.hash = '';
    url.searchParams.set('item', item.Id);
    return url.toString();
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
    if (trailers.length) sections.push({ title: t('Trailers'), items: trailers });
    const grouped = new Map<string, MediaItem[]>();
    features.forEach(feature => {
        const title = label(feature.ExtraType);
        grouped.set(title, [ ...(grouped.get(title) || []), feature ]);
    });
    grouped.forEach((items, title) => sections.push({ title, items }));
    if (parts.length) sections.push({ title: t('Additional parts'), items: parts });
    return sections;
}
