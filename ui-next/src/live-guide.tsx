import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { JellyfinApi, peekCachedImage, releaseCachedImage, retainCachedImage } from './api';
import { GUIDE_CHANNEL_WIDTH, GUIDE_HEADER_HEIGHT, GUIDE_ROW_HEIGHT, PIXELS_PER_MINUTE, artType, directionalFocusIndex, elapsedStop, episodeCode, formatClock, formatRange, guideSegments, isAiring, mediaTags, moveGuideFocus, moveGuideToolbar, programBadges, rulerTicks, segmentBox, timelineWidth, timeRenderPadding, visibleIndexRange, visibleTimeRange, type GuideDay, type GuideDirection, type GuideFocusProgram, type GuideFocusTarget, type GuideNavigationContext, type GuideSegment, type GuideToolbarControl } from './live-model';
import type { LiveChannelFilter, MediaItem } from './types';

const FILTERS: Array<{ id: LiveChannelFilter; label: string }> = [
    { id: 'all', label: 'All channels' },
    { id: 'favorites', label: 'Favorites' },
    { id: 'sports', label: 'Sports' },
    { id: 'news', label: 'News' },
    { id: 'movies', label: 'Movies' },
    { id: 'kids', label: 'Kids' }
];

function isLiveChannelFilter(value: string): value is LiveChannelFilter {
    return FILTERS.some(option => option.id === value);
}

function guideFocusTarget(element: HTMLElement): GuideFocusTarget | null {
    const channelId = element.getAttribute('data-channel-id');
    if (!channelId) return null;
    if (element.getAttribute('data-rail') === 'true') return { kind: 'channel', channelId };
    if (element.classList.contains('live-star')) return { kind: 'favorite', channelId };
    const programId = element.getAttribute('data-program-id');
    const start = Number(element.getAttribute('data-start'));
    const end = Number(element.getAttribute('data-end'));
    return programId && Number.isFinite(start) && Number.isFinite(end)
        ? { kind: 'program', channelId, programId, start, end }
        : null;
}

export function LiveThumb({ api, item, width = 96, className = '' }: { api: JellyfinApi; item: MediaItem; width?: number; className?: string }) {
    const [ src, setSrc ] = useState('');
    const held = useRef('');
    const type = artType(item);
    useEffect(() => {
        const key = api.imageUrl(item, type, width);
        if (!key) {
            setSrc('');
            return;
        }
        let active = true;
        const bag: { cancel?: () => void } = {};
        const apply = (url: string) => {
            if (!active || !url) return;
            if (held.current && held.current !== key) releaseCachedImage(held.current);
            retainCachedImage(key);
            held.current = key;
            setSrc(url);
        };
        const cached = peekCachedImage(key);
        if (cached) apply(cached);
        else void api.loadImage(item, type, width, 90, bag).then(apply);
        return () => {
            active = false;
            bag.cancel?.();
            if (held.current) releaseCachedImage(held.current);
            held.current = '';
        };
    }, [ api, item.Id, item.ImageTags?.Primary, item.ImageTags?.Thumb, item.ImageTags?.Logo, type, width ]);
    return src ? <img class={className} src={src} alt="" /> : <span class={`live-logo-fallback ${className}`} aria-hidden="true" />;
}

function BadgeRow({ program, now }: { program: MediaItem; now: number }) {
    const badges = programBadges(program, now);
    if (!badges.length) return null;
    return <span class="live-badges">{badges.map(badge => <span class={`live-badge live-badge-${badge}`} key={badge}>{badge === 'live' ? <i aria-hidden="true" /> : null}{badge === 'live' ? 'LIVE' : badge === 'new' ? 'NEW' : 'REC'}</span>)}</span>;
}

interface HoverState {
    program: MediaItem;
    channel: MediaItem;
    top: number;
    left: number;
}

interface LiveGuideProps {
    api: JellyfinApi;
    channels: MediaItem[];
    programsByChannel: Record<string, MediaItem[]>;
    windowStart: number;
    windowEnd: number;
    dayStart: number;
    now: number;
    days: GuideDay[];
    filter: LiveChannelFilter;
    loading: boolean;
    error: string;
    jumpId: string;
    jumpNonce: number;
    digits: string;
    sheetOpen: boolean;
    onDay: (start: number) => void;
    onFilter: (filter: LiveChannelFilter) => void;
    onExtend: (direction: 'back' | 'forward') => void;
    onVisible: (start: number, end: number) => void;
    onToggleFavorite: (channel: MediaItem) => void;
    onOpenProgram: (program: MediaItem, channel: MediaItem, origin: HTMLElement) => void;
    onTune: (channel: MediaItem) => void;
}

export function GuideToolbar({ days, dayStart, digits, filter, onDay, onFilter, onFocusChannels }: {
    days: GuideDay[];
    dayStart: number;
    digits: string;
    filter: LiveChannelFilter;
    onDay: (start: number) => void;
    onFilter: (filter: LiveChannelFilter) => void;
    onFocusChannels: () => void;
}) {
    const root = useRef<HTMLDivElement>(null);

    const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target || event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        const dayIndex = target.getAttribute('data-guide-day-index');
        const isFilter = target.getAttribute('data-guide-filter') === 'true';
        if (!isFilter && dayIndex === null) return;
        const from: GuideToolbarControl = isFilter
            ? { kind: 'filter' }
            : { kind: 'day', index: Number(dayIndex) };
        if (from.kind === 'day' && !Number.isInteger(from.index)) return;
        const move = moveGuideToolbar({ from, direction: event.key, dayCount: days.length });
        if (move.kind === 'native') {
            event.stopPropagation();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (move.kind === 'focus') {
            const selector = move.target.kind === 'filter'
                ? '[data-guide-filter="true"]'
                : `[data-guide-day-index="${move.target.index}"]`;
            root.current?.querySelector<HTMLElement>(selector)?.focus();
        } else if (move.kind === 'tabs') {
            document.querySelector<HTMLElement>('.live-tabs [aria-selected="true"]')?.focus();
        } else if (move.kind === 'channels') onFocusChannels();
    };

    return <div class="live-toolbar" ref={root} onKeyDown={onKeyDown}>
        <div class="live-pills" role="group" aria-label="Guide day">
            {days.map((day, index) => <button type="button" data-focusable="true" data-guide-day-index={index} class={day.start === dayStart ? 'live-pill active' : 'live-pill'} key={day.start} onClick={() => onDay(day.start)}>{day.label}</button>)}
        </div>
        {digits && <p class="live-digits" aria-live="polite">Channel {digits}</p>}
        <select class="live-filter" data-focusable="true" data-guide-filter="true" aria-label="Channel filter" value={filter} onChange={event => {
            const value = event.currentTarget.value;
            if (isLiveChannelFilter(value)) onFilter(value);
        }}>
            {FILTERS.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}
        </select>
    </div>;
}

export function LiveGuide(props: LiveGuideProps) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const previousStart = useRef(props.windowStart);
    const extendLock = useRef(0);
    const hoverTimer = useRef<number>();
    const onVisibleRef = useRef(props.onVisible);
    const onExtendRef = useRef(props.onExtend);
    onVisibleRef.current = props.onVisible;
    onExtendRef.current = props.onExtend;
    const pendingTime = useRef<{ channelId: string; time: number } | null>(null);
    const [ scroll, setScroll ] = useState({ top: 0, left: 0, width: 960, height: 640 });
    const [ hover, setHover ] = useState<HoverState | null>(null);
    const finePointer = useRef(typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    const width = timelineWidth(props.windowStart, props.windowEnd);
    const rows = visibleIndexRange(scroll.top, Math.max(120, scroll.height - GUIDE_HEADER_HEIGHT), props.channels.length);
    const time = visibleTimeRange(scroll.left, scroll.width, props.windowStart);
    const visibleMinutes = Math.max(30, (time.end - time.start) / 60000);
    const pad = timeRenderPadding(Math.max(1, rows.end - rows.start), visibleMinutes);
    const renderStart = time.start - pad;
    const renderEnd = time.end + pad;
    const ticks = rulerTicks(props.windowStart, props.windowEnd);
    const nowLeft = GUIDE_CHANNEL_WIDTH + ((props.now - props.windowStart) / 60000) * PIXELS_PER_MINUTE;
    const showNow = props.now >= props.windowStart && props.now <= props.windowEnd;

    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        const delta = previousStart.current - props.windowStart;
        previousStart.current = props.windowStart;
        if (!scroller || delta === 0) return;
        if (delta > 0 && delta <= 4 * 60 * 60 * 1000) scroller.scrollLeft += (delta / 60000) * PIXELS_PER_MINUTE;
        else scroller.scrollLeft = 0;
    }, [ props.windowStart ]);

    useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const measure = () => {
            const next = { top: scroller.scrollTop, left: scroller.scrollLeft, width: scroller.clientWidth, height: scroller.clientHeight };
            setScroll(current => {
                const currentRows = visibleIndexRange(current.top, Math.max(120, current.height - GUIDE_HEADER_HEIGHT), props.channels.length);
                const nextRows = visibleIndexRange(next.top, Math.max(120, next.height - GUIDE_HEADER_HEIGHT), props.channels.length);
                const rowChanged = currentRows.start !== nextRows.start || currentRows.end !== nextRows.end;
                const timeChanged = Math.abs(current.left - next.left) > 24 || current.width !== next.width || current.height !== next.height;
                if (!rowChanged && !timeChanged) return current;
                return next;
            });
        };
        measure();
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(measure);
            observer.observe(scroller);
            return () => observer.disconnect();
        }
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [ props.channels.length, props.windowStart, props.windowEnd ]);

    useEffect(() => {
        onVisibleRef.current(rows.start, rows.end);
    }, [ rows.start, rows.end, props.channels.length, props.windowStart, props.windowEnd ]);

    useEffect(() => {
        if (!props.jumpId) return;
        const index = props.channels.findIndex(channel => channel.Id === props.jumpId);
        const scroller = scrollerRef.current;
        if (index < 0 || !scroller) return;
        scroller.scrollTop = index * GUIDE_ROW_HEIGHT;
        const focus = () => {
            const buttons = scroller.querySelectorAll<HTMLButtonElement>('button[data-rail="true"]');
            for (let i = 0; i < buttons.length; i++) {
                if (buttons[i].getAttribute('data-channel-id') === props.jumpId) {
                    buttons[i].focus();
                    return;
                }
            }
        };
        window.requestAnimationFrame(focus);
    }, [ props.jumpNonce, props.jumpId, props.channels ]);

    useEffect(() => {
        const pending = pendingTime.current;
        if (!pending) return;
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const programs = (props.programsByChannel[pending.channelId] || []).map(program => ({
            programId: program.Id,
            start: Date.parse(program.StartDate || ''),
            end: Date.parse(program.EndDate || '')
        })).filter(program => program.programId && Number.isFinite(program.start) && Number.isFinite(program.end))
            .sort((left, right) => left.start - right.start);
        const target = programs.find(program => pending.time >= program.start && pending.time < program.end)
            || programs.find(program => program.start >= pending.time);
        if (!target) return;
        const buttons = scroller.querySelectorAll<HTMLButtonElement>('button[data-program-id]');
        let match: HTMLButtonElement | null = null;
        for (let i = 0; i < buttons.length; i++) {
            if (buttons[i].getAttribute('data-channel-id') === pending.channelId && buttons[i].getAttribute('data-program-id') === target.programId) {
                match = buttons[i];
                break;
            }
        }
        if (match) {
            match.focus();
            pendingTime.current = null;
            return;
        }
        const targetScrollLeft = Math.max(0, ((target.start - props.windowStart) / 60000) * PIXELS_PER_MINUTE);
        if (Math.abs(scroller.scrollLeft - targetScrollLeft) > 1) scroller.scrollLeft = targetScrollLeft;
    }, [ scroll, props.channels, props.programsByChannel, props.windowStart, props.windowEnd ]);

    const publishScroll = () => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const next = { top: scroller.scrollTop, left: scroller.scrollLeft, width: scroller.clientWidth, height: scroller.clientHeight };
        setScroll(current => {
            const currentRows = visibleIndexRange(current.top, Math.max(120, current.height - GUIDE_HEADER_HEIGHT), props.channels.length);
            const nextRows = visibleIndexRange(next.top, Math.max(120, next.height - GUIDE_HEADER_HEIGHT), props.channels.length);
            const rowChanged = currentRows.start !== nextRows.start || currentRows.end !== nextRows.end;
            const timeChanged = Math.abs(current.left - next.left) > 24 || current.width !== next.width;
            if (!rowChanged && !timeChanged && Math.abs(current.top - next.top) < 4) return current;
            return next;
        });
        const nowMs = Date.now();
        if (nowMs - extendLock.current < 350) return;
        if (scroller.scrollLeft + scroller.clientWidth > scroller.scrollWidth - 220) {
            extendLock.current = nowMs;
            onExtendRef.current('forward');
        } else if (scroller.scrollLeft < 48 && props.windowStart > props.dayStart) {
            extendLock.current = nowMs;
            onExtendRef.current('back');
        }
    };

    const buttonsFor = (channelId: string, kind: GuideFocusTarget['kind']): HTMLButtonElement[] => {
        const scroller = scrollerRef.current;
        if (!scroller) return [];
        const selector = kind === 'program' ? 'button[data-program-id]' : kind === 'channel' ? 'button[data-rail="true"]' : 'button.live-star';
        const nodes = scroller.querySelectorAll<HTMLButtonElement>(selector);
        const list: HTMLButtonElement[] = [];
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].getAttribute('data-channel-id') === channelId) list.push(nodes[i]);
        }
        return list;
    };

    const focusGuideTarget = (target: GuideFocusTarget): boolean => {
        const button = buttonsFor(target.channelId, target.kind).find(candidate => target.kind !== 'program' || candidate.getAttribute('data-program-id') === target.programId);
        if (!button) return false;
        button.focus();
        return true;
    };

    const focusChannel = (channelId: string) => {
        const button = buttonsFor(channelId, 'channel')[0];
        if (button) button.focus();
        else document.querySelector<HTMLElement>('.live-filter')?.focus();
    };

    const navigationContext = (from: GuideFocusTarget, direction: GuideDirection): GuideNavigationContext => {
        const channelIds = props.channels.map(channel => channel.Id);
        const channelIndex = channelIds.indexOf(from.channelId);
        const relevantChannels = new Set([from.channelId]);
        if (direction === 'ArrowUp' && channelIndex > 0) relevantChannels.add(channelIds[channelIndex - 1]);
        if (direction === 'ArrowDown' && channelIndex >= 0 && channelIndex < channelIds.length - 1) relevantChannels.add(channelIds[channelIndex + 1]);
        const programsByChannel: Record<string, GuideFocusProgram[]> = {};
        relevantChannels.forEach(channelId => {
            const programs: GuideFocusProgram[] = [];
            for (const program of props.programsByChannel[channelId] || []) {
                const start = Date.parse(program.StartDate || '');
                const end = Date.parse(program.EndDate || '');
                if (program.Id && Number.isFinite(start) && Number.isFinite(end) && end > props.windowStart && start < props.windowEnd) {
                    programs.push({ programId: program.Id, start, end });
                }
            }
            programs.sort((left, right) => left.start - right.start);
            programsByChannel[channelId] = programs;
        });
        const scroller = scrollerRef.current;
        return {
            channels: channelIds,
            programsByChannel,
            visibleStart: props.windowStart + ((scroller?.scrollLeft || 0) / PIXELS_PER_MINUTE) * 60000,
            canExtendForward: props.windowEnd < props.dayStart + 86400000
        };
    };

    const applyGuideMove = (move: ReturnType<typeof moveGuideFocus>) => {
        if (move.kind === 'clamp') return;
        if (move.kind === 'toolbar') {
            document.querySelector<HTMLElement>('.live-filter')?.focus();
            return;
        }
        if (move.kind === 'extend') {
            const now = Date.now();
            if (now - extendLock.current < 350) return;
            extendLock.current = now;
            pendingTime.current = { channelId: move.channelId, time: move.time };
            props.onExtend(move.direction);
            return;
        }
        if (move.kind === 'focus') {
            if (focusGuideTarget(move.target) || move.target.kind !== 'program') return;
            const scroller = scrollerRef.current;
            if (!scroller) return;
            pendingTime.current = { channelId: move.target.channelId, time: move.target.start };
            scroller.scrollLeft = Math.max(0, ((move.target.start - props.windowStart) / 60000) * PIXELS_PER_MINUTE);
            return;
        }
    };

    const scrollRow = (index: number) => {
        const scroller = scrollerRef.current;
        if (!scroller || index < 0) return;
        const top = index * GUIDE_ROW_HEIGHT;
        const viewTop = scroller.scrollTop;
        const viewBottom = viewTop + scroller.clientHeight - GUIDE_HEADER_HEIGHT;
        if (top < viewTop) scroller.scrollTop = top;
        else if (top + GUIDE_ROW_HEIGHT > viewBottom) scroller.scrollTop = top + GUIDE_ROW_HEIGHT - (scroller.clientHeight - GUIDE_HEADER_HEIGHT);
    };

    const onKeyDown = (event: KeyboardEvent) => {
        if (props.sheetOpen) return;
        const target = event.target instanceof HTMLElement ? event.target : null;
        const direction = event.key;
        if (!target || direction !== 'ArrowLeft' && direction !== 'ArrowRight' && direction !== 'ArrowUp' && direction !== 'ArrowDown') return;
        const from = guideFocusTarget(target);
        if (!from) return;
        event.preventDefault();
        event.stopPropagation();
        pendingTime.current = null;
        const vertical = direction === 'ArrowUp' || direction === 'ArrowDown';
        const channelIndex = props.channels.findIndex(channel => channel.Id === from.channelId);
        if (vertical) {
            const nextIndex = channelIndex + (direction === 'ArrowDown' ? 1 : -1);
            if (!props.channels[nextIndex]) return;
            scrollRow(nextIndex);
            window.requestAnimationFrame(() => applyGuideMove(moveGuideFocus({ from, direction, context: navigationContext(from, direction) })));
            return;
        }
        applyGuideMove(moveGuideFocus({ from, direction, context: navigationContext(from, direction) }));
    };

    const showHover = (program: MediaItem, channel: MediaItem, target: HTMLElement) => {
        if (!finePointer.current || props.sheetOpen) return;
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
        const rect = target.getBoundingClientRect();
        const left = Math.min(rect.left, window.innerWidth - 340);
        setHover({ program, channel, top: Math.min(rect.bottom + 8, window.innerHeight - 220), left: Math.max(8, left) });
    };

    const hideHover = () => {
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
        hoverTimer.current = window.setTimeout(() => setHover(null), 180);
    };

    return <div class="live-guide-wrap">
        <GuideToolbar days={props.days} dayStart={props.dayStart} digits={props.digits} filter={props.filter} onDay={props.onDay} onFilter={props.onFilter} onFocusChannels={() => {
            const channel = props.channels[0];
            if (!channel) return;
            const index = props.channels.findIndex(item => item.Id === channel.Id);
            scrollRow(index);
            window.requestAnimationFrame(() => focusChannel(channel.Id));
        }} />
        {props.error && <p class="notice error" role="alert">{props.error}</p>}
        <div class="live-guide-scroll" ref={scrollerRef} onScroll={publishScroll} onKeyDown={onKeyDown} role="grid" aria-label="Program guide" aria-rowcount={props.channels.length} aria-colcount={2}>
            <div class="live-guide-canvas" style={{ width: `${GUIDE_CHANNEL_WIDTH + width}px`, height: `${GUIDE_HEADER_HEIGHT + props.channels.length * GUIDE_ROW_HEIGHT}px` }}>
                <div class="live-guide-head">
                    <div class="live-ruler-corner">Channel</div>
                    <div class="live-ruler" style={{ width: `${width}px` }}>
                        {ticks.map(tick => <span class="live-tick" key={tick} style={{ left: `${((tick - props.windowStart) / 60000) * PIXELS_PER_MINUTE}px` }}>{formatClock(tick)}</span>)}
                    </div>
                </div>
                {showNow && <div class="live-now-line" style={{ left: `${nowLeft}px`, top: `${GUIDE_HEADER_HEIGHT}px` }} />}
                {props.channels.slice(rows.start, rows.end).map((channel, offset) => {
                    const index = rows.start + offset;
                    const segments = guideSegments(props.programsByChannel[channel.Id] || [], props.windowStart, props.windowEnd)
                        .filter(segment => segment.end > renderStart && segment.start < renderEnd);
                    return <GuideRow key={channel.Id} api={props.api} channel={channel} index={index} segments={segments} windowStart={props.windowStart} now={props.now} onToggleFavorite={props.onToggleFavorite} onOpenProgram={props.onOpenProgram} onTune={props.onTune} onHover={showHover} onHide={hideHover} />;
                })}
                {!props.loading && !props.channels.length && <p class="live-empty">No channels are available for this filter.</p>}
                {props.loading && !props.channels.length && <p class="live-empty">Loading the guide…</p>}
            </div>
        </div>
        {hover && <div class="live-popover" style={{ top: `${hover.top}px`, left: `${hover.left}px` }} onMouseEnter={() => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); }} onMouseLeave={hideHover}>
            <ProgramSummary program={hover.program} channel={hover.channel} now={props.now} />
            <div class="live-actions">
                <button type="button" class="button primary" onClick={() => props.onTune(hover.channel)}>Watch Now</button>
                <button type="button" class="button secondary" onClick={event => props.onOpenProgram(hover.program, hover.channel, event.currentTarget)}>Details</button>
            </div>
        </div>}
    </div>;
}

function GuideRow({ api, channel, index, segments, windowStart, now, onToggleFavorite, onOpenProgram, onTune, onHover, onHide }: {
    api: JellyfinApi;
    channel: MediaItem;
    index: number;
    segments: GuideSegment[];
    windowStart: number;
    now: number;
    onToggleFavorite: (channel: MediaItem) => void;
    onOpenProgram: (program: MediaItem, channel: MediaItem, origin: HTMLElement) => void;
    onTune: (channel: MediaItem) => void;
    onHover: (program: MediaItem, channel: MediaItem, target: HTMLElement) => void;
    onHide: () => void;
}) {
    const favorite = Boolean(channel.UserData?.IsFavorite);
    return <div class="live-row" role="row" style={{ top: `${GUIDE_HEADER_HEIGHT + index * GUIDE_ROW_HEIGHT}px` }}>
        <div class="live-channel">
            <button type="button" class="live-channel-tune" data-focusable="true" data-rail="true" data-channel-id={channel.Id} id={`live-channel-${channel.Id}`} onClick={() => onTune(channel)}>
                <span class="live-number">{channel.ChannelNumber || '—'}</span>
                <span class="live-logo"><LiveThumb api={api} item={channel} width={96} /></span>
                <span class="live-channel-name">{channel.Name}</span>
            </button>
            <button type="button" class={favorite ? 'live-star on' : 'live-star'} data-focusable="true" data-channel-id={channel.Id} aria-pressed={favorite ? 'true' : 'false'} aria-label={favorite ? `Remove ${channel.Name} from favorites` : `Add ${channel.Name} to favorites`} onClick={event => { event.stopPropagation(); onToggleFavorite(channel); }}>{favorite ? '★' : '☆'}</button>
        </div>
        <div class="live-track">
            {segments.map(segment => {
                const box = segmentBox(segment.start, segment.end, windowStart);
                if (!segment.program) {
                    return <div class="live-gap" key={segment.key} title="No program data available" style={{ left: `${box.left}px`, width: `${box.width}px` }}>{box.width >= 188 ? 'No program data available' : ''}</div>;
                }
                const program = segment.program;
                const airing = isAiring(program, now);
                const stop = airing ? elapsedStop(segment.start, segment.end, now) : 0;
                return <button
                    type="button"
                    class={airing ? 'live-program is-airing' : 'live-program'}
                    data-focusable="true"
                    data-channel-id={channel.Id}
                    data-program-id={program.Id}
                    data-start={String(Date.parse(program.StartDate || '') || segment.start)}
                    data-end={String(Date.parse(program.EndDate || '') || segment.end)}
                    key={segment.key}
                    style={{ left: `${box.left}px`, width: `${box.width}px`, ['--elapsed']: `${Math.round(stop * 100)}%` }}
                    onClick={event => onOpenProgram(program, channel, event.currentTarget)}
                    onMouseEnter={event => onHover(program, channel, event.currentTarget as HTMLElement)}
                    onMouseLeave={onHide}
                >
                    <span class="live-program-title">{program.Name}</span>
                    <BadgeRow program={program} now={now} />
                </button>;
            })}
        </div>
    </div>;
}

export function ProgramSummary({ program, channel, now }: { program: MediaItem; channel: MediaItem; now: number }) {
    const code = episodeCode(program);
    const tags = mediaTags(program);
    return <div class="live-summary">
        <p class="eyebrow">{channel.ChannelNumber ? `${channel.ChannelNumber} · ` : ''}{channel.Name}{code ? ` · ${code}` : ''}</p>
        <h3>{program.Name}</h3>
        <p class="muted">{formatRange(program.StartDate, program.EndDate) || ''}</p>
        <p class="live-overview">{program.Overview || 'No synopsis is available for this broadcast.'}</p>
        {tags.length > 0 && <p class="live-tags">{tags.join(' · ')}</p>}
    </div>;
}
