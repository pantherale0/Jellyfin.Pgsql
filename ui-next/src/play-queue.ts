import { itemCapabilities } from './catalog-model';
import type { MediaItem } from './types';

export type RepeatMode = 'off' | 'all' | 'one';

/**
 * `original` keeps insertion order so shuffle can be undone; `order` is what plays.
 * `position` is the last queue title started (-1 before the first) and `active` says the
 * player is on it right now, so titles queued while browsing wait for the current one to end.
 */
export interface PlayQueue {
    original: MediaItem[];
    order: MediaItem[];
    position: number;
    active: boolean;
    shuffle: boolean;
    repeat: RepeatMode;
}

/** Seconds the "Up next" card counts down before the next title starts. */
export const AUTOPLAY_COUNTDOWN_SECONDS = 10;
export const MAX_QUEUE = 500;

const LIVE_TYPES = [ 'TvChannel', 'Program' ];

export type QueueFilter = (item: Pick<MediaItem, 'Type' | 'MediaType'>) => boolean;

/** Video titles that can sit in the queue; audio queues belong to the music player and live streams never end. */
export function queueable(item: Pick<MediaItem, 'Type' | 'MediaType'>): boolean {
    return itemCapabilities(item).playable && item.MediaType !== 'Audio' && item.Type !== 'Audio' && LIVE_TYPES.indexOf(item.Type || '') < 0;
}

/** Tracks the music player can queue. */
export function audioQueueable(item: Pick<MediaItem, 'Type' | 'MediaType'>): boolean {
    return item.MediaType === 'Audio' || item.Type === 'Audio';
}

export function emptyQueue(): PlayQueue {
    return { original: [], order: [], position: -1, active: false, shuffle: false, repeat: 'off' };
}

function shuffled(items: MediaItem[], random: () => number): MediaItem[] {
    const next = items.slice();
    for (let index = next.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [ next[index], next[swap] ] = [ next[swap], next[index] ];
    }
    return next;
}

/** Starts a queue from a playlist or collection; the returned item is what to play now. */
export function createQueue(items: MediaItem[], startIndex = 0, options: { shuffle?: boolean; repeat?: RepeatMode; random?: () => number; accept?: QueueFilter } = {}): { queue: PlayQueue; item: MediaItem } | null {
    const original = items.filter(options.accept || queueable).slice(0, MAX_QUEUE);
    if (!original.length) return null;
    const start = options.shuffle && startIndex < 0
        ? original[Math.floor((options.random || Math.random)() * original.length)]
        : original[Math.min(Math.max(0, startIndex), original.length - 1)];
    const order = options.shuffle
        ? [ start, ...shuffled(original.filter(item => item !== start), options.random || Math.random) ]
        : original;
    const position = order.indexOf(start);
    return { queue: { original, order, position, active: true, shuffle: !!options.shuffle, repeat: options.repeat || 'off' }, item: start };
}

export function currentItem(queue: PlayQueue): MediaItem | null {
    return queue.active ? queue.order[queue.position] || null : null;
}

function insertAfter(list: MediaItem[], index: number, item: MediaItem): MediaItem[] {
    return [ ...list.slice(0, index + 1), item, ...list.slice(index + 1) ];
}

/** Inserts the title so it plays when the current one ends. */
export function playNext(queue: PlayQueue, item: MediaItem, accept: QueueFilter = queueable): PlayQueue {
    if (!accept(item) || queue.order.length >= MAX_QUEUE) return queue;
    const anchor = queue.order[queue.position];
    const originalIndex = anchor ? queue.original.indexOf(anchor) : -1;
    return { ...queue, original: insertAfter(queue.original, originalIndex, item), order: insertAfter(queue.order, queue.position, item) };
}

export function addToQueue(queue: PlayQueue, item: MediaItem, accept: QueueFilter = queueable): PlayQueue {
    if (!accept(item) || queue.order.length >= MAX_QUEUE) return queue;
    return { ...queue, original: [ ...queue.original, item ], order: [ ...queue.order, item ] };
}

export function removeFromQueue(queue: PlayQueue, index: number): PlayQueue {
    const item = queue.order[index];
    if (!item || (queue.active && index === queue.position)) return queue;
    const order = queue.order.filter((_, entry) => entry !== index);
    const original = queue.original.filter(entry => entry !== item);
    return { ...queue, order, original, position: index < queue.position ? queue.position - 1 : queue.position };
}

/** Moves a title one place in play order; the playing title can move too and keeps playing. */
export function moveInQueue(queue: PlayQueue, index: number, delta: -1 | 1): PlayQueue {
    const target = index + delta;
    if (!queue.order[index] || target < 0 || target >= queue.order.length) return queue;
    const order = queue.order.slice();
    [ order[index], order[target] ] = [ order[target], order[index] ];
    const position = queue.position === index ? target : queue.position === target ? index : queue.position;
    return { ...queue, order, original: queue.shuffle ? queue.original : order, position };
}

/** Makes the title at `index` current. */
export function jumpTo(queue: PlayQueue, index: number): { queue: PlayQueue; item: MediaItem } | null {
    const item = queue.order[index];
    return item ? { queue: { ...queue, position: index, active: true }, item } : null;
}

/** Titles still to play, in play order. */
export function upcoming(queue: PlayQueue): MediaItem[] {
    return queue.order.slice(queue.position + 1);
}

/** Moves to the next queue title; `manual` skips ignore repeat-one. Null means nothing is left. */
export function advance(queue: PlayQueue, manual = false): { queue: PlayQueue; item: MediaItem } | null {
    if (!queue.order.length) return null;
    if (queue.active && queue.repeat === 'one' && !manual) return { queue, item: queue.order[queue.position] };
    let position = queue.position + 1;
    if (position >= queue.order.length) {
        if (queue.repeat !== 'all' || !queue.active) return null;
        position = 0;
    }
    return { queue: { ...queue, position, active: true }, item: queue.order[position] };
}

export function previous(queue: PlayQueue): { queue: PlayQueue; item: MediaItem } | null {
    if (!queue.active) return null;
    let position = queue.position - 1;
    if (position < 0) {
        if (queue.repeat !== 'all') return null;
        position = queue.order.length - 1;
    }
    return { queue: { ...queue, position }, item: queue.order[position] };
}

/** Shuffles the titles still to play, or restores insertion order around the current one. */
export function toggleShuffle(queue: PlayQueue, random: () => number = Math.random): PlayQueue {
    if (queue.shuffle) {
        const anchor = queue.order[queue.position];
        return { ...queue, shuffle: false, order: queue.original, position: anchor ? queue.original.indexOf(anchor) : -1 };
    }
    const played = queue.order.slice(0, queue.position + 1);
    return { ...queue, shuffle: true, order: [ ...played, ...shuffled(queue.order.slice(queue.position + 1), random) ] };
}

export function cycleRepeat(mode: RepeatMode): RepeatMode {
    return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}

/** Follows what the player is on: a queued title becomes current, anything else pauses the queue. */
export function syncQueue(queue: PlayQueue, playing: MediaItem | null): PlayQueue {
    if (!playing || !queue.order.length) return queue;
    if (queue.active && queue.order[queue.position]?.Id === playing.Id) return queue;
    const index = queue.order.findIndex((item, entry) => item.Id === playing.Id && entry > queue.position);
    const fallback = index >= 0 ? index : queue.order.findIndex(item => item.Id === playing.Id);
    if (fallback >= 0) return { ...queue, position: fallback, active: true };
    return queue.active ? { ...queue, active: false } : queue;
}

/**
 * What plays when the current title ends: the queue first, then the next episode when the
 * account allows autoplay (Jellyfin treats a missing `EnableNextEpisodeAutoPlay` as on).
 */
export function upNext(queue: PlayQueue, options: { autoplay: boolean | undefined; nextEpisode: MediaItem | null; current: MediaItem | null }): { item: MediaItem; source: 'queue' | 'episode'; queue: PlayQueue } | null {
    const queued = advance(queue);
    if (queued) return { item: queued.item, source: 'queue', queue: queued.queue };
    if (options.autoplay === false || options.current?.Type !== 'Episode' || !options.nextEpisode) return null;
    return { item: options.nextEpisode, source: 'episode', queue };
}

type Listener = (queue: PlayQueue) => void;

/** Session-scoped queue shared by the library, details and the player; not persisted. */
export function createQueueStore(initial: PlayQueue = emptyQueue()) {
    let state = initial;
    const listeners = new Set<Listener>();
    const set = (next: PlayQueue) => {
        if (next === state) return;
        state = next;
        listeners.forEach(listener => listener(state));
    };
    return {
        get: () => state,
        set,
        update: (change: (queue: PlayQueue) => PlayQueue) => set(change(state)),
        clear: () => set(emptyQueue()),
        subscribe(listener: Listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

export const playQueue = createQueueStore();
