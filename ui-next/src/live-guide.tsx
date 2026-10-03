import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { JellyfinApi, peekCachedImage, releaseCachedImage, retainCachedImage } from './api';
import { GUIDE_CHANNEL_WIDTH, GUIDE_HEADER_HEIGHT, GUIDE_ROW_HEIGHT, PIXELS_PER_MINUTE, artType, elapsedStop, episodeCode, formatClock, formatRange, guideSegments, isAiring, mediaTags, programBadges, rulerTicks, segmentBox, timelineWidth, timeRenderPadding, visibleIndexRange, visibleTimeRange, type GuideDay, type GuideSegment } from './live-model';
import type { LiveChannelFilter, MediaItem } from './types';

const FILTERS: Array<{ id: LiveChannelFilter; label: string }> = [
    { id: 'all', label: 'All channels' },
    { id: 'favorites', label: 'Favorites' },
    { id: 'sports', label: 'Sports' },
    { id: 'news', label: 'News' },
    { id: 'movies', label: 'Movies' },
    { id: 'kids', label: 'Kids' }
];

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
    onOpenProgram: (program: MediaItem, channel: MediaItem) => void;
    onTune: (channel: MediaItem) => void;
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
        const buttons = scroller.querySelectorAll<HTMLButtonElement>('button[data-program-id]');
        let match: HTMLButtonElement | null = null;
        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i];
            if (button.getAttribute('data-channel-id') !== pending.channelId) continue;
            const start = Number(button.getAttribute('data-start') || 0);
            const end = Number(button.getAttribute('data-end') || 0);
            if (pending.time >= start && pending.time < end) {
                match = button;
                break;
            }
            if (!match && start >= pending.time) match = button;
        }
        if (match) {
            match.focus();
            pendingTime.current = null;
        }
    }, [ scroll, props.channels, props.programsByChannel, props.windowStart ]);

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

    const buttonsFor = (channelId: string, program: boolean): HTMLButtonElement[] => {
        const scroller = scrollerRef.current;
        if (!scroller) return [];
        const selector = program ? 'button[data-program-id]' : 'button[data-rail="true"]';
        const nodes = scroller.querySelectorAll<HTMLButtonElement>(selector);
        const list: HTMLButtonElement[] = [];
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].getAttribute('data-channel-id') === channelId) list.push(nodes[i]);
        }
        return list;
    };

    const focusChannel = (channelId: string) => {
        const button = buttonsFor(channelId, false)[0];
        if (button) button.focus();
        else document.querySelector<HTMLElement>('.live-filter')?.focus();
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
        const target = event.target as HTMLElement | null;
        if (!target || target instanceof HTMLSelectElement || target instanceof HTMLInputElement) return;
        const channelId = target.getAttribute('data-channel-id') || '';
        const index = props.channels.findIndex(channel => channel.Id === channelId);
        if (!channelId || index < 0) return;
        const rail = target.getAttribute('data-rail') === 'true';
        const onProgram = Boolean(target.getAttribute('data-program-id'));
        const start = Number(target.getAttribute('data-start') || 0);
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            if (!onProgram) {
                if (rail) document.querySelector<HTMLElement>('.live-filter')?.focus();
                else focusChannel(channelId);
                return;
            }
            const programs = buttonsFor(channelId, true).sort((a, b) => Number(a.getAttribute('data-start')) - Number(b.getAttribute('data-start')));
            const currentIndex = programs.indexOf(target as HTMLButtonElement);
            const previous = currentIndex > 0 ? programs[currentIndex - 1] : null;
            const scroller = scrollerRef.current;
            const railEdge = (scroller?.getBoundingClientRect().left || 0) + GUIDE_CHANNEL_WIDTH;
            if (previous && previous.getBoundingClientRect().left >= railEdge) {
                previous.focus();
                return;
            }
            if (previous && scroller && scroller.scrollLeft > 0) {
                pendingTime.current = { channelId, time: start - 30 * 60000 };
                scroller.scrollLeft = Math.max(0, scroller.scrollLeft - 30 * PIXELS_PER_MINUTE);
                return;
            }
            focusChannel(channelId);
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            if (!onProgram) {
                const first = buttonsFor(channelId, true)[0];
                if (first) first.focus();
                return;
            }
            const programs = buttonsFor(channelId, true).sort((a, b) => Number(a.getAttribute('data-start')) - Number(b.getAttribute('data-start')));
            const currentIndex = programs.indexOf(target as HTMLButtonElement);
            const next = currentIndex >= 0 ? programs[currentIndex + 1] : null;
            const scroller = scrollerRef.current;
            const edge = scroller ? scroller.getBoundingClientRect().right - 24 : 0;
            if (next && next.getBoundingClientRect().left < edge) {
                next.focus();
                return;
            }
            if (scroller) {
                pendingTime.current = { channelId, time: start + 30 * 60000 };
                scroller.scrollLeft += 30 * PIXELS_PER_MINUTE;
            }
            return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            const nextIndex = index + (event.key === 'ArrowDown' ? 1 : -1);
            const nextChannel = props.channels[nextIndex];
            if (!nextChannel) return;
            scrollRow(nextIndex);
            window.requestAnimationFrame(() => {
                if (rail) {
                    focusChannel(nextChannel.Id);
                    return;
                }
                const programs = buttonsFor(nextChannel.Id, true);
                let match: HTMLButtonElement | null = null;
                for (let i = 0; i < programs.length; i++) {
                    const opened = Number(programs[i].getAttribute('data-start') || 0);
                    const closed = Number(programs[i].getAttribute('data-end') || 0);
                    if (start >= opened && start < closed) {
                        match = programs[i];
                        break;
                    }
                    if (!match && opened >= start) match = programs[i];
                }
                if (match) match.focus();
                else focusChannel(nextChannel.Id);
            });
        }
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
        <div class="live-toolbar">
            <div class="live-pills" role="group" aria-label="Guide day">
                {props.days.map(day => <button type="button" data-focusable="true" class={day.start === props.dayStart ? 'live-pill active' : 'live-pill'} key={day.start} onClick={() => props.onDay(day.start)}>{day.label}</button>)}
            </div>
            {props.digits && <p class="live-digits" aria-live="polite">Channel {props.digits}</p>}
            <select class="live-filter" aria-label="Channel filter" value={props.filter} onChange={event => props.onFilter((event.target as HTMLSelectElement).value as LiveChannelFilter)}>
                {FILTERS.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}
            </select>
        </div>
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
                <button type="button" class="button secondary" onClick={() => props.onOpenProgram(hover.program, hover.channel)}>Details</button>
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
    onOpenProgram: (program: MediaItem, channel: MediaItem) => void;
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
                    onClick={() => onOpenProgram(program, channel)}
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
