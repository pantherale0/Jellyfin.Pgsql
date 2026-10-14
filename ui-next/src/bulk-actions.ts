import { canManageCollections } from './detail-model';
import { itemCapabilities } from './catalog-model';
import type { JellyfinUser, MediaItem } from './types';

export type BulkAction = 'played' | 'unplayed' | 'favorite' | 'unfavorite' | 'delete';

/** Selections are capped so one batch cannot fan out into thousands of requests. */
export const MAX_SELECTION = 200;
export const BATCH_CONCURRENCY = 4;

export function toggleSelection(selection: Map<string, MediaItem>, item: MediaItem): Map<string, MediaItem> {
    const next = new Map(selection);
    if (next.has(item.Id)) next.delete(item.Id);
    else if (next.size < MAX_SELECTION) next.set(item.Id, item);
    return next;
}

export function selectAll(selection: Map<string, MediaItem>, items: MediaItem[]): Map<string, MediaItem> {
    const next = new Map(selection);
    for (const item of items) {
        if (next.size >= MAX_SELECTION) break;
        next.set(item.Id, item);
    }
    return next;
}

export interface BulkCapabilities { played: boolean; favorite: boolean; collection: boolean; deletable: number }

/** What the current selection allows; delete applies only to items the server marks deletable. */
export function bulkCapabilities(items: MediaItem[], user: Pick<JellyfinUser, 'Policy'> | undefined): BulkCapabilities {
    const real = items.filter(item => !item.Id.startsWith('tag:'));
    const caps = real.map(item => itemCapabilities(item));
    return {
        played: real.length > 0 && caps.some(cap => cap.canMarkPlayed),
        favorite: real.length > 0 && caps.some(cap => cap.canFavorite),
        collection: real.length > 0 && Boolean(user && canManageCollections(user)) && real.every(item => !itemCapabilities(item).entity && item.Type !== 'BoxSet'),
        deletable: real.filter(item => item.CanDelete === true).length,
    };
}

/** Items a batch action applies to; others are skipped rather than failed. */
export function actionTargets(items: MediaItem[], action: BulkAction): MediaItem[] {
    if (action === 'delete') return items.filter(item => item.CanDelete === true);
    if (action === 'played' || action === 'unplayed') return items.filter(item => itemCapabilities(item).canMarkPlayed);
    return items.filter(item => itemCapabilities(item).canFavorite);
}

export interface BatchResult<T> { succeeded: Array<{ item: MediaItem; value: T }>; failed: MediaItem[] }

/** Runs one request per item with bounded concurrency and reports partial failure instead of stopping. */
export async function runBatch<T>(items: MediaItem[], worker: (item: MediaItem) => Promise<T>, concurrency = BATCH_CONCURRENCY): Promise<BatchResult<T>> {
    const result: BatchResult<T> = { succeeded: [], failed: [] };
    let cursor = 0;
    const lane = async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            try { result.succeeded.push({ item, value: await worker(item) }); } catch { result.failed.push(item); }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
    return result;
}

const ACTION_VERBS: Record<BulkAction, string> = { played: 'Marked played', unplayed: 'Marked unplayed', favorite: 'Added to favorites', unfavorite: 'Removed from favorites', delete: 'Deleted' };

export function batchMessage(action: BulkAction, succeeded: number, failed: number, skipped = 0): { text: string; error: boolean } {
    const noun = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;
    const parts = [ succeeded ? `${ACTION_VERBS[action]}: ${noun(succeeded)}.` : '' ];
    if (failed) parts.push(`${noun(failed)} failed.`);
    if (skipped) parts.push(`${noun(skipped)} skipped (not allowed).`);
    return { text: parts.filter(Boolean).join(' ') || 'Nothing to change.', error: failed > 0 };
}
