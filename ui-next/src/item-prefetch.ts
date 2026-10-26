import { useEffect, useRef } from 'preact/hooks';
import type { JellyfinApi } from './api';
import type { MediaItem } from './types';

export type ItemDetailsPriority = 'background' | 'interactive';

export type ItemDetailsResult =
    | { kind: 'ready'; item: MediaItem }
    | { kind: 'failed'; error: unknown }
    | { kind: 'cancelled' };

export interface ItemDetailsLease {
    readonly item: MediaItem | null;
    readonly promise: Promise<ItemDetailsResult>;
    release(): void;
}

interface ItemDetailsEntry {
    controller: AbortController;
    owners: Set<symbol>;
    item: MediaItem | null;
    promise: Promise<ItemDetailsResult>;
}

export class ItemDetailsPrefetcher {
    private readonly entries = new Map<string, ItemDetailsEntry>();
    private readonly loadItem: (itemId: string, signal: AbortSignal, priority: ItemDetailsPriority) => Promise<MediaItem>;

    constructor(loadItem: (itemId: string, signal: AbortSignal, priority: ItemDetailsPriority) => Promise<MediaItem>) {
        this.loadItem = loadItem;
    }

    acquire(itemId: string, priority: ItemDetailsPriority = 'background'): ItemDetailsLease {
        if (!itemId) return { item: null, promise: Promise.resolve({ kind: 'cancelled' }), release: () => undefined };

        let entry = this.entries.get(itemId);
        if (!entry) {
            const controller = new AbortController();
            const created: ItemDetailsEntry = {
                controller,
                owners: new Set(),
                item: null,
                promise: Promise.resolve({ kind: 'cancelled' })
            };
            this.entries.set(itemId, created);
            let request: Promise<MediaItem>;
            try {
                request = this.loadItem(itemId, controller.signal, priority);
            } catch (error) {
                request = Promise.reject(error);
            }
            created.promise = request.then((item): ItemDetailsResult => {
                if (controller.signal.aborted || this.entries.get(itemId) !== created) return { kind: 'cancelled' };
                created.item = item;
                return { kind: 'ready', item };
            }).catch((error: unknown): ItemDetailsResult => {
                if (this.entries.get(itemId) === created) this.entries.delete(itemId);
                return controller.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', error };
            });
            entry = created;
        }

        const ownedEntry = entry;
        const owner = Symbol(itemId);
        ownedEntry.owners.add(owner);
        let released = false;
        return {
            get item() { return ownedEntry.item; },
            promise: ownedEntry.promise,
            release: () => {
                if (released) return;
                released = true;
                ownedEntry.owners.delete(owner);
                if (ownedEntry.owners.size || this.entries.get(itemId) !== ownedEntry) return;
                this.entries.delete(itemId);
                if (!ownedEntry.item) ownedEntry.controller.abort();
            }
        };
    }

    clear(): void {
        const entries = Array.from(this.entries.values());
        this.entries.clear();
        entries.forEach(entry => { if (!entry.item) entry.controller.abort(); });
    }
}

const POINTER_PREFETCH_DWELL_MS = 200;

export interface ItemPrefetchHandlers {
    onPointerEnter: (event: PointerEvent) => void;
    onPointerLeave: (event: PointerEvent) => void;
    onFocusIn: () => void;
    onFocusOut: (event: FocusEvent) => void;
}

export function useItemPrefetch(api: JellyfinApi | null, itemId: string, enabled = true): ItemPrefetchHandlers {
    const current = useRef({ api, itemId, enabled });
    current.current = { api, itemId, enabled };
    const activePointers = useRef(new Set<number>());
    const focusInside = useRef(false);
    const lease = useRef<ItemDetailsLease | null>(null);
    const hoverTimer = useRef<number | null>(null);

    const clearHoverTimer = () => {
        if (hoverTimer.current === null) return;
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
    };
    const acquire = () => {
        const state = current.current;
        if (!state.enabled || !state.api || !state.itemId || lease.current) return;
        lease.current = state.api.acquireItemDetails(state.itemId, 'background');
    };
    const release = () => {
        const held = lease.current;
        lease.current = null;
        held?.release();
    };
    const schedulePointerPrefetch = () => {
        if (hoverTimer.current !== null || lease.current) return;
        hoverTimer.current = window.setTimeout(() => {
            hoverTimer.current = null;
            if (activePointers.current.size > 0) acquire();
        }, POINTER_PREFETCH_DWELL_MS);
    };

    useEffect(() => {
        if (current.current.enabled && current.current.api && current.current.itemId) {
            if (focusInside.current) acquire();
            else if (activePointers.current.size > 0) schedulePointerPrefetch();
        }
        return () => {
            clearHoverTimer();
            release();
        };
    }, [ api, itemId, enabled ]);

    return {
        onPointerEnter: event => {
            if (event.pointerType === 'touch' || !current.current.enabled) return;
            activePointers.current.add(event.pointerId);
            if (focusInside.current) acquire();
            else schedulePointerPrefetch();
        },
        onPointerLeave: event => {
            if (!activePointers.current.delete(event.pointerId) || activePointers.current.size > 0) return;
            clearHoverTimer();
            if (!focusInside.current) release();
        },
        onFocusIn: () => {
            if (!current.current.enabled) return;
            focusInside.current = true;
            clearHoverTimer();
            acquire();
        },
        onFocusOut: event => {
            const currentTarget = event.currentTarget;
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && currentTarget instanceof Node && currentTarget.contains(nextTarget)) return;
            focusInside.current = false;
            if (activePointers.current.size === 0) {
                clearHoverTimer();
                release();
            }
        }
    };
}
