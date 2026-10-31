import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import { RequestGeneration } from './account-generation';
import { useDialogFocus } from './dialog-focus';
import { userMessage } from './ui-errors';
import { GuideToolbar, LiveGuide, LiveThumb, ProgramSummary } from './live-guide';
import { CHANNEL_PAGE_SIZE, GUIDE_CHUNK_MS, airingProgress, categoryLabel, channelFromProgram, chunkStarts, currentProgramFor, directionalFocusIndex, formatClock, formatRange, formatRemaining, groupOnNow, guideDays, initialGuideRange, isAiring, isoTime, matchChannelIndex, mergePrograms, moveChannel, orderChannels, peekLiveView, programRecordingState, readChannelOrder, rememberLiveView, startOfLocalDay, timerDraft, timerInProgress, timerUpdatePayload, upNextByChannel, validateTimerDraft, withFavorite, withRecordingPending, writeChannelOrder, type FocusRect, type GuideDay, type GuideDirection, type TimerDraft } from './live-model';
import type { LiveChannelFilter, LiveTab, LiveTimer, MediaItem } from './types';
import { t } from './i18n';

const TABS: Array<{ id: LiveTab; label: string }> = [
    { id: 'now', label: t('On Now') },
    { id: 'guide', label: t('Guide') },
    { id: 'channels', label: t('Channels') },
    { id: 'dvr', label: 'DVR' }
];

function liveError(error: unknown, denied: string): string {
    if ((error as { status?: number } | null)?.status === 403) return denied;
    return userMessage(error);
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
    const restored = useRef(peekLiveView(userId, Date.now())).current;
    const restoreCount = useRef(restored?.channelCount || 0);
    const skipRangeReset = useRef(Boolean(restored));
    const [ now, setNow ] = useState(() => Date.now());
    const [ order, setOrder ] = useState<string[]>(() => readChannelOrder(userId));
    const [ filter, setFilter ] = useState<LiveChannelFilter>(restored?.filter || 'all');
    const [ days, setDays ] = useState<GuideDay[]>(() => guideDays(null, Date.now()));
    const [ dayStart, setDayStart ] = useState(() => restored?.dayStart ?? startOfLocalDay(Date.now()));
    const [ range, setRange ] = useState(() => restored?.range ?? initialGuideRange(startOfLocalDay(Date.now()), Date.now()));
    const [ editor, setEditor ] = useState<{ series: boolean; timer: LiveTimer; draft: TimerDraft; saving: boolean; error: string } | null>(null);
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
    const [ recordingsTotal, setRecordingsTotal ] = useState(0);
    const [ recordingsMore, setRecordingsMore ] = useState(false);
    const [ dvrLoading, setDvrLoading ] = useState(false);
    const [ dvrError, setDvrError ] = useState('');
    const [ dvrTick, setDvrTick ] = useState(0);
    const [ sheet, setSheet ] = useState<{ program: MediaItem; channel: MediaItem } | null>(null);
    const [ actionError, setActionError ] = useState('');
    const [ favoriteStatus, setFavoriteStatus ] = useState('');
    const [ favoriteUndo, setFavoriteUndo ] = useState<{ channel: MediaItem; favorite: boolean } | null>(null);
    const [ favoriteBusyId, setFavoriteBusyId ] = useState('');
    const [ recordingBusy, setRecordingBusy ] = useState(false);
    const [ expandedId, setExpandedId ] = useState('');
    const [ dayPrograms, setDayPrograms ] = useState<MediaItem[]>([]);
    const [ jump, setJump ] = useState({ id: restored?.channelId || '', nonce: restored ? 1 : 0 });
    const [ digits, setDigits ] = useState('');
    const guideCount = useRef(0);
    const guideGeneration = useRef(new RequestGeneration()).current;
    const programGeneration = useRef(new RequestGeneration()).current;
    const directoryCount = useRef(0);
    const loadedChunks = useRef(new Set<string>());
    const programQueue = useRef<MediaItem[]>([]);
    const programFrame = useRef(0);
    const guideLoadingMore = useRef(false);
    const digitBuffer = useRef('');
    const digitTimer = useRef<number>();
    const sheetRef = useRef<HTMLElement>(null);
    const sheetOrigin = useRef<HTMLElement | null>(null);
    const sheetOpen = Boolean(sheet);

    useLayoutEffect(() => {
        guideGeneration.begin();
        guideLoadingMore.current = false;
    }, [ api, tab, filter ]);

    useLayoutEffect(() => {
        programGeneration.begin();
        if (programFrame.current) window.cancelAnimationFrame(programFrame.current);
        programFrame.current = 0;
        programQueue.current = [];
    }, [ api, tab, filter, dayStart ]);

    const openSheet = (program: MediaItem, channel: MediaItem, origin: HTMLElement) => {
        sheetOrigin.current = origin;
        setActionError('');
        setSheet({ program, channel });
    };

    const closeSheet = () => {
        const origin = sheetOrigin.current;
        sheetOrigin.current = null;
        setSheet(null);
        if (origin) window.requestAnimationFrame(() => {
            if (origin.isConnected) origin.focus();
        });
    };
    const editorRef = useRef<HTMLElement>(null);
    useDialogFocus(sheetRef, Boolean(sheet), closeSheet, { initial: '[data-focusable="true"]' });
    useDialogFocus(editorRef, Boolean(editor), () => setEditor(current => current?.saving ? current : null), { initial: 'input, select' });

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

    const [ snapshotTick, setSnapshotTick ] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => {
            setNow(Date.now());
            setSnapshotTick(tick => tick + 1);
        }, 60000);
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
        if (skipRangeReset.current) {
            skipRangeReset.current = false;
            return;
        }
        setRange(initialGuideRange(dayStart, Date.now()));
        setExpandedId('');
    }, [ dayStart ]);

    useEffect(() => {
        if (tab !== 'guide') return;
        const generation = guideGeneration.current();
        loadedChunks.current = new Set();
        guideCount.current = 0;
        setPrograms({});
        setGuideChannels([]);
        setGuideLoading(true);
        setGuideError('');
        const limit = Math.max(CHANNEL_PAGE_SIZE, restoreCount.current);
        restoreCount.current = 0;
        void api.getLiveChannels(0, limit, filter).then(response => {
            if (!guideGeneration.isCurrent(generation)) return;
            const items = response.Items || [];
            guideCount.current = items.length;
            setGuideChannels(items);
            setGuideTotal(response.TotalRecordCount ?? items.length);
        }).catch(error => {
            if (guideGeneration.isCurrent(generation)) setGuideError(liveError(error, t('The guide could not load.')));
        }).finally(() => {
            if (guideGeneration.isCurrent(generation)) setGuideLoading(false);
        });
    }, [ api, tab, filter ]);

    const queuePrograms = (items: MediaItem[], generation: number) => {
        if (!programGeneration.isCurrent(generation)) return;
        if (!items.length) return;
        programQueue.current = programQueue.current.concat(items);
        if (programFrame.current) return;
        programFrame.current = window.requestAnimationFrame(() => {
            programFrame.current = 0;
            const buffered = programQueue.current;
            programQueue.current = [];
            if (buffered.length && programGeneration.isCurrent(generation)) setPrograms(current => mergePrograms(current, buffered));
        });
    };

    const ensurePrograms = async (ids: string[], start: number, end: number) => {
        const generation = programGeneration.current();
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
                queuePrograms(response.Items || [], generation);
            } catch (error) {
                if (!programGeneration.isCurrent(generation)) return;
                job.ids.forEach(id => loadedChunks.current.delete(`${id}:${job.chunk}`));
                setGuideError(liveError(error, t('The guide could not load.')));
            }
        }));
    };

    const loadMoreGuide = async () => {
        if (guideLoadingMore.current || guideCount.current >= guideTotal) return;
        guideLoadingMore.current = true;
        const generation = guideGeneration.current();
        try {
            const response = await api.getLiveChannels(guideCount.current, CHANNEL_PAGE_SIZE, filter);
            if (!guideGeneration.isCurrent(generation)) return;
            const items = response.Items || [];
            guideCount.current += items.length;
            setGuideTotal(response.TotalRecordCount ?? guideCount.current);
            setGuideChannels(current => current.concat(items.filter(item => !current.some(existing => existing.Id === item.Id))));
            if (!items.length) setGuideTotal(guideCount.current);
        } catch (error) {
            if (guideGeneration.isCurrent(generation)) setGuideError(liveError(error, t('The guide could not load.')));
        } finally {
            if (guideGeneration.isCurrent(generation)) guideLoadingMore.current = false;
        }
    };

    const [ airingTotal, setAiringTotal ] = useState(0);
    const [ airingMore, setAiringMore ] = useState(false);
    useEffect(() => {
        if (tab !== 'now') return;
        let cancelled = false;
        setNowLoading(true);
        setNowError('');
        void api.getAiringPrograms().then(async response => {
            if (cancelled) return;
            const items = response.Items || [];
            setAiring(items);
            setAiringTotal(response.TotalRecordCount ?? items.length);
            const ids = Array.from(new Set(items.map(item => item.ChannelId).filter((id): id is string => Boolean(id))));
            if (!ids.length) {
                setUpcoming([]);
                return;
            }
            const start = Date.now();
            const follow = await api.getLivePrograms(ids, isoTime(start), isoTime(start + GUIDE_CHUNK_MS), 400);
            if (!cancelled) setUpcoming(follow.Items || []);
        }).catch(error => {
            if (!cancelled) setNowError(liveError(error, t('On Now could not load.')));
        }).finally(() => {
            if (!cancelled) setNowLoading(false);
        });
        return () => { cancelled = true; };
    }, [ api, tab, snapshotTick ]);

    const loadMoreAiring = async () => {
        if (airingMore || airing.length >= airingTotal) return;
        setAiringMore(true);
        try {
            const response = await api.getAiringPrograms(80, airing.length);
            setAiring(current => current.concat((response.Items || []).filter(item => !current.some(existing => existing.Id === item.Id))));
            setAiringTotal(response.TotalRecordCount ?? airing.length);
        } catch (error) {
            setNowError(liveError(error, t('On Now could not load.')));
        } finally {
            setAiringMore(false);
        }
    };

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
            if (!cancelled) setDirectoryError(liveError(error, t('Channels could not load.')));
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
            setRecordingsTotal(nextRecordings.TotalRecordCount ?? (nextRecordings.Items || []).length);
        }).catch(error => {
            if (!cancelled) setDvrError(liveError(error, t('Recordings could not load.')));
        }).finally(() => {
            if (!cancelled) setDvrLoading(false);
        });
        return () => { cancelled = true; };
    }, [ api, tab, dvrTick ]);

    useEffect(() => {
        if (!compact || tab !== 'guide' || !restored?.channelId || !jump.id) return;
        const target = document.getElementById(`live-mobile-${jump.id}`);
        if (!target) return;
        target.scrollIntoView({ block: 'center' });
        target.focus();
        setJump({ id: '', nonce: 0 });
    }, [ compact, tab, orderedGuide ]);

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
            if (!cancelled) setActionError(liveError(error, t('The channel schedule could not load.')));
        });
        return () => { cancelled = true; };
    }, [ api, expandedId, dayStart ]);

    useEffect(() => {
        if (!sheetOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Back' || event.key === 'BrowserBack' || event.key === 'GoBack' || event.keyCode === 461 || event.keyCode === 10009) {
                event.preventDefault();
                event.stopPropagation();
                closeSheet();
                return;
            }
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            const direction: GuideDirection = event.key;
            event.preventDefault();
            event.stopPropagation();
            const dialog = sheetRef.current;
            const controls = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('[data-focusable="true"]:not(:disabled)')) : [];
            const active = document.activeElement;
            const currentIndex = active instanceof HTMLElement ? controls.indexOf(active) : -1;
            if (currentIndex < 0) {
                controls[0]?.focus();
                return;
            }
            const rectangles: FocusRect[] = controls.map(control => {
                const rect = control.getBoundingClientRect();
                return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            });
            const nextIndex = directionalFocusIndex(rectangles, currentIndex, direction);
            if (nextIndex !== null) controls[nextIndex].focus();
        };
        window.addEventListener('keydown', onKey, true);
        sheetRef.current?.querySelector<HTMLElement>('[data-focusable="true"]')?.focus();
        return () => window.removeEventListener('keydown', onKey, true);
    }, [ sheetOpen ]);

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

    const applyFavorite = (channelId: string, favorite: boolean) => {
        const apply = (items: MediaItem[]) => items.map(item => item.Id === channelId ? withFavorite(item, favorite) : item);
        setGuideChannels(current => apply(current));
        setDirectory(current => apply(current));
    };

    const saveFavorite = async (channel: MediaItem, favorite: boolean, previousFavorite: boolean): Promise<boolean> => {
        if (favoriteBusyId) return false;
        setFavoriteBusyId(channel.Id);
        setActionError('');
        applyFavorite(channel.Id, favorite);
        try {
            const userData = await api.setFavorite(channel.Id, favorite);
            if (typeof userData?.IsFavorite === 'boolean' && userData.IsFavorite !== favorite) applyFavorite(channel.Id, userData.IsFavorite);
            return true;
        } catch (error) {
            applyFavorite(channel.Id, previousFavorite);
            setActionError(liveError(error, t('Favorites could not be updated.')));
            return false;
        } finally {
            setFavoriteBusyId('');
        }
    };

    const toggleFavorite = async (channel: MediaItem) => {
        const previousFavorite = channel.UserData?.IsFavorite === true;
        const next = !previousFavorite;
        setFavoriteUndo(null);
        setFavoriteStatus(next ? t('Adding {0} to favorites…', channel.Name) : t('Removing {0} from favorites…', channel.Name));
        const saved = await saveFavorite(channel, next, previousFavorite);
        setFavoriteStatus(saved ? t(next ? 'Added {0} to favorites.' : 'Removed {0} from favorites.', channel.Name) : '');
        if (saved) setFavoriteUndo({ channel, favorite: previousFavorite });
    };

    const undoFavorite = async () => {
        const undo = favoriteUndo;
        if (!undo || favoriteBusyId) return;
        setFavoriteStatus(undo.favorite ? t('Adding {0} to favorites…', undo.channel.Name) : t('Removing {0} from favorites…', undo.channel.Name));
        const saved = await saveFavorite(undo.channel, undo.favorite, !undo.favorite);
        if (saved) {
            setFavoriteUndo(null);
            setFavoriteStatus(t(undo.favorite ? 'Added {0} to favorites.' : 'Removed {0} from favorites.', undo.channel.Name));
        } else {
            setFavoriteStatus('');
        }
    };

    const tune = (channel: MediaItem, program?: MediaItem) => {
        rememberLiveView({ userId, dayStart, filter, range, channelCount: guideCount.current, channelId: channel.Id, savedAt: Date.now() });
        onPlay({
            ...channel,
            Id: channel.Id,
            Type: 'TvChannel',
            Name: program?.Name ? `${channel.Name}: ${program.Name}` : channel.Name
        });
    };

    const record = async (series: boolean) => {
        const programId = sheet?.program.Id;
        if (!programId) return;
        setRecordingBusy(true);
        setActionError('');
        try {
            await api.createLiveTimer(programId, series);
            setDvrTick(value => value + 1);
            setSheet(current => withRecordingPending(current, programId, series));
        } catch (error) {
            setActionError(liveError(error, t('Recording is not available for this account.')));
        } finally {
            setRecordingBusy(false);
        }
    };

    const updateSheetProgram = (change: Partial<MediaItem>) => setSheet(current => current ? { ...current, program: { ...current.program, ...change } } : current);

    const runDvrAction = async (action: () => Promise<void>, after?: () => void) => {
        setRecordingBusy(true);
        setActionError('');
        try {
            await action();
            after?.();
            setDvrTick(value => value + 1);
        } catch (error) {
            setActionError(liveError(error, t('Recording is not available for this account.')));
        } finally {
            setRecordingBusy(false);
        }
    };

    const openEditor = async (series: boolean, id: string) => {
        setActionError('');
        setDvrError('');
        try {
            const timer = series ? await api.getSeriesTimer(id) : await api.getLiveTimer(id);
            closeSheet();
            setEditor({ series, timer, draft: timerDraft(timer), saving: false, error: '' });
        } catch (error) {
            const message = liveError(error, t('Recording is not available for this account.'));
            if (sheet) setActionError(message);
            else setDvrError(message);
        }
    };

    const saveEditor = async () => {
        if (!editor) return;
        const problem = validateTimerDraft(editor.draft, editor.series);
        if (problem) {
            setEditor({ ...editor, error: problem });
            return;
        }
        setEditor({ ...editor, saving: true, error: '' });
        try {
            const payload = timerUpdatePayload(editor.timer, editor.draft, editor.series);
            await (editor.series ? api.updateSeriesTimer(payload) : api.updateLiveTimer(payload));
            setEditor(null);
            setDvrTick(value => value + 1);
        } catch (error) {
            setEditor(current => current ? { ...current, saving: false, error: liveError(error, t('Recording is not available for this account.')) } : current);
        }
    };

    const updateDraft = (change: Partial<TimerDraft>) => setEditor(current => current ? { ...current, draft: { ...current.draft, ...change }, error: '' } : current);

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
            setDirectoryError(liveError(error, t('Channels could not load.')));
        } finally {
            setDirectoryLoading(false);
        }
    };

    const shift = (channelId: string, direction: -1 | 1) => {
        const next = moveChannel(order, orderedDirectory.map(channel => channel.Id), channelId, direction);
        setOrder(next);
        writeChannelOrder(userId, next);
    };

    const recordingActions = (program: MediaItem) => {
        const state = programRecordingState(program);
        const airingNow = isAiring(program, now);
        if (state.kind === 'none') return <>
            <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void record(false)}>{t('Record Episode')}</button>
            {state.series && <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void record(true)}>{t('Record Series')}</button>}
        </>;
        if (state.pending) return <span class="muted">{t('Recording scheduled.')}</span>;
        if (state.kind === 'episode') return <>
            <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void openEditor(false, state.timerId)}>{t('Edit recording')}</button>
            <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void runDvrAction(() => api.cancelLiveTimer(state.timerId), () => updateSheetProgram({ TimerId: undefined }))}>{airingNow ? t('Stop recording') : t('Cancel recording')}</button>
        </>;
        return <>
            <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void openEditor(true, state.seriesTimerId)}>{t('Edit series rule')}</button>
            {state.timerId && <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void runDvrAction(() => api.cancelLiveTimer(state.timerId || ''), () => updateSheetProgram({ TimerId: undefined }))}>{airingNow ? t('Stop this episode') : t('Skip this episode')}</button>}
            <button type="button" class="button secondary" data-focusable="true" disabled={recordingBusy} onClick={() => void runDvrAction(() => api.cancelSeriesTimer(state.seriesTimerId), () => updateSheetProgram({ SeriesTimerId: undefined, TimerId: undefined }))}>{t('Cancel series')}</button>
        </>;
    };

    const currentProgram = (channel: MediaItem): MediaItem | undefined =>
        currentProgramFor(channel, programs, now);

    return <section class="live-page">
        <div class="live-tabs" role="tablist" aria-label={t('Live TV')}>
            {TABS.map(item => <button type="button" role="tab" aria-selected={tab === item.id ? 'true' : 'false'} data-focusable="true" class={tab === item.id ? 'live-tab active' : 'live-tab'} key={item.id} onClick={() => onTab(item.id)}>{t(item.label)}</button>)}
        </div>
        {actionError && !sheet && <p class="notice error" role="alert">{actionError}</p>}
        {favoriteStatus && !sheet && <div class="live-favorite-notice" role="status"><span>{favoriteStatus}</span>{favoriteUndo && <button class="button secondary" data-focusable="true" type="button" disabled={Boolean(favoriteBusyId)} onClick={undoFavorite}>{t('Undo')}</button>}</div>}
        {digits && tab !== 'guide' && <p class="live-digits" aria-live="polite">{t('Channel {0}', digits)}</p>}

        {tab === 'now' && <div class="live-now">
            {nowError && <p class="notice error" role="alert">{nowError}</p>}
            {nowLoading && !airing.length && <p class="live-empty">{t('Loading what is on now…')}</p>}
            {!nowLoading && !nowError && !groups.length && <p class="live-empty">{t('Nothing is airing in the guide right now.')}</p>}
            {groups.map(group => <section class="live-group" key={group.id}>
                <h2>{t(group.title)}</h2>
                <div class="live-cards">
                    {group.items.map(program => {
                        const channel = channelFromProgram(program);
                        const following = program.ChannelId ? nextByChannel[program.ChannelId] : undefined;
                        const progress = airingProgress(program.StartDate, program.EndDate, now);
                        return <article class="live-card" key={program.Id}>
                            <button type="button" class="live-card-main live-card-overlay" data-focusable="true" onClick={event => openSheet(program, channel, event.currentTarget)}>
                                <span class="live-card-art"><LiveThumb api={api} item={program.ImageTags ? program : channel} width={640} /></span>
                                <span class="live-card-scrim" />
                                <span class="live-card-copy">
                                    <span class="live-card-channel">{channel.ChannelNumber ? `${channel.ChannelNumber} · ` : ''}{channel.Name}</span>
                                    <strong>{program.Name}</strong>
                                    <span class="live-progress" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>
                                    <span class="live-card-meta">{formatRemaining(program.EndDate, now)}{categoryLabel(program) ? ` · ${categoryLabel(program)}` : ''}</span>
                                    {following && <span class="live-up-next">{t('Up next: {0}{1}', following.Name, following.StartDate ? ` · ${formatClock(Date.parse(following.StartDate))}` : '')}</span>}
                                </span>
                            </button>
                        </article>;
                    })}
                </div>
            </section>)}
            {airing.length < airingTotal && <button type="button" class="button secondary" data-focusable="true" onClick={() => void loadMoreAiring()}>{airingMore ? t('Loading…') : t('Show more ({0} remaining)', airingTotal - airing.length)}</button>}
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
            favoriteBusyId={favoriteBusyId}
            onOpenProgram={openSheet}
            onTune={channel => tune(channel)}
        />}

        {tab === 'guide' && compact && <div class="live-mobile">
            <GuideToolbar days={days} dayStart={dayStart} digits={digits} filter={filter} onDay={setDayStart} onFilter={setFilter} onFocusChannels={() => document.querySelector<HTMLElement>('.live-now-next-card')?.focus()} />
            {guideError && <p class="notice error" role="alert">{guideError}</p>}
            {guideLoading && !orderedGuide.length && <p class="live-empty">{t('Loading channels…')}</p>}
            {!guideLoading && !orderedGuide.length && <p class="live-empty">{t('No channels are available for this filter.')}</p>}
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
                                <span class="live-bar"><span class="live-bar-label">{t('Now')}</span><span>{program?.Name || t('No program data available')}</span>{program && <span class="live-progress" aria-hidden="true"><span style={{ width: `${Math.round(airingProgress(program.StartDate, program.EndDate, now) * 100)}%` }} /></span>}{program && <span class="live-pill-tag">{categoryLabel(program)}</span>}</span>
                                <span class="live-bar next"><span class="live-bar-label">{t('Next')}</span><span>{following?.Name || t('Up next is not listed')}</span>{following?.StartDate && <span class="muted">{formatClock(Date.parse(following.StartDate))}</span>}</span>
                            </span>
                        </button>
                        <button type="button" class={channel.UserData?.IsFavorite ? 'live-star on live-mobile-star' : 'live-star live-mobile-star'} data-focusable="true" data-channel-id={channel.Id} aria-pressed={channel.UserData?.IsFavorite ? 'true' : 'false'} aria-label={channel.UserData?.IsFavorite ? t('Remove {0} from favorites', channel.Name) : t('Add {0} to favorites', channel.Name)} title={channel.UserData?.IsFavorite ? t('Remove {0} from favorites', channel.Name) : t('Add {0} to favorites', channel.Name)} disabled={Boolean(favoriteBusyId)} onClick={() => void toggleFavorite(channel)}>{channel.UserData?.IsFavorite ? '★' : '☆'}</button>
                        {open && <div class="live-day-schedule">
                            {dayPrograms.map(item => <button type="button" class="live-day-item" data-focusable="true" key={item.Id} onClick={event => openSheet(item, channel, event.currentTarget)}>
                                <span>{formatRange(item.StartDate, item.EndDate)}</span>
                                <strong>{item.Name}</strong>
                            </button>)}
                            {!dayPrograms.length && <p class="muted">{t('No program data available')}</p>}
                        </div>}
                    </li>;
                })}
            </ul>
            {orderedGuide.length < guideTotal && <button type="button" class="button secondary" data-focusable="true" onClick={() => void loadMoreGuide()}>{t('Load more channels')}</button>}
        </div>}

        {tab === 'channels' && <div class="live-directory">
            {directoryError && <p class="notice error" role="alert">{directoryError}</p>}
            <p class="muted">{t('Channel order is saved only in this browser on this device; other devices keep their own order. Favorites sync with your Jellyfin account.')}{' '}{order.length > 0 && <button type="button" class="button secondary live-reset-order" data-focusable="true" onClick={() => { setOrder([]); writeChannelOrder(userId, []); }}>{t('Reset order')}</button>}</p>
            {directoryLoading && !orderedDirectory.length && <p class="live-empty">{t('Loading channels…')}</p>}
            {!directoryLoading && !directoryError && !orderedDirectory.length && <p class="live-empty">{t('No channels are available.')}</p>}
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
                    <button type="button" class="live-move" data-focusable="true" aria-label={t('Move {0} earlier', channel.Name)} disabled={index === 0} onClick={() => shift(channel.Id, -1)}>↑</button>
                    <button type="button" class="live-move" data-focusable="true" aria-label={t('Move {0} later', channel.Name)} disabled={index === orderedDirectory.length - 1} onClick={() => shift(channel.Id, 1)}>↓</button>
                </li>)}
            </ul>
            {orderedDirectory.length < directoryTotal && <button type="button" class="button secondary" data-focusable="true" onClick={() => void loadMoreDirectory()}>{directoryLoading ? t('Loading…') : t('Load more channels')}</button>}
        </div>}

        {tab === 'dvr' && <div class="live-dvr">
            {dvrError && <p class="notice error" role="alert">{dvrError}</p>}
            {dvrLoading && !timers.length && !seriesTimers.length && !recordings.length && <p class="live-empty">{t('Loading recordings…')}</p>}
            <section>
                <h2>{t('Scheduled')}</h2>
                {!timers.length && !dvrLoading && <p class="muted">{t('No upcoming recordings.')}</p>}
                <ul class="live-dvr-list">
                    {timers.map(timer => <li key={timer.Id}>
                        <div><strong>{timer.Name || t('Recording')}</strong><span class="muted">{timer.ChannelName}{timer.StartDate ? ` · ${formatRange(timer.StartDate, timer.EndDate)}` : ''}{timer.Status ? ` · ${timer.Status}` : ''}</span></div>
                        <span class="live-dvr-actions">
                            <button type="button" class="button secondary" data-focusable="true" onClick={() => void openEditor(false, timer.Id)}>{t('Edit')}</button>
                            <button type="button" class="button secondary" data-focusable="true" onClick={() => void api.cancelLiveTimer(timer.Id).then(() => setDvrTick(value => value + 1)).catch(error => setDvrError(liveError(error, t('Recording is not available for this account.'))))}>{timerInProgress(timer, now) ? t('Stop recording') : t('Cancel')}</button>
                        </span>
                    </li>)}
                </ul>
            </section>
            <section>
                <h2>{t('Series rules')}</h2>
                {!seriesTimers.length && !dvrLoading && <p class="muted">{t('No series recording rules.')}</p>}
                <ul class="live-dvr-list">
                    {seriesTimers.map(timer => <li key={timer.Id}>
                        <div><strong>{timer.Name || t('Series recording')}</strong><span class="muted">{timer.RecordAnyChannel ? t('Any channel') : timer.ChannelName}{timer.RecordNewOnly ? t(' · New episodes only') : ''}{timer.KeepUpTo ? t(' · Keep {0}', timer.KeepUpTo) : ''}</span></div>
                        <span class="live-dvr-actions">
                            <button type="button" class="button secondary" data-focusable="true" onClick={() => void openEditor(true, timer.Id)}>{t('Edit')}</button>
                            <button type="button" class="button secondary" data-focusable="true" onClick={() => void api.cancelSeriesTimer(timer.Id).then(() => setDvrTick(value => value + 1)).catch(error => setDvrError(liveError(error, t('Recording is not available for this account.'))))}>{t('Cancel series')}</button>
                        </span>
                    </li>)}
                </ul>
            </section>
            <section>
                <h2>{t('Recordings')}</h2>
                {!recordings.length && !dvrLoading && <p class="muted">{t('No recordings yet.')}</p>}
                <ul class="live-dvr-list">
                    {recordings.map(item => <li key={item.Id}>
                        <button type="button" class="live-recording" data-focusable="true" onClick={() => onPlay(item)}><LiveThumb api={api} item={item} width={160} /><span><strong>{item.Name}</strong>{item.StartDate && <span class="muted">{formatRange(item.StartDate, item.EndDate)}</span>}</span></button>
                        <button type="button" class="button secondary" data-focusable="true" onClick={() => void api.deleteRecording(item.Id).then(() => setDvrTick(value => value + 1)).catch(error => setDvrError(liveError(error, t('Recording is not available for this account.'))))}>{t('Delete')}</button>
                    </li>)}
                </ul>
                {recordings.length < recordingsTotal && <button type="button" class="button secondary" data-focusable="true" onClick={async () => {
                    if (recordingsMore) return;
                    setRecordingsMore(true);
                    try {
                        const page = await api.getRecordings(recordings.length);
                        setRecordings(current => current.concat((page.Items || []).filter(item => !current.some(existing => existing.Id === item.Id))));
                        setRecordingsTotal(page.TotalRecordCount ?? recordings.length);
                    } catch (error) {
                        setDvrError(liveError(error, t('Recordings could not load.')));
                    } finally {
                        setRecordingsMore(false);
                    }
                }}>{recordingsMore ? t('Loading…') : t('Show more ({0} remaining)', recordingsTotal - recordings.length)}</button>}
            </section>
        </div>}

        {sheet && <div class="live-sheet-backdrop" onClick={event => { if (event.target === event.currentTarget) closeSheet(); }}>
            <aside class="live-sheet" role="dialog" aria-modal="true" aria-label={sheet.program.Name} ref={sheetRef} onClick={event => event.stopPropagation()}>
                <ProgramSummary program={sheet.program} channel={sheet.channel} now={now} />
                {actionError && <p class="notice error" role="alert">{actionError}</p>}
                <div class="live-actions">
                    <button type="button" class="button primary" data-focusable="true" onClick={() => tune(sheet.channel, sheet.program)}>{t('Watch Now')}</button>
                    {recordingActions(sheet.program)}
                    <button type="button" class="button secondary" data-focusable="true" onClick={closeSheet}>{t('Close')}</button>
                </div>
            </aside>
        </div>}

        {editor && <div class="live-sheet-backdrop" onClick={event => { if (event.target === event.currentTarget && !editor.saving) setEditor(null); }}>
            <aside ref={editorRef} class="live-sheet" role="dialog" aria-modal="true" aria-label={editor.series ? t('Edit series recording') : t('Edit recording')}>
                <h2>{editor.series ? t('Series recording') : t('Recording')}: {editor.timer.Name || t('Untitled')}</h2>
                {editor.error && <p class="notice error" role="alert">{editor.error}</p>}
                <form class="profile-form live-timer-form" onSubmit={event => { event.preventDefault(); void saveEditor(); }}>
                    <label>{t('Start early (minutes)')}<input data-focusable="true" type="number" min="0" max="240" step="1" value={editor.draft.prePaddingMinutes} onInput={event => updateDraft({ prePaddingMinutes: Number((event.currentTarget as HTMLInputElement).value) })} /></label>
                    <label>{t('Stop late (minutes)')}<input data-focusable="true" type="number" min="0" max="240" step="1" value={editor.draft.postPaddingMinutes} onInput={event => updateDraft({ postPaddingMinutes: Number((event.currentTarget as HTMLInputElement).value) })} /></label>
                    {editor.series && <>
                        <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={editor.draft.recordNewOnly} onChange={event => updateDraft({ recordNewOnly: (event.currentTarget as HTMLInputElement).checked })} />{' '}{t('Record new episodes only')}</label>
                        <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={editor.draft.recordAnyChannel} onChange={event => updateDraft({ recordAnyChannel: (event.currentTarget as HTMLInputElement).checked })} />{' '}{t('Record on any channel')}</label>
                        <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={editor.draft.recordAnyTime} onChange={event => updateDraft({ recordAnyTime: (event.currentTarget as HTMLInputElement).checked })} />{' '}{t('Record at any time')}</label>
                        <label>{t('Keep up to (episodes, 0 keeps all)')}<input data-focusable="true" type="number" min="0" max="1000" step="1" value={editor.draft.keepUpTo} onInput={event => updateDraft({ keepUpTo: Number((event.currentTarget as HTMLInputElement).value) })} /></label>
                    </>}
                    <div class="live-actions">
                        <button type="submit" class="button primary" data-focusable="true" disabled={editor.saving}>{editor.saving ? t('Saving…') : t('Save')}</button>
                        <button type="button" class="button secondary" data-focusable="true" disabled={editor.saving} onClick={() => setEditor(null)}>{t('Cancel')}</button>
                    </div>
                </form>
            </aside>
        </div>}
    </section>;
}
