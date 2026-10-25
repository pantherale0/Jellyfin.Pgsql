import { JellyfinRequestError, RequestTimeoutError } from './api';
import type { JellyfinUser, MediaItem } from './types';
import { t } from './i18n';

const MAX_LIST = 200;
const MAX_TEXT = 300;
const MAX_LONG_TEXT = 20000;
const MAX_URL = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
    if (typeof value !== 'string') return undefined;
    const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    return clean ? clean.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function httpsUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > MAX_URL) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
    } catch {
        return undefined;
    }
}

function list<T>(raw: unknown, max: number, map: (entry: unknown) => T | null): T[] {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, max * 2).map(map).filter((entry): entry is T => entry !== null).slice(0, max);
}

function providerIds(raw: unknown): Record<string, string> {
    const ids: Record<string, string> = {};
    if (!isRecord(raw)) return ids;
    Object.keys(raw).slice(0, 40).forEach(key => {
        const value = text(raw[key], 200);
        if (value && /^[A-Za-z0-9._-]{1,60}$/.test(key)) ids[key] = value;
    });
    return ids;
}

/* ---------- Server responses ---------- */

export interface NameValue { Name: string; Value: string }
export interface Country { Name: string; TwoLetterISORegionName: string }
export interface Culture { DisplayName: string; ThreeLetterISOLanguageName: string; TwoLetterISOLanguageName?: string }
export interface ExternalIdInfo { Name: string; Key: string; Type?: string; UrlFormatString?: string }

export interface MetadataEditorInfo {
    ParentalRatingOptions: NameValue[];
    Countries: Country[];
    Cultures: Culture[];
    ExternalIdInfos: ExternalIdInfo[];
    ContentType?: string;
    ContentTypeOptions: NameValue[];
}

export function asEditorInfo(raw: unknown): MetadataEditorInfo {
    if (!isRecord(raw)) throw new Error(t('The metadata editor returned an unexpected response.'));
    return {
        ParentalRatingOptions: list(raw.ParentalRatingOptions, 500, entry => {
            const name = isRecord(entry) ? text(entry.Name, 80) : undefined;
            return name ? { Name: name, Value: isRecord(entry) && entry.Value != null ? String(entry.Value).slice(0, 20) : '' } : null;
        }),
        Countries: list(raw.Countries, 400, entry => {
            if (!isRecord(entry)) return null;
            const code = text(entry.TwoLetterISORegionName, 3);
            return code ? { Name: text(entry.DisplayName, 100) || text(entry.Name, 100) || code, TwoLetterISORegionName: code } : null;
        }),
        Cultures: list(raw.Cultures, 600, asCulture),
        ExternalIdInfos: list(raw.ExternalIdInfos, 60, entry => {
            if (!isRecord(entry)) return null;
            const key = text(entry.Key, 60);
            const name = text(entry.Name, 100);
            if (!key || !name || !/^[A-Za-z0-9._-]+$/.test(key)) return null;
            const info: ExternalIdInfo = { Name: name, Key: key };
            const type = text(entry.Type, 40);
            if (type) info.Type = type;
            const format = text(entry.UrlFormatString, 500);
            if (format && /^https:\/\/[^\s]+\{0\}/.test(format)) info.UrlFormatString = format;
            return info;
        }),
        ContentType: text(raw.ContentType, 40),
        ContentTypeOptions: list(raw.ContentTypeOptions, 40, entry => {
            const name = isRecord(entry) ? text(entry.Name, 80) : undefined;
            return name && isRecord(entry) ? { Name: name, Value: typeof entry.Value === 'string' ? entry.Value.slice(0, 40) : '' } : null;
        }),
    };
}

export function asCulture(entry: unknown): Culture | null {
    if (!isRecord(entry)) return null;
    const three = text(entry.ThreeLetterISOLanguageName, 3);
    if (!three) return null;
    const culture: Culture = { DisplayName: text(entry.DisplayName, 100) || text(entry.Name, 100) || three, ThreeLetterISOLanguageName: three };
    const two = text(entry.TwoLetterISOLanguageName, 2);
    if (two) culture.TwoLetterISOLanguageName = two;
    return culture;
}

export interface ImageInfo { ImageType: string; ImageIndex: number; ImageTag?: string; Width?: number; Height?: number; Size?: number }

export function asImageInfos(raw: unknown): ImageInfo[] {
    if (!Array.isArray(raw)) throw new Error(t('The image list returned an unexpected response.'));
    return list(raw, 200, entry => {
        if (!isRecord(entry)) return null;
        const type = text(entry.ImageType, 30);
        if (!type || !/^[A-Za-z]+$/.test(type)) return null;
        const info: ImageInfo = { ImageType: type, ImageIndex: Number.isInteger(entry.ImageIndex) ? entry.ImageIndex as number : 0 };
        const tag = text(entry.ImageTag, 100);
        if (tag) info.ImageTag = tag;
        if (num(entry.Width)) info.Width = num(entry.Width);
        if (num(entry.Height)) info.Height = num(entry.Height);
        if (num(entry.Size)) info.Size = num(entry.Size);
        return info;
    });
}

export interface RemoteImage { ProviderName: string; Url: string; ThumbnailUrl?: string; Width?: number; Height?: number; CommunityRating?: number; VoteCount?: number; Language?: string; Type?: string }
export interface RemoteImageResult { Images: RemoteImage[]; TotalRecordCount: number; Providers: string[] }

export function asRemoteImages(raw: unknown): RemoteImageResult {
    if (!isRecord(raw)) throw new Error(t('Online images returned an unexpected response.'));
    const images = list(raw.Images, 300, entry => {
        if (!isRecord(entry)) return null;
        const url = httpsUrl(entry.Url);
        if (!url) return null;
        const image: RemoteImage = { ProviderName: text(entry.ProviderName, 80) || 'Unknown', Url: url };
        const thumb = httpsUrl(entry.ThumbnailUrl);
        if (thumb) image.ThumbnailUrl = thumb;
        if (num(entry.Width)) image.Width = num(entry.Width);
        if (num(entry.Height)) image.Height = num(entry.Height);
        if (num(entry.CommunityRating) !== undefined) image.CommunityRating = num(entry.CommunityRating);
        if (num(entry.VoteCount) !== undefined) image.VoteCount = num(entry.VoteCount);
        const language = text(entry.Language, 10);
        if (language) image.Language = language;
        const type = text(entry.Type, 30);
        if (type) image.Type = type;
        return image;
    });
    const total = num(raw.TotalRecordCount);
    return {
        Images: images,
        TotalRecordCount: total !== undefined && total >= 0 ? Math.floor(total) : images.length,
        Providers: list(raw.Providers, 40, entry => text(entry, 80) || null),
    };
}

export interface RemoteSearchResult { Name: string; ProductionYear?: number; PremiereDate?: string; ImageUrl?: string; SearchProviderName?: string; Overview?: string; ProviderIds: Record<string, string>; IndexNumber?: number; ParentIndexNumber?: number }

export function asRemoteSearchResults(raw: unknown): RemoteSearchResult[] {
    if (!Array.isArray(raw)) throw new Error(t('The identify search returned an unexpected response.'));
    return list(raw, 100, entry => {
        if (!isRecord(entry)) return null;
        const name = text(entry.Name, MAX_TEXT);
        if (!name) return null;
        const result: RemoteSearchResult = { Name: name, ProviderIds: providerIds(entry.ProviderIds) };
        const year = num(entry.ProductionYear);
        if (year && Number.isInteger(year) && year > 1800 && year < 3000) result.ProductionYear = year;
        const premiere = text(entry.PremiereDate, 40);
        if (premiere && !Number.isNaN(Date.parse(premiere))) result.PremiereDate = premiere;
        const image = httpsUrl(entry.ImageUrl);
        if (image) result.ImageUrl = image;
        const provider = text(entry.SearchProviderName, 80);
        if (provider) result.SearchProviderName = provider;
        const overview = text(entry.Overview, 2000);
        if (overview) result.Overview = overview;
        if (Number.isInteger(entry.IndexNumber)) result.IndexNumber = entry.IndexNumber as number;
        if (Number.isInteger(entry.ParentIndexNumber)) result.ParentIndexNumber = entry.ParentIndexNumber as number;
        return result;
    });
}

export interface RemoteSubtitle {
    Id: string; ProviderName: string; Name: string; Format?: string; Author?: string; Comment?: string; DateCreated?: string;
    CommunityRating?: number; DownloadCount?: number; IsHashMatch?: boolean; ThreeLetterISOLanguageName?: string; Forced?: boolean; HearingImpaired?: boolean;
}

export function asRemoteSubtitles(raw: unknown): RemoteSubtitle[] {
    if (!Array.isArray(raw)) throw new Error(t('The subtitle search returned an unexpected response.'));
    return list(raw, 200, entry => {
        if (!isRecord(entry)) return null;
        const id = text(entry.Id, 500);
        if (!id) return null;
        const subtitle: RemoteSubtitle = { Id: id, ProviderName: text(entry.ProviderName, 80) || 'Unknown', Name: text(entry.Name, MAX_TEXT) || id };
        const format = text(entry.Format, 20);
        if (format) subtitle.Format = format;
        const author = text(entry.Author, 100);
        if (author) subtitle.Author = author;
        const comment = text(entry.Comment, 500);
        if (comment) subtitle.Comment = comment;
        const created = text(entry.DateCreated, 40);
        if (created && !Number.isNaN(Date.parse(created))) subtitle.DateCreated = created;
        if (num(entry.CommunityRating) !== undefined) subtitle.CommunityRating = num(entry.CommunityRating);
        if (num(entry.DownloadCount) !== undefined) subtitle.DownloadCount = num(entry.DownloadCount);
        const language = text(entry.ThreeLetterISOLanguageName, 3);
        if (language) subtitle.ThreeLetterISOLanguageName = language;
        if (entry.IsHashMatch === true) subtitle.IsHashMatch = true;
        if (entry.Forced === true) subtitle.Forced = true;
        if (entry.HearingImpaired === true) subtitle.HearingImpaired = true;
        return subtitle;
    });
}

export interface LyricLine { Text: string; Start?: number }
export interface RemoteLyric { Id: string; ProviderName: string; Title?: string; Artist?: string; Album?: string; Lines: LyricLine[] }

export function asLyricLines(raw: unknown): LyricLine[] {
    return list(raw, 2000, entry => {
        if (!isRecord(entry) || typeof entry.Text !== 'string') return null;
        const line: LyricLine = { Text: entry.Text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) };
        const start = num(entry.Start);
        if (start !== undefined && start >= 0) line.Start = start;
        return line;
    });
}

export function asRemoteLyrics(raw: unknown): RemoteLyric[] {
    if (!Array.isArray(raw)) throw new Error(t('The lyric search returned an unexpected response.'));
    return list(raw, 50, entry => {
        if (!isRecord(entry)) return null;
        const id = text(entry.Id, 500);
        if (!id) return null;
        const lyrics = isRecord(entry.Lyrics) ? entry.Lyrics : {};
        const metadata = isRecord(lyrics.Metadata) ? lyrics.Metadata : {};
        return {
            Id: id,
            ProviderName: text(entry.ProviderName, 80) || 'Unknown',
            Title: text(metadata.Title),
            Artist: text(metadata.Artist),
            Album: text(metadata.Album),
            Lines: asLyricLines(lyrics.Lyrics),
        };
    });
}

/* ---------- Editor fields ---------- */

export type MetadataFieldKey =
    'Name' | 'OriginalTitle' | 'ForcedSortName' | 'Overview' | 'CommunityRating' | 'CriticRating' | 'OfficialRating' | 'CustomRating' |
    'PremiereDate' | 'EndDate' | 'DateCreated' | 'ProductionYear' | 'Genres' | 'Tags' | 'Studios' | 'People' | 'ProviderIds' |
    'PreferredMetadataLanguage' | 'PreferredMetadataCountryCode' | 'LockData' | 'LockedFields' | 'IndexNumber' | 'ParentIndexNumber' |
    'AirsBeforeSeasonNumber' | 'AirsAfterSeasonNumber' | 'AirsBeforeEpisodeNumber' | 'Status' | 'AirDays' | 'AirTime' | 'DisplayOrder' |
    'Album' | 'AlbumArtists' | 'Artists' | 'Video3DFormat' | 'AspectRatio';

const VIDEO_TYPES = [ 'Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer' ];
const PEOPLE_TYPES = [ 'Movie', 'Series', 'Episode', 'Video', 'Trailer', 'MusicVideo' ];

export const LOCKABLE_FIELDS: Array<[string, string]> = [
    [ 'Name', 'Name' ], [ 'Overview', 'Overview' ], [ 'Genres', 'Genres' ], [ 'Tags', 'Tags' ], [ 'Studios', 'Studios' ],
    [ 'Cast', 'Cast & crew' ], [ 'OfficialRating', 'Parental rating' ], [ 'ProductionLocations', 'Production locations' ], [ 'Runtime', 'Runtime' ],
];
export const SERIES_STATUSES = [ 'Continuing', 'Ended', 'Unreleased' ];
export const WEEK_DAYS = [ 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday' ];
export const PERSON_TYPES = [ 'Actor', 'Director', 'Writer', 'Producer', 'GuestStar', 'Composer', 'Conductor', 'Lyricist', 'Arranger', 'Engineer', 'Mixer', 'Remixer', 'Creator', 'Artist', 'AlbumArtist', 'Author', 'Illustrator', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor', 'Translator' ];
export const DISPLAY_ORDERS: Record<string, Array<[string, string]>> = {
    Series: [ [ '', 'Aired' ], [ 'absolute', 'Absolute' ], [ 'dvd', 'DVD' ], [ 'originalAirDate', 'Original air date' ], [ 'production', 'Production' ], [ 'altdvd', 'Alternate DVD' ], [ 'alternate', 'Alternate' ], [ 'regional', 'Regional' ], [ 'storyArc', 'Story arc' ], [ 'tv', 'TV' ] ],
    BoxSet: [ [ 'PremiereDate', 'Release date' ], [ 'SortName', 'Sort name' ] ],
};
export const VIDEO_3D_FORMATS: Array<[string, string]> = [ [ '', 'None' ], [ 'HalfSideBySide', 'Half side by side' ], [ 'FullSideBySide', 'Full side by side' ], [ 'FullTopAndBottom', 'Full top and bottom' ], [ 'HalfTopAndBottom', 'Half top and bottom' ], [ 'MVC', 'MVC' ] ];

export function editorFields(item: Pick<MediaItem, 'Type'>): Set<MetadataFieldKey> {
    const type = item.Type || '';
    const fields = new Set<MetadataFieldKey>([ 'Name', 'OriginalTitle', 'ForcedSortName', 'Overview', 'PremiereDate', 'DateCreated', 'ProductionYear', 'ProviderIds', 'PreferredMetadataLanguage', 'PreferredMetadataCountryCode', 'LockData', 'LockedFields' ]);
    if (type !== 'Person') [ 'CommunityRating', 'OfficialRating', 'CustomRating', 'Genres', 'Tags', 'Studios' ].forEach(key => fields.add(key as MetadataFieldKey));
    if ([ 'Movie', 'Series', 'Trailer', 'MusicVideo' ].includes(type)) fields.add('CriticRating');
    if (type === 'Series' || type === 'Person') fields.add('EndDate');
    if (PEOPLE_TYPES.includes(type)) fields.add('People');
    if ([ 'Episode', 'Season', 'Audio', 'Book' ].includes(type)) fields.add('IndexNumber');
    if ([ 'Episode', 'Audio' ].includes(type)) fields.add('ParentIndexNumber');
    if (type === 'Episode') [ 'AirsBeforeSeasonNumber', 'AirsAfterSeasonNumber', 'AirsBeforeEpisodeNumber' ].forEach(key => fields.add(key as MetadataFieldKey));
    if (type === 'Series') [ 'Status', 'AirDays', 'AirTime' ].forEach(key => fields.add(key as MetadataFieldKey));
    if (DISPLAY_ORDERS[type]) fields.add('DisplayOrder');
    if ([ 'Audio', 'MusicVideo' ].includes(type)) [ 'Album', 'Artists' ].forEach(key => fields.add(key as MetadataFieldKey));
    if ([ 'Audio', 'MusicAlbum' ].includes(type)) [ 'AlbumArtists', 'Artists' ].forEach(key => fields.add(key as MetadataFieldKey));
    if (VIDEO_TYPES.includes(type)) [ 'Video3DFormat', 'AspectRatio' ].forEach(key => fields.add(key as MetadataFieldKey));
    return fields;
}

export interface PersonDraft { Name: string; Type: string; Role: string; Id?: string }

export interface MetadataDraft {
    Name: string; OriginalTitle: string; ForcedSortName: string; Overview: string;
    CommunityRating: string; CriticRating: string; OfficialRating: string; CustomRating: string;
    PremiereDate: string; EndDate: string; DateCreated: string; ProductionYear: string;
    Genres: string[]; Tags: string[]; Studios: string[]; People: PersonDraft[]; ProviderIds: Record<string, string>;
    PreferredMetadataLanguage: string; PreferredMetadataCountryCode: string; LockData: boolean; LockedFields: string[];
    IndexNumber: string; ParentIndexNumber: string; AirsBeforeSeasonNumber: string; AirsAfterSeasonNumber: string; AirsBeforeEpisodeNumber: string;
    Status: string; AirDays: string[]; AirTime: string; DisplayOrder: string;
    Album: string; AlbumArtists: string[]; Artists: string[]; Video3DFormat: string; AspectRatio: string;
}

const str = (value: unknown) => typeof value === 'string' ? value : '';
const numStr = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const dateStr = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
const names = (value: unknown) => Array.isArray(value) ? value.map(entry => typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.Name) : '').filter(Boolean) : [];

export function metadataDraft(item: MediaItem): MetadataDraft {
    const raw = item as MediaItem & Record<string, unknown>;
    return {
        Name: str(item.Name), OriginalTitle: str(item.OriginalTitle), ForcedSortName: str(item.ForcedSortName), Overview: str(item.Overview),
        CommunityRating: numStr(item.CommunityRating), CriticRating: numStr(item.CriticRating), OfficialRating: str(item.OfficialRating), CustomRating: str(item.CustomRating),
        PremiereDate: dateStr(item.PremiereDate), EndDate: dateStr(item.EndDate), DateCreated: dateStr(item.DateCreated), ProductionYear: numStr(item.ProductionYear),
        Genres: names(item.Genres), Tags: names(item.Tags), Studios: names(item.Studios),
        People: (item.People || []).map(person => ({ Name: str(person.Name), Type: str(person.Type) || 'Actor', Role: str(person.Role), ...(person.Id ? { Id: person.Id } : {}) })),
        ProviderIds: { ...providerIds(item.ProviderIds) },
        PreferredMetadataLanguage: str(item.PreferredMetadataLanguage), PreferredMetadataCountryCode: str(item.PreferredMetadataCountryCode),
        LockData: item.LockData === true, LockedFields: Array.isArray(item.LockedFields) ? item.LockedFields.filter(field => typeof field === 'string') : [],
        IndexNumber: numStr(item.IndexNumber), ParentIndexNumber: numStr(item.ParentIndexNumber),
        AirsBeforeSeasonNumber: numStr(item.AirsBeforeSeasonNumber), AirsAfterSeasonNumber: numStr(item.AirsAfterSeasonNumber), AirsBeforeEpisodeNumber: numStr(item.AirsBeforeEpisodeNumber),
        Status: str(item.Status), AirDays: Array.isArray(item.AirDays) ? item.AirDays.filter(day => WEEK_DAYS.includes(day)) : [], AirTime: str(item.AirTime), DisplayOrder: str(item.DisplayOrder),
        Album: str(item.Album), AlbumArtists: names(item.AlbumArtists), Artists: names(item.ArtistItems?.length ? item.ArtistItems : raw.Artists),
        Video3DFormat: str(item.Video3DFormat), AspectRatio: str(item.AspectRatio),
    };
}

export function cleanList(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    values.forEach(value => {
        const trimmed = value.trim().slice(0, MAX_TEXT);
        const key = trimmed.toLowerCase();
        if (trimmed && !seen.has(key)) { seen.add(key); out.push(trimmed); }
    });
    return out.slice(0, MAX_LIST);
}

function badNumber(value: string, min: number, max: number, integer = false): boolean {
    if (!value.trim()) return false;
    const parsed = Number(value);
    return !Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed));
}

function badDate(value: string): boolean {
    return Boolean(value) && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
}

/** Returns the first problem, or an empty string when the draft can be saved. */
export function validateDraft(draft: MetadataDraft): string {
    if (!draft.Name.trim()) return t('Enter a name.');
    if (badNumber(draft.CommunityRating, 0, 10)) return t('Community rating must be between 0 and 10.');
    if (badNumber(draft.CriticRating, 0, 100)) return t('Critic rating must be between 0 and 100.');
    if (badNumber(draft.ProductionYear, 1800, 2999, true)) return t('Year must be a whole number between 1800 and 2999.');
    for (const key of [ 'IndexNumber', 'ParentIndexNumber', 'AirsBeforeSeasonNumber', 'AirsAfterSeasonNumber', 'AirsBeforeEpisodeNumber' ] as const) {
        if (badNumber(draft[key], 0, 100000, true)) return t('Numbers must be whole numbers of 0 or more.');
    }
    if ([ draft.PremiereDate, draft.EndDate, draft.DateCreated ].some(badDate)) return t('Dates must be valid (YYYY-MM-DD).');
    if (draft.AirTime && !/^\d{1,2}:\d{2}( ?[AaPp][Mm])?$/.test(draft.AirTime.trim())) return t('Air time must look like 20:00 or 8:00 PM.');
    if (draft.People.some(person => !person.Name.trim())) return t('Every person needs a name.');
    if (draft.People.length > 500) return t('Too many people.');
    if ([ draft.Genres, draft.Tags, draft.Studios, draft.AlbumArtists, draft.Artists ].some(values => values.length > MAX_LIST)) return `Lists can hold at most ${MAX_LIST} entries.`;
    if (draft.Overview.length > MAX_LONG_TEXT) return t('The overview is too long.');
    return '';
}

/** Only the fields the user edited, so a save never overwrites concurrent server changes to other fields. */
export function changedMetadata(original: MetadataDraft, draft: MetadataDraft): Partial<MetadataDraft> {
    const changes: Partial<MetadataDraft> = {};
    (Object.keys(draft) as Array<keyof MetadataDraft>).forEach(key => {
        if (JSON.stringify(original[key]) !== JSON.stringify(draft[key])) (changes as Record<string, unknown>)[key] = draft[key];
    });
    return changes;
}

const toNumber = (value: string) => value.trim() ? Number(value) : null;
const toDate = (value: string) => value ? `${value}T00:00:00.0000000Z` : null;

/** Converts edited draft fields into `BaseItemDto` properties. */
export function itemFields(changes: Partial<MetadataDraft>, fresh: MediaItem): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    (Object.keys(changes) as Array<keyof MetadataDraft>).forEach(key => {
        const value = changes[key];
        switch (key) {
            case 'Name': case 'OriginalTitle': case 'ForcedSortName': case 'Overview': case 'OfficialRating': case 'CustomRating':
            case 'PreferredMetadataLanguage': case 'PreferredMetadataCountryCode': case 'Status': case 'AirTime': case 'DisplayOrder': case 'Album':
            case 'Video3DFormat': case 'AspectRatio':
                out[key] = String(value).trim() || null; break;
            case 'CommunityRating': case 'CriticRating': case 'ProductionYear': case 'IndexNumber': case 'ParentIndexNumber':
            case 'AirsBeforeSeasonNumber': case 'AirsAfterSeasonNumber': case 'AirsBeforeEpisodeNumber':
                out[key] = toNumber(String(value)); break;
            case 'PremiereDate': case 'EndDate': case 'DateCreated':
                out[key] = toDate(String(value)); break;
            case 'Genres': case 'Tags':
                out[key] = cleanList(value as string[]); break;
            case 'Studios':
                out.Studios = cleanList(value as string[]).map(name => ({ Name: name })); break;
            case 'AlbumArtists':
                out.AlbumArtists = cleanList(value as string[]).map(name => ({ Name: name })); break;
            case 'Artists':
                out.ArtistItems = cleanList(value as string[]).map(name => ({ Name: name }));
                out.Artists = cleanList(value as string[]); break;
            case 'AirDays':
                out.AirDays = (value as string[]).filter(day => WEEK_DAYS.includes(day)); break;
            case 'People': {
                const existing = fresh.People || [];
                out.People = (value as PersonDraft[]).map(person => {
                    const known = person.Id ? existing.find(entry => entry.Id === person.Id) : undefined;
                    return { ...(known || {}), Name: person.Name.trim(), Type: person.Type || 'Actor', Role: person.Role.trim() || null };
                });
                break;
            }
            case 'ProviderIds': {
                const ids: Record<string, string> = {};
                Object.entries(value as Record<string, string>).forEach(([ provider, id ]) => { if (id.trim()) ids[provider] = id.trim(); });
                out.ProviderIds = ids;
                break;
            }
            case 'LockData':
                out.LockData = Boolean(value); break;
            case 'LockedFields':
                out.LockedFields = (value as string[]).filter(field => LOCKABLE_FIELDS.some(([ id ]) => id === field)); break;
        }
    });
    return out;
}

export function buildItemUpdate(fresh: MediaItem, changes: Partial<MetadataDraft>): MediaItem {
    return { ...fresh, ...itemFields(changes, fresh) } as MediaItem;
}

/* ---------- Refresh, identify, images ---------- */

export type RefreshMode = 'scan' | 'missing' | 'all';

export function refreshOptions(mode: RefreshMode, replaceImages: boolean, regenerateTrickplay: boolean): Record<string, string> {
    const full = mode !== 'scan';
    return {
        metadataRefreshMode: full ? 'FullRefresh' : 'Default',
        imageRefreshMode: full ? 'FullRefresh' : 'Default',
        replaceAllMetadata: String(mode === 'all'),
        replaceAllImages: String(full && replaceImages),
        regenerateTrickplay: String(regenerateTrickplay),
    };
}

const IDENTIFY_TYPES = [ 'Movie', 'Series', 'BoxSet', 'MusicAlbum', 'MusicArtist', 'MusicVideo', 'Trailer', 'Book', 'Person' ];

export function identifyType(item: Pick<MediaItem, 'Type'>): string | null {
    return IDENTIFY_TYPES.includes(item.Type || '') ? item.Type! : null;
}

export function identifyQuery(item: Pick<MediaItem, 'Id'>, form: { name: string; year: string; providerIds: Record<string, string> }) {
    const ids: Record<string, string> = {};
    Object.entries(form.providerIds).forEach(([ key, value ]) => { if (value.trim()) ids[key] = value.trim(); });
    const year = Number(form.year);
    return {
        SearchInfo: { Name: form.name.trim(), ...(form.year.trim() && Number.isInteger(year) ? { Year: year } : {}), ProviderIds: ids },
        ItemId: item.Id,
        IncludeDisabledProviders: true,
    };
}

export function imageTypesFor(item: Pick<MediaItem, 'Type'>): string[] {
    const type = item.Type || '';
    if (type === 'Person') return [ 'Primary' ];
    if ([ 'Audio', 'MusicAlbum' ].includes(type)) return [ 'Primary', 'Backdrop', 'Disc' ];
    if (type === 'MusicArtist') return [ 'Primary', 'Backdrop', 'Logo', 'Banner', 'Thumb' ];
    if (type === 'Episode') return [ 'Primary', 'Thumb', 'Backdrop' ];
    if (type === 'Season') return [ 'Primary', 'Thumb', 'Banner', 'Backdrop' ];
    return [ 'Primary', 'Backdrop', 'Logo', 'Thumb', 'Banner', 'Art', 'Disc', 'Box' ];
}

/* ---------- Files ---------- */

export interface PickedFile { name: string; size: number; type: string }

const IMAGE_MIME = [ 'image/jpeg', 'image/png', 'image/webp', 'image/gif' ];

export function validateImageFile(file: PickedFile): string {
    if (!IMAGE_MIME.includes(file.type)) return t('Choose a JPEG, PNG, WebP or GIF image.');
    if (file.size <= 0) return t('The image is empty.');
    if (file.size > 15 * 1024 * 1024) return t('Images can be at most 15 MB.');
    return '';
}

export function fileExtension(name: string): string {
    const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
    return match ? match[1].toLowerCase() : '';
}

export function validateSubtitleFile(file: PickedFile): string {
    if (![ 'srt', 'ass', 'ssa', 'vtt', 'sub' ].includes(fileExtension(file.name))) return t('Choose an SRT, ASS, SSA, VTT or SUB subtitle file.');
    if (file.size <= 0) return t('The subtitle file is empty.');
    if (file.size > 2 * 1024 * 1024) return t('Subtitle files can be at most 2 MB.');
    return '';
}

export function validateLyricFile(file: PickedFile): string {
    if (![ 'lrc', 'txt' ].includes(fileExtension(file.name))) return t('Choose an LRC or TXT lyrics file.');
    if (file.size <= 0) return t('The lyrics file is empty.');
    if (file.size > 512 * 1024) return t('Lyrics files can be at most 512 KB.');
    return '';
}

/* ---------- Permissions and errors ---------- */

export interface MetadataActionSet { edit: boolean; images: boolean; identify: boolean; refresh: boolean; subtitles: boolean; lyrics: boolean; any: boolean }

const SUBTITLE_TYPES = [ 'Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer' ];

export function metadataActions(item: Pick<MediaItem, 'Id' | 'Type'>, user: Pick<JellyfinUser, 'Policy'> | null | undefined, layout: string): MetadataActionSet {
    const none = { edit: false, images: false, identify: false, refresh: false, subtitles: false, lyrics: false, any: false };
    if (layout === 'tv' || !item.Id || item.Id.startsWith('tag:') || [ 'TvChannel', 'Program', 'UserView', 'CollectionFolder' ].includes(item.Type || '')) return none;
    const admin = user?.Policy?.IsAdministrator === true;
    const set = {
        edit: admin,
        images: admin,
        identify: admin && identifyType(item) !== null,
        refresh: admin,
        subtitles: user?.Policy?.EnableSubtitleManagement === true && SUBTITLE_TYPES.includes(item.Type || ''),
        lyrics: user?.Policy?.EnableLyricManagement === true && item.Type === 'Audio',
    };
    return { ...set, any: Object.values(set).some(Boolean) };
}

export function metadataErrorMessage(error: unknown, action = t('The change')): string {
    if (error instanceof RequestTimeoutError) return t('The server is taking a long time. Check again in a moment.');
    if (error instanceof JellyfinRequestError) {
        if (error.status === 400) return t('{0} was rejected by the server. Check the values and try again.', action);
        if (error.status === 401 || error.status === 403) return t('Your account is not allowed to do this.');
        if (error.status === 404) return t('This item no longer exists on the server.');
    }
    if (error instanceof Error && /^(Choose|Enter|Images|Subtitle|Lyrics|The (image|subtitle|lyrics) file)/.test(error.message)) return error.message;
    return t('{0} could not be completed. Try again.', action);
}
