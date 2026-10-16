import type { FolderStorage, SystemStorage } from './admin/types';
import type { ItemResponse, MediaItem } from './types';
import { t } from './i18n';

/**
 * Boundary contracts for Jellyfin item payloads. Views rely on these guarantees instead of
 * re-checking `Items || []`, so a wrong-shaped or partial body fails here, once.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function isMediaItem(value: unknown): value is MediaItem {
    return isRecord(value) && typeof value.Id === 'string' && value.Id.length > 0;
}

/** Items is always an array of identifiable items; counts are finite non-negative integers or absent. */
export function asItemResponse(raw: unknown): ItemResponse {
    const body = isRecord(raw) ? raw : {};
    const items = Array.isArray(body.Items) ? body.Items.filter(isMediaItem) : [];
    const response: ItemResponse = { Items: items };
    const total = count(body.TotalRecordCount);
    const start = count(body.StartIndex);
    if (total !== undefined) response.TotalRecordCount = Math.max(total, items.length);
    if (start !== undefined) response.StartIndex = start;
    return response;
}

/** A single item must at least carry its Id; anything else is a schema failure, not an empty item. */
export function asMediaItem(raw: unknown): MediaItem {
    if (!isMediaItem(raw)) throw new Error(t('The server returned an item in an unexpected format.'));
    return raw;
}

function text(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export interface Culture { DisplayName: string; TwoLetterISOLanguageName?: string; ThreeLetterISOLanguageName: string }
export interface Country { DisplayName: string; TwoLetterISORegionName: string }

/** Language pickers need a list; anything that is not a usable culture is dropped. */
export function asCultures(raw: unknown): Culture[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecord).filter(culture => text(culture.DisplayName) && text(culture.ThreeLetterISOLanguageName)).map(culture => ({
        DisplayName: culture.DisplayName as string,
        ThreeLetterISOLanguageName: culture.ThreeLetterISOLanguageName as string,
        ...(text(culture.TwoLetterISOLanguageName) ? { TwoLetterISOLanguageName: culture.TwoLetterISOLanguageName } : {})
    }));
}

export function asCountries(raw: unknown): Country[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecord).filter(country => text(country.DisplayName) && text(country.TwoLetterISORegionName))
        .map(country => ({ DisplayName: country.DisplayName as string, TwoLetterISORegionName: country.TwoLetterISORegionName as string }));
}

function asFolderStorage(raw: unknown): FolderStorage | undefined {
    if (!isRecord(raw)) return undefined;
    const used = raw.UsedSpace, free = raw.FreeSpace;
    if (typeof used !== 'number' || typeof free !== 'number' || !Number.isFinite(used) || !Number.isFinite(free) || used < 0 || free < 0) return undefined;
    const folder: FolderStorage = { Path: typeof raw.Path === 'string' ? raw.Path : '', UsedSpace: used, FreeSpace: free };
    if (text(raw.StorageType)) folder.StorageType = raw.StorageType;
    if (text(raw.DeviceId)) folder.DeviceId = raw.DeviceId;
    return folder;
}

const STORAGE_FOLDERS = [ 'ProgramDataFolder', 'WebFolder', 'ImageCacheFolder', 'CacheFolder', 'LogFolder', 'InternalMetadataFolder', 'TranscodingTempFolder' ] as const;

/** Storage folders are individually optional: a missing or malformed mount is omitted, never rendered as undefined. */
export function asSystemStorage(raw: unknown): SystemStorage {
    if (!isRecord(raw)) throw new Error(t('The server returned storage information in an unexpected format.'));
    const storage: SystemStorage = { Libraries: [] };
    STORAGE_FOLDERS.forEach(key => {
        const folder = asFolderStorage(raw[key]);
        if (folder) storage[key] = folder;
    });
    if (Array.isArray(raw.Libraries)) {
        storage.Libraries = raw.Libraries.filter(isRecord).filter(library => typeof library.Id === 'string').map(library => ({
            Id: library.Id as string,
            Name: typeof library.Name === 'string' ? library.Name : '',
            Folders: Array.isArray(library.Folders) ? library.Folders.map(asFolderStorage).filter((folder): folder is FolderStorage => !!folder) : []
        }));
    }
    return storage;
}
