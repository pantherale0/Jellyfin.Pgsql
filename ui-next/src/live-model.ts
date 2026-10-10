import type { GuideInfo, LiveChannelFilter, MediaItem } from './types';

export const PIXELS_PER_MINUTE = 8;
export const GUIDE_ROW_HEIGHT = 68;
export const GUIDE_CHANNEL_WIDTH = 200;
export const GUIDE_GAP = 4;
export const GUIDE_CHUNK_MS = 4 * 60 * 60 * 1000;
export const GUIDE_ROW_OVERSCAN = 2;
export const CHANNEL_PAGE_SIZE = 30;
export const GUIDE_HEADER_HEIGHT = 56;

export interface GuideDay {
    label: string;
    start: number;
}

export interface GuideSegment {
    key: string;
    start: number;
    end: number;
    program?: MediaItem;
}

export interface OnNowGroup {
    id: string;
    title: string;
    items: MediaItem[];
}

export interface IndexRange {
    start: number;
    end: number;
}

export type GuideDirection = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export type GuideToolbarControl = { kind: 'day'; index: number } | { kind: 'filter' };

export type GuideToolbarMove =
    | { kind: 'focus'; target: GuideToolbarControl }
    | { kind: 'tabs' | 'channels' | 'native' | 'clamp' };

export type GuideFocusTarget =
    | { kind: 'channel'; channelId: string }
    | { kind: 'favorite'; channelId: string }
    | { kind: 'program'; channelId: string; programId: string; start: number; end: number };

export interface GuideFocusProgram {
    programId: string;
    start: number;
    end: number;
}

export interface GuideNavigationContext {
    channels: readonly string[];
    programsByChannel: Readonly<Record<string, readonly GuideFocusProgram[]>>;
    visibleStart: number;
    canExtendForward: boolean;
}

export type GuideFocusMove =
    | { kind: 'focus'; target: GuideFocusTarget }
    | { kind: 'toolbar'; control: 'filter' }
    | { kind: 'extend'; direction: 'forward'; channelId: string; time: number }
    | { kind: 'clamp' };

export interface FocusRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export function channelOrderKey(userId: string): string {
    return `jellyfin-ui-next-channel-order:${userId}`;
}

export function readChannelOrder(userId: string): string[] {
    try {
        const raw = localStorage.getItem(channelOrderKey(userId));
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch (_error) {
        return [];
    }
}

export function writeChannelOrder(userId: string, ids: string[]): void {
    try {
        localStorage.setItem(channelOrderKey(userId), JSON.stringify(ids));
    } catch (_error) { /* Ordering stays in memory when storage is blocked. */ }
}

export function orderChannels(channels: MediaItem[], savedIds: string[]): MediaItem[] {
    if (!savedIds.length) return channels;
    const rank = new Map<string, number>();
    savedIds.forEach((id, index) => rank.set(id, index));
    const fallback = savedIds.length;
    return channels.map((channel, index) => ({ channel, index }))
        .sort((a, b) => {
            const left = rank.has(a.channel.Id) ? rank.get(a.channel.Id) || 0 : fallback;
            const right = rank.has(b.channel.Id) ? rank.get(b.channel.Id) || 0 : fallback;
            if (left !== right) return left - right;
            return a.index - b.index;
        })
        .map(entry => entry.channel);
}

export function moveChannel(order: string[], visibleIds: string[], channelId: string, direction: -1 | 1): string[] {
    const base = order.length ? order.slice() : visibleIds.slice();
    visibleIds.forEach(id => {
        if (base.indexOf(id) < 0) base.push(id);
    });
    const index = base.indexOf(channelId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= base.length) return base;
    const next = base.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next;
}

export function withFavorite(item: MediaItem, favorite: boolean): MediaItem {
    return { ...item, UserData: { ...item.UserData, IsFavorite: favorite } };
}

export function startOfLocalDay(ms: number): number {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

export function floorTo(ms: number, step: number): number {
    return Math.floor(ms / step) * step;
}

export function guideDays(info: GuideInfo | null, now: number): GuideDay[] {
    const today = startOfLocalDay(now);
    const days: GuideDay[] = [
        { label: 'Today', start: today },
        { label: 'Tomorrow', start: today + 86400000 },
        { label: '+2d', start: today + 2 * 86400000 }
    ];
    const guideStart = Date.parse(info?.StartDate || '');
    const guideEnd = Date.parse(info?.EndDate || '');
    if (!Number.isFinite(guideStart) || !Number.isFinite(guideEnd)) return days;
    const available = days.filter(day => day.start < guideEnd && day.start + 86400000 > guideStart);
    return available.length ? available : days.slice(0, 1);
}

export function initialGuideRange(dayStart: number, now: number): { start: number; end: number } {
    const dayEnd = dayStart + 86400000;
    const today = now >= dayStart && now < dayEnd;
    const start = today ? floorTo(now, 30 * 60000) : dayStart;
    const end = Math.min(dayEnd, start + GUIDE_CHUNK_MS);
    return { start, end: Math.max(end, start + 30 * 60000) };
}

export function chunkStarts(rangeStart: number, rangeEnd: number): number[] {
    const starts: number[] = [];
    let cursor = floorTo(rangeStart, GUIDE_CHUNK_MS);
    const last = rangeEnd - 1;
    while (cursor <= last) {
        starts.push(cursor);
        cursor += GUIDE_CHUNK_MS;
    }
    return starts;
}

export function visibleIndexRange(scrollTop: number, viewport: number, count: number): IndexRange {
    if (count <= 0 || viewport <= 0) return { start: 0, end: 0 };
    const start = Math.max(0, Math.floor(scrollTop / GUIDE_ROW_HEIGHT) - GUIDE_ROW_OVERSCAN);
    const end = Math.min(count, Math.ceil((scrollTop + viewport) / GUIDE_ROW_HEIGHT) + GUIDE_ROW_OVERSCAN);
    return { start, end: Math.max(start, end) };
}

export function timeRenderPadding(rowCount: number, visibleMinutes: number): number {
    const budget = 40;
    let padMinutes = 60;
    while (padMinutes > 0 && rowCount * Math.ceil((visibleMinutes + padMinutes * 2) / 30) > budget) padMinutes -= 15;
    return padMinutes * 60000;
}

export function visibleTimeRange(scrollLeft: number, viewportWidth: number, windowStart: number): { start: number; end: number } {
    const width = Math.max(viewportWidth, GUIDE_CHANNEL_WIDTH + 80);
    const trackLeft = Math.max(0, scrollLeft);
    const trackRight = Math.max(trackLeft, scrollLeft + width - GUIDE_CHANNEL_WIDTH);
    return {
        start: windowStart + (trackLeft / PIXELS_PER_MINUTE) * 60000,
        end: windowStart + (trackRight / PIXELS_PER_MINUTE) * 60000
    };
}

export function segmentBox(start: number, end: number, windowStart: number): { left: number; width: number } {
    const minutes = Math.max(0, (end - start) / 60000);
    const left = ((start - windowStart) / 60000) * PIXELS_PER_MINUTE;
    const width = Math.max(28, minutes * PIXELS_PER_MINUTE - GUIDE_GAP);
    return { left, width };
}

export function guideSegments(programs: MediaItem[], windowStart: number, windowEnd: number): GuideSegment[] {
    const sorted = programs
        .map(program => ({ program, start: Date.parse(program.StartDate || ''), end: Date.parse(program.EndDate || '') }))
        .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > windowStart && item.start < windowEnd)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const segments: GuideSegment[] = [];
    let cursor = windowStart;
    sorted.forEach(item => {
        const start = Math.max(item.start, windowStart);
        const end = Math.min(item.end, windowEnd);
        if (start > cursor + 1000) segments.push({ key: `gap-${cursor}`, start: cursor, end: start });
        if (end > start) segments.push({ key: item.program.Id || `program-${start}`, start, end, program: item.program });
        cursor = Math.max(cursor, end);
    });
    if (windowEnd > cursor + 1000) segments.push({ key: `gap-${cursor}`, start: cursor, end: windowEnd });
    return segments;
}

export function rulerTicks(windowStart: number, windowEnd: number): number[] {
    const step = 30 * 60000;
    const ticks: number[] = [];
    let cursor = Math.ceil(windowStart / step) * step;
    while (cursor <= windowEnd) {
        ticks.push(cursor);
        cursor += step;
    }
    return ticks;
}

export function timelineWidth(windowStart: number, windowEnd: number): number {
    return Math.max(PIXELS_PER_MINUTE * 30, ((windowEnd - windowStart) / 60000) * PIXELS_PER_MINUTE);
}

export function airingProgress(start: string | undefined, end: string | undefined, now: number): number {
    const opened = Date.parse(start || '');
    const closed = Date.parse(end || '');
    if (!Number.isFinite(opened) || !Number.isFinite(closed) || closed <= opened) return 0;
    return Math.min(1, Math.max(0, (now - opened) / (closed - opened)));
}

export function elapsedStop(segmentStart: number, segmentEnd: number, now: number): number {
    if (segmentEnd <= segmentStart || now <= segmentStart) return 0;
    if (now >= segmentEnd) return 1;
    return (now - segmentStart) / (segmentEnd - segmentStart);
}

export function isAiring(program: MediaItem, now: number): boolean {
    const start = Date.parse(program.StartDate || '');
    const end = Date.parse(program.EndDate || '');
    return Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
}

export function programBadges(program: MediaItem, now: number): Array<'live' | 'new' | 'rec'> {
    const badges: Array<'live' | 'new' | 'rec'> = [];
    if (isAiring(program, now)) badges.push('live');
    if (program.IsPremiere || program.IsRepeat === false) badges.push('new');
    if (program.TimerId || program.SeriesTimerId) badges.push('rec');
    return badges;
}

export function episodeCode(item: MediaItem): string {
    const season = item.ParentIndexNumber;
    const episode = item.IndexNumber;
    const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
    if (season !== undefined && episode !== undefined) return `S${pad(season)}E${pad(episode)}`;
    if (episode !== undefined) return `E${pad(episode)}`;
    return '';
}

export function mediaTags(item: MediaItem): string[] {
    const tags: string[] = [];
    if (item.Width && item.Height) tags.push(`${item.Width}×${item.Height}`);
    const audio = (item.MediaStreams || []).find(stream => stream.Type === 'Audio' || stream.Type === 0);
    if (audio?.DisplayTitle) tags.push(audio.DisplayTitle);
    else if (audio?.Codec) tags.push(audio.Codec.toUpperCase());
    return tags;
}

export function categoryLabel(item: MediaItem): string {
    if (item.IsSports) return 'Sports';
    if (item.IsNews) return 'News';
    if (item.IsMovie) return 'Movies';
    if (item.IsKids) return 'Kids';
    if (item.IsSeries) return 'Series';
    return 'Live';
}

export function groupOnNow(programs: MediaItem[]): OnNowGroup[] {
    const groups: OnNowGroup[] = [
        { id: 'sports', title: 'Sports', items: [] },
        { id: 'news', title: 'News', items: [] },
        { id: 'movies', title: 'Movies', items: [] },
        { id: 'kids', title: 'Kids', items: [] },
        { id: 'other', title: 'More on now', items: [] }
    ];
    programs.forEach(program => {
        const group = program.IsSports ? groups[0]
            : program.IsNews ? groups[1]
                : program.IsMovie ? groups[2]
                    : program.IsKids ? groups[3]
                        : groups[4];
        group.items.push(program);
    });
    return groups.filter(group => group.items.length > 0);
}

export function upNextByChannel(programs: MediaItem[], now: number): Record<string, MediaItem> {
    const next: Record<string, MediaItem> = {};
    programs.forEach(program => {
        const channelId = program.ChannelId;
        const start = Date.parse(program.StartDate || '');
        if (!channelId || !Number.isFinite(start) || start < now) return;
        const current = next[channelId];
        if (!current || start < Date.parse(current.StartDate || '')) next[channelId] = program;
    });
    return next;
}

export function moveGuideFocus({ from, direction, context }: {
    from: GuideFocusTarget;
    direction: GuideDirection;
    context: GuideNavigationContext;
}): GuideFocusMove {
    const channelIndex = context.channels.indexOf(from.channelId);
    if (channelIndex < 0) return { kind: 'clamp' };

    if (direction === 'ArrowUp' || direction === 'ArrowDown') {
        const nextIndex = channelIndex + (direction === 'ArrowDown' ? 1 : -1);
        const channelId = context.channels[nextIndex];
        if (!channelId) return { kind: 'clamp' };
        if (from.kind === 'channel') return { kind: 'focus', target: { kind: 'channel', channelId } };
        if (from.kind === 'favorite') return { kind: 'focus', target: { kind: 'favorite', channelId } };
        const programs = context.programsByChannel[channelId] || [];
        const program = programs.find(item => from.start >= item.start && from.start < item.end)
            || programs.find(item => item.start >= from.start);
        return program
            ? { kind: 'focus', target: { kind: 'program', channelId, ...program } }
            : { kind: 'focus', target: { kind: 'channel', channelId } };
    }

    if (direction === 'ArrowRight') {
        if (from.kind === 'channel') return { kind: 'focus', target: { kind: 'favorite', channelId: from.channelId } };
        const programs = context.programsByChannel[from.channelId] || [];
        if (from.kind === 'favorite') {
            const first = programs.find(program => program.end > context.visibleStart);
            return first
                ? { kind: 'focus', target: { kind: 'program', channelId: from.channelId, ...first } }
                : { kind: 'clamp' };
        }
        const programIndex = programs.findIndex(program => program.programId === from.programId);
        const next = programIndex >= 0 ? programs[programIndex + 1] : undefined;
        if (next) return { kind: 'focus', target: { kind: 'program', channelId: from.channelId, ...next } };
        return context.canExtendForward
            ? { kind: 'extend', direction: 'forward', channelId: from.channelId, time: from.end }
            : { kind: 'clamp' };
    }

    if (from.kind === 'channel') return { kind: 'toolbar', control: 'filter' };
    if (from.kind === 'favorite') return { kind: 'focus', target: { kind: 'channel', channelId: from.channelId } };
    const programs = context.programsByChannel[from.channelId] || [];
    const programIndex = programs.findIndex(program => program.programId === from.programId);
    const previous = programIndex > 0 ? programs[programIndex - 1] : undefined;
    if (previous) return { kind: 'focus', target: { kind: 'program', channelId: from.channelId, ...previous } };
    return { kind: 'focus', target: { kind: 'favorite', channelId: from.channelId } };
}

export function directionalFocusIndex(rectangles: readonly FocusRect[], currentIndex: number, direction: GuideDirection): number | null {
    const current = rectangles[currentIndex];
    if (!current) return null;
    const centerX = current.left + current.width / 2;
    const centerY = current.top + current.height / 2;
    const right = current.left + current.width;
    const bottom = current.top + current.height;
    let nearest: number | null = null;
    let nearestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < rectangles.length; index++) {
        if (index === currentIndex) continue;
        const candidate = rectangles[index];
        const dx = candidate.left + candidate.width / 2 - centerX;
        const dy = candidate.top + candidate.height / 2 - centerY;
        const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
        const primary = horizontal ? dx * (direction === 'ArrowRight' ? 1 : -1) : dy * (direction === 'ArrowDown' ? 1 : -1);
        if (primary <= 4) continue;
        const cross = horizontal ? Math.abs(dy) : Math.abs(dx);
        const overlap = horizontal
            ? Math.min(candidate.top + candidate.height, bottom) - Math.max(candidate.top, current.top)
            : Math.min(candidate.left + candidate.width, right) - Math.max(candidate.left, current.left);
        const score = primary + cross * 2 + (overlap > 0 ? 0 : 1000);
        if (score < nearestScore) {
            nearest = index;
            nearestScore = score;
        }
    }
    return nearest;
}

export function moveGuideToolbar({ from, direction, dayCount }: {
    from: GuideToolbarControl;
    direction: GuideDirection;
    dayCount: number;
}): GuideToolbarMove {
    if (from.kind === 'filter') {
        if (direction === 'ArrowLeft') return dayCount > 0 ? { kind: 'focus', target: { kind: 'day', index: dayCount - 1 } } : { kind: 'clamp' };
        if (direction === 'ArrowUp' || direction === 'ArrowDown') return { kind: 'native' };
        return { kind: 'clamp' };
    }
    if (from.index < 0 || from.index >= dayCount) return { kind: 'clamp' };
    if (direction === 'ArrowLeft') return from.index > 0 ? { kind: 'focus', target: { kind: 'day', index: from.index - 1 } } : { kind: 'clamp' };
    if (direction === 'ArrowRight') {
        if (from.index < dayCount - 1) return { kind: 'focus', target: { kind: 'day', index: from.index + 1 } };
        return { kind: 'focus', target: { kind: 'filter' } };
    }
    return direction === 'ArrowUp' ? { kind: 'tabs' } : { kind: 'channels' };
}

export function mergePrograms(current: Record<string, MediaItem[]>, items: MediaItem[]): Record<string, MediaItem[]> {
    const next: Record<string, MediaItem[]> = { ...current };
    items.forEach(item => {
        const channelId = item.ChannelId;
        if (!channelId || !item.Id) return;
        const list = next[channelId] ? next[channelId].slice() : [];
        if (!list.some(existing => existing.Id === item.Id)) list.push(item);
        next[channelId] = list;
    });
    return next;
}

export function channelDigits(value: string | undefined): string {
    return (value || '').replace(/\D/g, '');
}

export function matchChannelIndex(channels: MediaItem[], digits: string): number {
    if (!digits) return -1;
    const exact = channels.findIndex(channel => channelDigits(channel.ChannelNumber) === digits);
    if (exact >= 0) return exact;
    return channels.findIndex(channel => channelDigits(channel.ChannelNumber).startsWith(digits));
}

export function formatClock(ms: number): string {
    const date = new Date(ms);
    const hours = date.getHours();
    const minutes = date.getMinutes();
    return `${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}

export function formatRange(start?: string, end?: string): string {
    const opened = Date.parse(start || '');
    const closed = Date.parse(end || '');
    if (!Number.isFinite(opened)) return '';
    if (!Number.isFinite(closed)) return formatClock(opened);
    return `${formatClock(opened)}–${formatClock(closed)}`;
}

export function formatRemaining(end: string | undefined, now: number): string {
    const closed = Date.parse(end || '');
    if (!Number.isFinite(closed)) return '';
    const minutes = Math.max(0, Math.round((closed - now) / 60000));
    if (minutes < 1) return 'Ending';
    if (minutes < 60) return `${minutes}m left`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}

export function channelFromProgram(program: MediaItem): MediaItem {
    return {
        Id: program.ChannelId || program.Id,
        Name: program.ChannelName || 'Channel',
        Type: 'TvChannel',
        ChannelNumber: program.ChannelNumber,
        ImageTags: program.ImageTags
    };
}

export function artType(item: MediaItem): string {
    if (item.ImageTags?.Primary) return 'Primary';
    if (item.ImageTags?.Thumb) return 'Thumb';
    if (item.ImageTags?.Logo) return 'Logo';
    return 'Primary';
}

export function isHlsUrl(url: string): boolean {
    return /\.m3u8(?:[?#]|$)/i.test(url);
}

export function filterLabel(filter: LiveChannelFilter): string {
    if (filter === 'favorites') return 'Favorites';
    if (filter === 'sports') return 'Sports';
    if (filter === 'news') return 'News';
    if (filter === 'movies') return 'Movies';
    if (filter === 'kids') return 'Kids';
    return 'All channels';
}

export function isoTime(ms: number): string {
    return new Date(ms).toISOString();
}
