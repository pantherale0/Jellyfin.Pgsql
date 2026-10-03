import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import { LiveGuide, LiveThumb, ProgramSummary } from './live-guide';
import { CHANNEL_PAGE_SIZE, GUIDE_CHUNK_MS, airingProgress, categoryLabel, channelFromProgram, chunkStarts, formatClock, formatRange, formatRemaining, groupOnNow, guideDays, initialGuideRange, isoTime, matchChannelIndex, mergePrograms, moveChannel, orderChannels, readChannelOrder, startOfLocalDay, upNextByChannel, withFavorite, writeChannelOrder, type GuideDay } from './live-model';
import type { LiveChannelFilter, LiveTab, LiveTimer, MediaItem } from './types';

const TABS: Array<{ id: LiveTab; label: string }> = [
    { id: 'now', label: 'On Now' },
    { id: 'guide', label: 'Guide' },
    { id: 'channels', label: 'Channels' },
    { id: 'dvr', label: 'DVR' }
];

function liveError(error: unknown, denied: string): string {
    const message = error instanceof Error ? error.message : '';
    if (message.indexOf('(403)') >= 0) return denied;
    return message || 'Something went wrong. Please try again.';
}

function useMaxWidth(max: number): boolean {
    const query = `(max-width: ${max}px)`;
    const [ matches, setMatches ] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
    useEffect(() => {
        const media = window.matchMedia(query);
        const apply = () => setMatches(media.matches);
        apply();
        if (media.addEventListener) media.addEventListener('change', apply);
        else media.addListener(apply);
        return () => {
            if (media.removeEventListener) media.removeEventListener('change', apply);
            else media.removeListener(apply);
        };
    }, [ query ]);
    return matches;
}

export function LiveTvPage({ api, userId, tab, onTab, onPlay }: {
    api: JellyfinApi;
    userId: string;
    tab: LiveTab;
    onTab: (tab: LiveTab) => void;
    onPlay: (item: MediaItem) => void;
}) {
    const compact = useMaxWidth(767);
    const [ now, setNow ] = useState(() => Date.now());
    const [ order, setOrder ] = useState<string[]>(() => readChannelOrder(userId));
    const [ filter, setFilter ] = useState<LiveChannelFilter>('all');
    const [ days, setDays ] = useState<GuideDay[]>(() => guideDays(null, Date.now()));
    const [ dayStart, setDayStart ] = useState(() => startOfLocalDay(Date.now()));
    const [ range, setRange ] = useState(() => initialGuideRange(startOfLocalDay(Date.now()), Date.now()));
    const [ guideChannels, setGuideChannels ] = useState<MediaItem[]>([]);
    const [ guideTotal, setGuideTotal ] = useState(0);
    const [ guideLoading, setGuideLoading ] = useState(false);
    const [ guideError, setGuideError ] = useState('');
    const [ programs, setPrograms ] = useState<Record<string, MediaItem[]>>({});
    const [ directory, setDirectory ] = useState<MediaItem[]>([]);
    const [ directoryTotal, setDirectoryTotal ] = useState(0);
    const [ directoryLoading, setDirectoryLoading ] = useState(false);
    const [ directoryError, setDirectoryError ] = useState('');
    const [ airing, setAiring ] = useState<MediaItem[]>([]);
    const [ upcoming, setUpcoming ] = useState<MediaItem[]>([]);
    const [ nowLoading, setNowLoading ] = useState(false);
    const [ nowError, setNowError ] = useState('');
    const [ timers, setTimers ] = useState<LiveTimer[]>([]);
    const [ seriesTimers, setSeriesTimers ] = useState<LiveTimer[]>([]);
    const [ recordings, setRecordings ] = useState<MediaItem[]>([]);
    const [ dvrLoading, setDvrLoading ] = useState(false);
    const [ dvrError, setDvrError ] = useState('');
    const [ dvrTick, setDvrTick ] = useState(0);
    const [ sheet, setSheet ] = useState<{ program: MediaItem; channel: MediaItem } | null>(null);
    const [ actionError, setActionError ] = useState('');
    const [ recordingBusy, setRecordingBusy ] = useState(false);
    const [ expandedId, setExpandedId ] = useState('');
    const [ dayPrograms, setDayPrograms ] = useState<MediaItem[]>([]);
    const [ jump, setJump ] = useState({ id: '', nonce: 0 });
    const [ digits, setDigits ] = useState('');
    const guideCount = useRef(0);
    const guideGeneration = useRef(0);
    const directoryCount = useRef(0);
    const loadedChunks = useRef(new Set<string>());
    const programQueue = useRef<MediaItem[]>([]);
    const programFrame = useRef(0);
    const guideLoadingMore = useRef(false);
    const digitBuffer = useRef('');
    const digitTimer = useRef<number>();
    const sheetRef = useRef<HTMLElement>(null);

    const orderedGuide = useMemo(() => orderChannels(guideChannels, order), [ guideChannels, order ]);
    const orderedDirectory = useMemo(() => orderChannels(directory, order), [ directory, order ]);
    const groups = useMemo(() => groupOnNow(airing), [ airing ]);
    const nextByChannel = useMemo(() => {
        const merged = upcoming.slice();
        Object.keys(programs).forEach(id => {
            const list = programs[id];
            if (list) list.forEach(item => merged.push(item));
        });
        return upNextByChannel(merged, now);
    }, [ upcoming, programs, now ]);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60000);
        return () => {
            window.clearInterval(timer);
            if (programFrame.current) window.cancelAnimationFrame(programFrame.current);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        void api.getGuideInfo().then(info => {
            if (cancelled) return;
            const nextDays = guideDays(info, Date.now());
            setDays(nextDays);
            setDayStart(current => nextDays.some(day => day.start === current) ? current : nextDays[0].start);
        }).catch(() => {
            if (cancelled) return;
            const nextDays = guideDays(null, Date.now());
            setDays(nextDays);
        });
        return () => { cancelled = true; };
    }, [ api ]);

    useEffect(() => {
        setRange(initialGuideRange(dayStart, Date.now()));
        setExpandedId('');
    }, [ dayStart ]);

    useEffect(() => {
        if (tab !== 'guide') return;
        const generation = ++guideGeneration.current;
        loadedChunks.current = new Set();
        guideCount.current = 0;
        setPrograms({});
        setGuideChannels([]);
        setGuideLoading(true);
        setGuideError('');
        void api.getLiveChannels(0, CHANNEL_PAGE_SIZE, filter).then(response => {
            if (generation !== guideGeneration.current) return;
            const items = response.Items || [];
            guideCount.current = items.length;
            setGuideChannels(items);
            setGuideTotal(response.TotalRecordCount ?? items.length);
        }).catch(error => {
            if (generation === guideGeneration.current) setGuideError(liveError(error, 'The guide could not load.'));
        }).finally(() => {
            if (generation === guideGeneration.current) setGuideLoading(false);
        });
    }, [ api, tab, filter ]);

    const queuePrograms = (items: MediaItem[]) => {
        if (!items.length) return;
        programQueue.current = programQueue.current.concat(items);
        if (programFrame.current) return;
        programFrame.current = window.requestAnimationFrame(() => {
            programFrame.current = 0;
            const buffered = programQueue.current;
            programQueue.current = [];
            if (buffered.length) setPrograms(current => mergePrograms(current, buffered));
        });
    };

    const ensurePrograms = async (ids: string[], start: number, end: number) => {
        const jobs: Array<{ ids: string[]; chunk: number }> = [];
        chunkStarts(start, end).forEach(chunk => {
            const missing = ids.filter(id => id && !loadedChunks.current.has(`${id}:${chunk}`));
            missing.forEach(id => loadedChunks.current.add(`${id}:${chunk}`));
            for (let index = 0; index < missing.length; index += CHANNEL_PAGE_SIZE) {
                jobs.push({ ids: missing.slice(index, index + CHANNEL_PAGE_SIZE), chunk });
            }
        });
        if (!jobs.length) return;
        await Promise.all(jobs.map(async job => {
            try {
                const response = await api.getLivePrograms(job.ids, isoTime(job.chunk), isoTime(job.chunk + GUIDE_CHUNK_MS));
                queuePrograms(response.Items || []);
            } catch (error) {
                job.ids.forEach(id => loadedChunks.current.delete(`${id}:${job.chunk}`));
                setGuideError(liveError(error, 'The guide could not load.'));
            }
        }));
    };

    const loadMoreGuide = async () => {
        if (guideLoadingMore.current || guideCount.current >= guideTotal) return;
        guideLoadingMore.current = true;
        const generation = guideGeneration.current;
        try {
            const response = await api.getLiveChannels(guideCount.current, CHANNEL_PAGE_SIZE, filter);
            if (generation !== guideGeneration.current) return;
            const items = response.Items || [];
            guideCount.current += items.length;
            setGuideTotal(response.TotalRecordCount ?? guideCount.current);
            setGuideChannels(current => current.concat(items.filter(item => !current.some(existing => existing.Id === item.Id))));
            if (!items.length) setGuideTotal(guideCount.current);
        } catch (error) {
            setGuideError(liveError(error, 'The guide could not load.'));
        } finally {
            guideLoadingMore.current = false;
        }
    };

    useEffect(() => {
        if (tab !== 'now') return;
        let cancelled = false;
        setNowLoading(true);
        setNowError('');
        void api.getAiringPrograms().then(async response => {
            if (cancelled) return;
            const items = response.Items || [];
            setAiring(items);
            const ids = Array.from(new Set(items.map(item => item.ChannelId).filter((id): id is string => Boolean(id))));
            if (!ids.length) {
                setUpcoming([]);
                return;
            }
            const start = Date.now();
            const follow = await api.getLivePrograms(ids, isoTime(start), isoTime(start + GUIDE_CHUNK_MS), 400);
            if (!cancelled) setUpcoming(follow.Items || []);
        }).catch(error => {
            if (!cancelled) setNowError(liveError(error, 'On Now could not load.'));
        }).finally(() => {
            if (!cancelled) setNowLoading(false);
        });
        return () => { cancelled = true; };
    }, [ api, tab ]);

    useEffect(() => {
        if (tab !== 'channels' || directory.length) return;
        let cancelled = false;
        setDirectoryLoading(true);
        setDirectoryError('');
        void api.getLiveChannels(0, CHANNEL_PAGE_SIZE, 'all').then(response => {
            if (cancelled) return;
            const items = response.Items || [];
            directoryCount.current = items.length;
            setDirectory(items);
            setDirectoryTotal(response.TotalRecordCount ?? items.length);
        }).catch(error => {
            if (!cancelled) setDirectoryError(liveError(error, 'Channels could not load.'));
        }).finally(() => {
            if (!cancelled) setDirectoryLoading(false);
        });
        return () => { cancelled = true; };
    }, [ api, tab, directory.length ]);

    useEffect(() => {
        if (tab !== 'dvr') return;
        let cancelled = false;
        setDvrLoading(true);
        setDvrError('');
        void Promise.all([ api.getLiveTimers(), api.getSeriesTimers(), api.getRecordings() ]).then(([ nextTimers, nextSeries, nextRecordings ]) => {
            if (cancelled) return;
            setTimers(nextTimers);
            setSeriesTimers(nextSeries);
            setRecordings(nextRecordings.Items || []);
        }).catch(error => {
            if (!cancelled) setDvrError(liveError(error, 'Recordings could not load.'));
        }).finally(() => {
            if (!cancelled) setDvrLoading(false);
        });
        return () => { cancelled = true; };
    }, [ api, tab, dvrTick ]);

    useEffect(() => {
        if (!compact || tab !== 'guide' || !orderedGuide.length) return;
        void ensurePrograms(orderedGuide.map(channel => channel.Id), range.start, range.end);
    }, [ compact, tab, orderedGuide, range.start, range.end ]);

    useEffect(() => {
        if (!expandedId) return;
        let cancelled = false;
        setDayPrograms([]);
        void api.getLivePrograms([ expandedId ], isoTime(dayStart), isoTime(dayStart + 86400000), 300).then(response => {
            if (!cancelled) setDayPrograms((response.Items || []).slice().sort((a, b) => Date.parse(a.StartDate || '') - Date.parse(b.StartDate || '')));
        }).catch(error => {
            if (!cancelled) setActionError(liveError(error, 'The channel schedule could not load.'));
        });
        return () => { cancelled = true; };
    }, [ api, expandedId, dayStart ]);

    useEffect(() => {
        if (!sheet) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' && event.key !== 'Backspace' && event.key !== 'Back' && event.key !== 'BrowserBack' && event.key !== 'GoBack' && event.keyCode !== 461 && event.keyCode !== 10009) return;
            event.preventDefault();
            event.stopPropagation();
            setSheet(null);
        };
        window.addEventListener('keydown', onKey, true);
        sheetRef.current?.querySelector<HTMLElement>('[data-focusable="true"]')?.focus();
        return () => window.removeEventListener('keydown', onKey, true);
    }, [ sheet ]);

    useEffect(() => {
        if (tab !== 'guide' && tab !== 'channels') return;
        const onKey = (event: KeyboardEvent) => {
            if (sheet) return;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
            if (!/^[0-9]$/.test(event.key)) return;
            event.preventDefault();
            digitBuffer.current = `${digitBuffer.current}${event.key}`.slice(-4);
            setDigits(digitBuffer.current);
            if (digitTimer.current) window.clearTimeout(digitTimer.current);
            const flush = () => {
                const list = tab === 'channels' ? orderedDirectory : orderedGuide;
                const index = matchChannelIndex(list, digitBuffer.current);
                const channel = index >= 0 ? list[index] : null;
                digitBuffer.current = '';
                setDigits('');
                if (!channel) return;
                if (tab === 'guide' && !compact) setJump({ id: channel.Id, nonce: Date.now() });
                else document.getElementById(tab === 'channels' ? `live-directory-${channel.Id}` : `live-mobile-${channel.Id}`)?.focus();
            };
            if (digitBuffer.current.length >= 4) flush();
            else digitTimer.current = window.setTimeout(flush, 1200);
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            if (digitTimer.current) window.clearTimeout(digitTimer.current);
        };
    }, [ tab, sheet, compact, orderedGuide, orderedDirectory ]);

    const toggleFavorite = async (channel: MediaItem) => {
        const next = !channel.UserData?.IsFavorite;
        const apply = (items: MediaItem[]) => items.map(item => item.Id === channel.Id ? withFavorite(item, next) : item);
        setGuideChannels(current => apply(current));
        setDirectory(current => apply(current));
        try {
            await api.setFavorite(channel.Id, next);
        } catch (error) {
            const revert = (items: MediaItem[]) => items.map(item => item.Id === channel.Id ? withFavorite(item, !next) : item);
            setGuideChannels(current => revert(current));
            setDirectory(current => revert(current));
            setActionError(liveError(error, 'Favorites could not be updated.'));
        }
    };

    const tune = (channel: MediaItem, program?: MediaItem) => {
        onPlay({
            ...channel,
            Id: channel.Id,
            Type: 'TvChannel',
            Name: program?.Name ? `${channel.Name}: ${program.Name}` : channel.Name
        });
    };

    const record = async (series: boolean) => {
        if (!sheet?.program.Id) return;
        setRecordingBusy(true);
        setActionError('');
        try {
            await api.createLiveTimer(sheet.program.Id, series);
            setDvrTick(value => value + 1);
            setSheet(current => current ? {
                ...current,
                program: series ? { ...current.program, SeriesTimerId: current.program.SeriesTimerId || 'pending' } : { ...current.program, TimerId: current.program.TimerId || 'pending' }
            } : current);
        } catch (error) {
            setActionError(liveError(error, 'Recording is not available for this account.'));
        } finally {
            setRecordingBusy(false);
        }
    };

    const loadMoreDirectory = async () => {
        if (directoryLoading || directoryCount.current >= directoryTotal) return;
        setDirectoryLoading(true);
        try {
            const response = await api.getLiveChannels(directoryCount.current, CHANNEL_PAGE_SIZE, 'all');
            const items = response.Items || [];
            directoryCount.current += items.length;
            setDirectoryTotal(response.TotalRecordCount ?? directoryCount.current);
            setDirectory(current => current.concat(items.filter(item => !current.some(existing => existing.Id === item.Id))));
            if (!items.length) setDirectoryTotal(directoryCount.current);
        } catch (error) {
            setDirectoryError(liveError(error, 'Channels could not load.'));
        } finally {
            setDirectoryLoading(false);
        }
    };

    const shift = (channelId: string, direction: -1 | 1) => {
        const next = moveChannel(order, orderedDirectory.map(channel => channel.Id), channelId, direction);
        setOrder(next);
        writeChannelOrder(userId, next);
    };

    const currentProgram = (channel: MediaItem): MediaItem | undefined => {
        if (channel.CurrentProgram?.Name) return channel.CurrentProgram;
        return (programs[channel.Id] || []).find(program => {
            const start = Date.parse(program.StartDate || '');
            const end = Date.parse(program.EndDate || '');
            return Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
        });
    };

    return <section class="live-page">
        <div class="live-tabs" role="tablist" aria-label="Live TV">
            {TABS.map(item => <button type="button" role="tab" aria-selected={tab === item.id ? 'true' : 'false'} data-focusable="true" class={tab === item.id ? 'live-tab active' : 'live-tab'} key={item.id} onClick={() => onTab(item.id)}>{item.label}</button>)}
        </div>
        {actionError && !sheet && <p class="notice error" role="alert">{actionError}</p>}
        {digits && tab !== 'guide' && <p class="live-digits" aria-live="polite">Channel {digits}</p>}

        {tab === 'now' && <div class="live-now">
            {nowError && <p class="notice error" role="alert">{nowError}</p>}
            {nowLoading && !airing.length && <p class="live-empty">Loading what is on now…</p>}
            {!nowLoading && !nowError && !groups.length && <p class="live-empty">Nothing is airing in the guide right now.</p>}
            {groups.map(group => <section class="live-group" key={group.id}>
                <h2>{group.title}</h2>
                <div class="live-cards">
                    {group.items.map(program => {
                        const channel = channelFromProgram(program);
                        const following = program.ChannelId ? nextByChannel[program.ChannelId] : undefined;
                        const progress = airingProgress(program.StartDate, program.EndDate, now);
                        return <article class="live-card" key={program.Id}>
                            <button type="button" class="live-card-main live-card-overlay" data-focusable="true" onClick={() => setSheet({ program, channel })}>
                                <span class="live-card-art"><LiveThumb api={api} item={program.ImageTags ? program : channel} width={640} /></span>
                                <span class="live-card-scrim" />
                                <span class="live-card-copy">
                                    <span class="live-card-channel">{channel.ChannelNumber ? `${channel.ChannelNumber} · ` : ''}{channel.Name}</span>
                                    <strong>{program.Name}</strong>
                                    <span class="live-progress" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>
                                    <span class="live-card-meta">{formatRemaining(program.EndDate, now)}{categoryLabel(program) ? ` · ${categoryLabel(program)}` : ''}</span>
                                    {following && <span class="live-up-next">Up next: {following.Name}{following.StartDate ? ` · ${formatClock(Date.parse(following.StartDate))}` : ''}</span>}
                                </span>
                            </button>
                        </article>;
                    })}
                </div>
            </section>)}
        </div>}

        {tab === 'guide' && !compact && <LiveGuide
            api={api}
            channels={orderedGuide}
            programsByChannel={programs}
            windowStart={range.start}
            windowEnd={range.end}
            dayStart={dayStart}
            now={now}
            days={days}
            filter={filter}
            loading={guideLoading}
            error={guideError}
            jumpId={jump.id}
            jumpNonce={jump.nonce}
            digits={digits}
            sheetOpen={Boolean(sheet)}
            onDay={setDayStart}
            onFilter={setFilter}
            onExtend={direction => setRange(current => {
                const dayEnd = dayStart + 86400000;
                if (direction === 'forward') {
                    if (current.end >= dayEnd) return current;
                    return { ...current, end: Math.min(dayEnd, current.end + GUIDE_CHUNK_MS) };
                }
                if (current.start <= dayStart) return current;
                return { ...current, start: Math.max(dayStart, current.start - GUIDE_CHUNK_MS) };
            })}
            onVisible={(start, end) => {
                if (end >= orderedGuide.length - 2 && orderedGuide.length < guideTotal) void loadMoreGuide();
                void ensurePrograms(orderedGuide.slice(start, end).map(channel => channel.Id), range.start, range.end);
            }}
            onToggleFavorite={channel => void toggleFavorite(channel)}
            onOpenProgram={(program, channel) => { setActionError(''); setSheet({ program, channel }); }}
            onTune={channel => tune(channel)}
        />}

        {tab === 'guide' && compact && <div class="live-mobile">
            <div class="live-toolbar">
                <div class="live-pills" role="group" aria-label="Guide day">
                    {days.map(day => <button type="button" data-focusable="true" class={day.start === dayStart ? 'live-pill active' : 'live-pill'} key={day.start} onClick={() => setDayStart(day.start)}>{day.label}</button>)}
                </div>
                <select class="live-filter" aria-label="Channel filter" value={filter} onChange={event => setFilter((event.target as HTMLSelectElement).value as LiveChannelFilter)}>
                    <option value="all">All channels</option>
                    <option value="favorites">Favorites</option>
                    <option value="sports">Sports</option>
                    <option value="news">News</option>
                    <option value="movies">Movies</option>
                    <option value="kids">Kids</option>
                </select>
            </div>
            {guideError && <p class="notice error" role="alert">{guideError}</p>}
            {guideLoading && !orderedGuide.length && <p class="live-empty">Loading channels…</p>}
            {!guideLoading && !orderedGuide.length && <p class="live-empty">No channels are available for this filter.</p>}
            <ul class="live-now-next">
                {orderedGuide.map(channel => {
                    const program = currentProgram(channel);
                    const following = nextByChannel[channel.Id];
                    const open = expandedId === channel.Id;
                    return <li key={channel.Id}>
                        <button type="button" class="live-now-next-card" id={`live-mobile-${channel.Id}`} data-focusable="true" aria-expanded={open ? 'true' : 'false'} onClick={() => setExpandedId(open ? '' : channel.Id)}>
                            <span class="live-logo"><LiveThumb api={api} item={channel} width={96} /></span>
                            <span class="live-now-next-copy">
                                <span class="live-channel-name">{channel.ChannelNumber ? `${channel.ChannelNumber} ` : ''}{channel.Name}</span>
                                <span class="live-bar"><span class="live-bar-label">Now</span><span>{program?.Name || 'No program data available'}</span>{program && <span class="live-progress" aria-hidden="true"><span style={{ width: `${Math.round(airingProgress(program.StartDate, program.EndDate, now) * 100)}%` }} /></span>}{program && <span class="live-pill-tag">{categoryLabel(program)}</span>}</span>
                                <span class="live-bar next"><span class="live-bar-label">Next</span><span>{following?.Name || 'Up next is not listed'}</span>{following?.StartDate && <span class="muted">{formatClock(Date.parse(following.StartDate))}</span>}</span>
                            </span>
                        </button>
                        {open && <div class="live-day-schedule">
                            {dayPrograms.map(item => <button type="button" class="live-day-item" data-focusable="true" key={item.Id} onClick={() => setSheet({ program: item, channel })}>
                                <span>{formatRange(item.StartDate, item.EndDate)}</span>
                                <strong>{item.Name}</strong>
                            </button>)}
                            {!dayPrograms.length && <p class="muted">No program data available</p>}
                        </div>}
                    </li>;
                })}
            </ul>
            {orderedGuide.length < guideTotal && <button type="button" class="button secondary" data-focusable="true" onClick={() => void loadMoreGuide()}>Load more channels</button>}
        </div>}

        {tab === 'channels' && <div class="live-directory">
            {directoryError && <p class="notice error" role="alert">{directoryError}</p>}
            {directoryLoading && !orderedDirectory.length && <p class="live-empty">Loading channels…</p>}
            {!directoryLoading && !directoryError && !orderedDirectory.length && <p class="live-empty">No channels are available.</p>}
            <ul class="live-channel-list">
                {orderedDirectory.map((channel, index) => <li key={channel.Id}>
                    <button type="button" class="live-directory-tune" id={`live-directory-${channel.Id}`} data-focusable="true" onClick={() => tune(channel, channel.CurrentProgram)}>
                        <span class="live-number">{channel.ChannelNumber || '—'}</span>
                        <span class="live-logo"><LiveThumb api={api} item={channel} width={96} /></span>
                        <span>
                            <span class="live-channel-name">{channel.Name}</span>
                            {channel.CurrentProgram?.Name && <span class="muted">{channel.CurrentProgram.Name}</span>}
                        </span>
                    </button>
                    <button type="button" class={channel.UserData?.IsFavorite ? 'live-star on' : 'live-star'} data-focusable="true" aria-pressed={channel.UserData?.IsFavorite ? 'true' : 'false'} aria-label={channel.UserData?.IsFavorite ? `Remove ${channel.Name} from favorites` : `Add ${channel.Name} to favorites`} onClick={() => void toggleFavorite(channel)}>{channel.UserData?.IsFavorite ? '★' : '☆'}</button>
                    <button type="button" class="live-move" data-focusable="true" aria-label={`Move ${channel.Name} earlier`} disabled={index === 0} onClick={() => shift(channel.Id, -1)}>↑</button>
                    <button type="button" class="live-move" data-focusable="true" aria-label={`Move ${channel.Name} later`} disabled={index === orderedDirectory.length - 1} onClick={() => shift(channel.Id, 1)}>↓</button>
                </li>)}
            </ul>
            {orderedDirectory.length < directoryTotal && <button type="button" class="button secondary" data-focusable="true" onClick={() => void loadMoreDirectory()}>{directoryLoading ? 'Loading…' : 'Load more channels'}</button>}
        </div>}

        {tab === 'dvr' && <div class="live-dvr">
            {dvrError && <p class="notice error" role="alert">{dvrError}</p>}
            {dvrLoading && !timers.length && !seriesTimers.length && !recordings.length && <p class="live-empty">Loading recordings…</p>}
            <section>
                <h2>Scheduled</h2>
                {!timers.length && !dvrLoading && <p class="muted">No upcoming recordings.</p>}
                <ul class="live-dvr-list">
                    {timers.map(timer => <li key={timer.Id}>
                        <div><strong>{timer.Name || 'Recording'}</strong><span class="muted">{timer.ChannelName}{timer.StartDate ? ` · ${formatRange(timer.StartDate, timer.EndDate)}` : ''}{timer.Status ? ` · ${timer.Status}` : ''}</span></div>
                        <button type="button" class="button secondary" data-focusable="true" onClick={() => void api.cancelLiveTimer(timer.Id).then(() => setDvrTick(value => value + 1)).catch(error => setDvrError(liveError(error, 'Recording is not available for this account.')))}>Cancel</button>
                    </li>)}
                </ul>
            </section>
            <section>
                <h2>Series rules</h2>
                {!seriesTimers.length && !dvrLoading && <p class="muted">No series recording rules.</p>}
                <ul class="live-dvr-list">
                    {seriesTimers.map(timer => <li key={timer.Id}>
                        <div><strong>{timer.Name || 'Series recording'}</strong><span class="muted">{timer.ChannelName}</span></div>
                        <button type="button" class="button secondary" data-focusable="true" onClick={() => void api.cancelSeriesTimer(timer.Id).then(() => setDvrTick(value => value + 1)).catch(error => setDvrError(liveError(error, 'Recording is not available for this account.')))}>Cancel series</button>
                    </li>)}
                </ul>
            </section>
            <section>
                <h2>Recordings</h2>
                {!recordings.length && !dvrLoading && <p class="muted">No recordings yet.</p>}
                <ul class="live-dvr-list">
                    {recordings.map(item => <li key={item.Id}>
                        <button type="button" class="live-recording" data-focusable="true" onClick={() => onPlay(item)}><LiveThumb api={api} item={item} width={160} /><span><strong>{item.Name}</strong>{item.StartDate && <span class="muted">{formatRange(item.StartDate, item.EndDate)}</span>}</span></button>
                        <button type="button" class="button secondary" data-focusable="true" onClick={() => void api.deleteRecording(item.Id).then(() => setDvrTick(value => value + 1)).catch(error => setDvrError(liveError(error, 'Recording is not available for this account.')))}>Delete</button>
                    </li>)}
                </ul>
            </section>
        </div>}

        {sheet && <div class="live-sheet-backdrop" onClick={() => setSheet(null)}>
            <aside class="live-sheet" role="dialog" aria-modal="true" aria-label={sheet.program.Name} ref={sheetRef} onClick={event => event.stopPropagation()}>
                <ProgramSummary program={sheet.program} channel={sheet.channel} now={now} />
                {actionError && <p class="notice error" role="alert">{actionError}</p>}
                <div class="live-actions">
                    <button type="button" class="button primary" data-focusable="true" onClick={() => tune(sheet.channel, sheet.program)}>Watch Now</button>
                    <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void record(false)}>Record Episode</button>
                    <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void record(true)}>Record Series</button>
                    <button type="button" class="button secondary" data-focusable="true" onClick={() => setSheet(null)}>Close</button>
                </div>
            </aside>
        </div>}
    </section>;
}
