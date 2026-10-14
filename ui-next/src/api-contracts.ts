import type { ItemResponse, MediaItem } from './types';

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
    if (!isMediaItem(raw)) throw new Error('The server returned an item in an unexpected format.');
    return raw;
}
