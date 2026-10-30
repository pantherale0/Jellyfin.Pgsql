import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { tabbableWithin, useDialogFocus, virtualTabTarget } from './dialog-focus';
import { userMessage } from './ui-errors';
import { libraryGeometry } from './library-geometry';
import { JellyfinApi, peekCachedImage, releaseCachedImage, retainCachedImage } from './api';
import { activeFilterCount as countFilters, decadeYears, defaultLibraryQuery, librarySortOptions, splitValues, toggleValue } from './library-query';
import { cardImageType, currentMode, libraryModes } from './library-modes';
import { CollectionPicker, MediaRow, PlaylistPicker } from './detail-sections';
import { addToQueue, playNext, playQueue, queueable } from './play-queue';
import { actionTargets, batchMessage, bulkCapabilities, MAX_SELECTION, runBatch, selectAll, toggleSelection, type BulkAction } from './bulk-actions';
import { describeCard } from './media-labels';
import { applyUserDataChange, itemCapabilities, listsDirectChildren, peekLibraryBookmark, playedUserData, saveLibraryBookmark } from './catalog-model';
import type { LibraryFeature, LibraryQuery } from './library-query';
import type { LibraryView } from './catalog-model';
import type { ItemResponse, JellyfinUser, MediaItem } from './types';
import { canAddToPlaylist, canManageCollections, withoutItem } from './detail-model';
import { t } from './i18n';
import { isMusicTarget } from './music-model';
import { musicEngine } from './music-player';
import { useItemPrefetch } from './item-prefetch';

const PAGE_SIZE = 80;
const WINDOW_SIZE = PAGE_SIZE * 3;
const LETTERS = [ '#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ' ];
const T9: Record<string, string> = { '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ' };


export function LibraryPage({ api, library, user, restore = false, parentLabel, onUp, onSelect, onPlay, searchExpanded, onCloseSearch }: {
    api: JellyfinApi | null;
    user?: JellyfinUser;
    library: MediaItem;
    restore?: boolean;
    parentLabel?: string;
    onUp?: () => void;
    onSelect: (item: MediaItem) => void;
    onPlay: (item: MediaItem) => void;
    searchExpanded: boolean;
    onCloseSearch: () => void;
}) {
    const bookmark = useRef(restore ? peekLibraryBookmark(library.Id) : null);
    const pendingScroll = useRef<number | null>(bookmark.current ? bookmark.current.scrollY : null);
    const lastScrollY = useRef(0);
    const [ query, setQuery ] = useState<LibraryQuery>(() => bookmark.current?.query || defaultLibraryQuery());
    const [ view, setView ] = useState<LibraryView>(() => bookmark.current?.view || 'poster');
    const [ genres, setGenres ] = useState<Array<{ Name?: string; Id?: string }>>([]);
    const [ years, setYears ] = useState<number[]>([]);
    const [ genreError, setGenreError ] = useState('');
    const [ yearError, setYearError ] = useState('');
    const [ genreAttempt, setGenreAttempt ] = useState(0);
    const [ yearAttempt, setYearAttempt ] = useState(0);
    const [ items, setItems ] = useState<MediaItem[]>([]);
    const [ startIndex, setStartIndex ] = useState(0);
    const [ total, setTotal ] = useState(0);
    const [ loading, setLoading ] = useState(false);
    const [ error, setError ] = useState('');
    const [ filterOpen, setFilterOpen ] = useState(false);
    const [ mobileFilters, setMobileFilters ] = useState(() => window.matchMedia('(max-width: 767px)').matches);
    const [ busyId, setBusyId ] = useState('');
    const [ scrubLetter, setScrubLetter ] = useState('');
    const [ scrubBubbleY, setScrubBubbleY ] = useState(0);
    const [ activeLetter, setActiveLetter ] = useState('#');
    const [ scrolling, setScrolling ] = useState(false);
    const [ scrollProgress, setScrollProgress ] = useState(0);
    const [ sortControl, setSortControl ] = useState(() => bookmark.current?.sortControl || `${query.SortBy}:${query.SortOrder}`);
    const scrubMoved = useRef(false);
    const jumpPending = useRef(false);
    const suppressScrubClickUntil = useRef(0);
    const pendingJump = useRef<{ index: number; generation: number; letter: string } | null>(null);
    const letterAnchor = useRef<{ y: number; letter: string } | null>(null);
    const letterOffsets = useRef(new Map<string, number>());
    const scrollTimer = useRef<number>();
    const generation = useRef(0);
    const requestActive = useRef(false);
    const requestOwner = useRef(0);
    const catalogRequest = useRef<AbortController | null>(null);
    const grid = useRef<HTMLDivElement>(null);
    const filterDialogRef = useRef<HTMLDivElement>(null);
    const itemsRef = useRef<MediaItem[]>(items);
    const startIndexRef = useRef(startIndex);
    const totalRef = useRef(total);
    const previousLoad = useRef({ libraryId: library.Id, query, view, api });
    const isTvLibrary = library.CollectionType?.toLowerCase() === 'tvshows';
    const modes = useMemo(() => libraryModes(library), [ library.Type, library.CollectionType ]);
    const mode = currentMode(modes, query.Mode);
    const suggestionsMode = Boolean(mode.suggestions);
    const titleSort = query.SortBy === 'SortName' && !mode.fixedOrder && !suggestionsMode;
    const itemTypesKey = (mode.itemTypes ?? (isTvLibrary ? [ 'Series' ] : undefined))?.join(',') || '';
    const itemTypes = useMemo(() => itemTypesKey ? itemTypesKey.split(',') : undefined, [ itemTypesKey ]);
    const recursive = mode.recursive ?? (!isTvLibrary && !listsDirectChildren(library));
    const source = mode.source;
    const selectedYears = useMemo(() => decadeYears(query.Decade), [ query.Decade ]);
    const activeFilterCount = countFilters(query);

    useEffect(() => {
        const media = window.matchMedia('(max-width: 767px)');
        const apply = () => setMobileFilters(media.matches);
        apply();
        if (media.addEventListener) media.addEventListener('change', apply);
        else media.addListener(apply);
        return () => {
            if (media.removeEventListener) media.removeEventListener('change', apply);
            else media.removeListener(apply);
        };
    }, []);

    const mobileFilterSheet = mobileFilters && !document.documentElement.classList.contains('tv-client');
    useDialogFocus(filterDialogRef, filterOpen && mobileFilterSheet, () => setFilterOpen(false), { initial: '.library-sheet-close' });

    const load = useCallback(async (absoluteStart: number, replace: boolean, nextQuery = query, nextView = view, scroll = false) => {
        if (!api || suggestionsMode || requestActive.current || jumpPending.current || scrubMoved.current) return;
        const currentGeneration = generation.current;
        const requestId = ++requestOwner.current;
        const abort = new AbortController();
        catalogRequest.current = abort;
        requestActive.current = true;
        setLoading(true);
        setError('');
        try {
            const response = await api.getItems(library.Id, absoluteStart, undefined, itemTypes, recursive, PAGE_SIZE, {
                Query: nextQuery,
                Source: source,
                StartIndex: absoluteStart,
                Limit: PAGE_SIZE,
                Years: selectedYears,
                Signal: abort.signal
            });
            if (currentGeneration !== generation.current) return;
            const page = response.Items || [];
            if (replace) setItems(page);
            else if (absoluteStart < startIndex) setItems(current => page.concat(current).slice(0, WINDOW_SIZE));
            else setItems(current => {
                const byId = new Map(current.map(item => [ item.Id, item ]));
                page.forEach(item => byId.set(item.Id, item));
                return Array.from(byId.values()).slice(-WINDOW_SIZE);
            });
            if (replace || absoluteStart < startIndex) {
                setStartIndex(absoluteStart);
            }
            setTotal(response.TotalRecordCount ?? total);
            if (scroll) window.scrollTo({ top: 0, behavior: 'auto' });
        } catch (e) {
            if (currentGeneration === generation.current) setError(userMessage(e, t('Library items could not load.')));
        } finally {
            if (requestOwner.current === requestId) {
                requestActive.current = false;
                setLoading(false);
            }
        }
    }, [ api, library.Id, itemTypes, recursive, source, suggestionsMode, query, view, selectedYears, total, startIndex ]);
    const loadRef = useRef(load);
    loadRef.current = load;

    useEffect(() => {
        // Browser scroll anchoring fights the virtual window's spacer updates, so the page scroller opts out.
        const root = document.documentElement;
        const previous = root.style.getPropertyValue('overflow-anchor');
        root.style.setProperty('overflow-anchor', 'none');
        return () => {
            if (previous) root.style.setProperty('overflow-anchor', previous);
            else root.style.removeProperty('overflow-anchor');
        };
    }, []);

    useEffect(() => {
        const remember = () => { lastScrollY.current = window.scrollY; };
        window.addEventListener('scroll', remember, { passive: true });
        return () => window.removeEventListener('scroll', remember);
    }, []);

    const bookmarkState = useRef({ query, view, sortControl, startIndex: 0 });
    useEffect(() => () => {
        generation.current += 1;
        requestOwner.current += 1;
        catalogRequest.current?.abort();
        saveLibraryBookmark(library.Id, { ...bookmarkState.current, scrollY: lastScrollY.current });
    }, []);

    useLayoutEffect(() => {
        const target = pendingScroll.current;
        if (target === null || !items.length) return;
        pendingScroll.current = null;
        window.scrollTo({ top: target, behavior: 'auto' });
    }, [ items ]);

    useEffect(() => {
        let active = true;
        setGenres([]);
        setGenreError('');
        if (!api) return;
        void api.getGenres(library.Id).then(nextGenres => {
            if (!active) return;
            setGenres(nextGenres.filter(item => item.Name).sort((a, b) => (a.Name || '').localeCompare(b.Name || '')));
        }).catch(() => { if (active) setGenreError(t('Genres could not load.')); });
        return () => { active = false; };
    }, [ api, library.Id, genreAttempt ]);

    const [ facets, setFacets ] = useState<{ tags: string[]; ratings: string[] }>({ tags: [], ratings: [] });
    useEffect(() => {
        let active = true;
        setFacets({ tags: [], ratings: [] });
        if (!api || suggestionsMode) return;
        void api.getLibraryFilters(library.Id, itemTypes).then(next => { if (active) setFacets(next); }).catch(() => undefined);
        return () => { active = false; };
    }, [ api, library.Id, itemTypes, suggestionsMode ]);

    useEffect(() => {
        let active = true;
        setYears([]);
        setYearError('');
        if (!api) return;
        void api.getYears(library.Id).then(nextYears => {
            if (active) setYears(nextYears);
        }).catch(() => { if (active) setYearError(t('Decades could not load.')); });
        return () => { active = false; };
    }, [ api, library.Id, yearAttempt ]);

    const reset = useCallback((nextQuery: LibraryQuery, nextView = view) => {
        const viewOnly = nextView !== view && nextQuery === query;
        generation.current += 1;
        catalogRequest.current?.abort();
        pendingJump.current = null;
        letterAnchor.current = null;
        letterOffsets.current.clear();
        jumpPending.current = false;
        requestActive.current = false;
        requestOwner.current += 1;
        setQuery(nextQuery);
        setView(nextView);
        setItems([]);
        if (!viewOnly) {
            setStartIndex(0);
            setTotal(0);
        }
        setError('');
        if (!viewOnly) window.scrollTo({ top: 0, behavior: 'auto' });
    }, [ view, query ]);

    useEffect(() => {
        const onlyViewChanged = previousLoad.current.api === api && previousLoad.current.libraryId === library.Id && previousLoad.current.query === query && previousLoad.current.view !== view;
        previousLoad.current = { libraryId: library.Id, query, view, api };
        generation.current += 1;
        catalogRequest.current?.abort();
        pendingJump.current = null;
        letterAnchor.current = null;
        letterOffsets.current.clear();
        requestOwner.current += 1;
        requestActive.current = false;
        jumpPending.current = false;
        setItems([]);
        const restored = bookmark.current;
        bookmark.current = null;
        if (restored && restored.query === query && restored.view === view) {
            const offset = Math.max(0, restored.startIndex);
            setStartIndex(offset);
            void loadRef.current(offset, true, query, view);
        } else if (onlyViewChanged) void loadRef.current(startIndex, true, query, view);
        else {
            setStartIndex(0);
            setTotal(0);
            void loadRef.current(0, true, query, view);
        }
        // Initial request per account, library, filter/sort and view. loadRef always calls the latest loader,
        // so pagination state stays out of the effect deps.
    }, [ api, library.Id, query, view, selectedYears ]);

    const requestPage = useCallback(async (offset: number, prepend = false) => {
        if (!api || suggestionsMode || requestActive.current || jumpPending.current || scrubMoved.current || offset < 0 || offset >= totalRef.current) return;
        requestActive.current = true;
        const currentGeneration = generation.current;
        const requestId = ++requestOwner.current;
        const abort = new AbortController();
        catalogRequest.current = abort;
        setLoading(true);
        setError('');
        try {
            const response: ItemResponse = await api.getItems(library.Id, offset, undefined, itemTypes, recursive, PAGE_SIZE, {
                Query: query, Source: source, StartIndex: offset, Limit: PAGE_SIZE, Years: selectedYears, Signal: abort.signal
            });
            if (currentGeneration !== generation.current) return;
            const page = response.Items || [];
            if (prepend) {
                setItems(current => page.concat(current).slice(0, WINDOW_SIZE));
                setStartIndex(offset);
            } else {
                setItems(current => current.concat(page).slice(-WINDOW_SIZE));
                const dropped = Math.max(0, currentItemsLength.current + page.length - WINDOW_SIZE);
                setStartIndex(current => current + dropped);
            }
            setTotal(response.TotalRecordCount ?? totalRef.current);
        } catch (e) {
            if (currentGeneration === generation.current) setError(userMessage(e, t('Library items could not load.')));
        } finally {
            if (requestOwner.current === requestId) {
                requestActive.current = false;
                setLoading(false);
            }
        }
    }, [ api, library.Id, itemTypes, recursive, source, suggestionsMode, query, selectedYears, view ]);
    const currentItemsLength = useRef(0);
    currentItemsLength.current = items.length;
    bookmarkState.current = { query, view, sortControl, startIndex };
    itemsRef.current = items;
    startIndexRef.current = startIndex;
    totalRef.current = total;

    const onScroll = useCallback(() => {
        // Window state comes from refs: a scroll event can arrive before this callback is rebound to the newest render.
        const startIndex = startIndexRef.current;
        const items = itemsRef.current;
        const total = totalRef.current;
        if (!grid.current || requestActive.current || jumpPending.current || !items.length) return;
        const columns = columnCount(grid.current);
        const cardHeight = rowHeight(grid.current, view);
        const gridTop = grid.current.getBoundingClientRect().top + window.scrollY + (parseFloat(getComputedStyle(grid.current).paddingTop) || 0);
        // The leading spacer already places this row at its absolute catalog offset.
        const firstVisible = Math.max(0, Math.floor((window.scrollY + stickyHeaderHeight() - gridTop) / cardHeight)) * columns;
        const lastVisible = firstVisible + (Math.ceil(window.innerHeight / cardHeight) + 1) * columns;
        const windowEnd = startIndex + items.length;
        if (lastVisible < startIndex || firstVisible >= windowEnd) {
            // The viewport landed outside the loaded window (scrollbar drag); reload around it instead of paging toward it.
            const target = Math.max(0, Math.min(firstVisible - columns * 2, total - 1));
            void load(target - target % columns, true);
        } else if (firstVisible < startIndex + columns * 2 && startIndex > 0) {
            void requestPage(Math.max(0, startIndex - PAGE_SIZE), true);
        } else if (lastVisible > windowEnd - PAGE_SIZE / 2 && windowEnd < total) {
            void requestPage(windowEnd);
        }
    }, [ requestPage, load, view ]);

    useEffect(() => { onScroll(); }, [ items, startIndex, onScroll ]);

    useLayoutEffect(() => {
        const jump = pendingJump.current;
        const node = grid.current;
        if (!jump || !node || jump.generation !== generation.current) return;
        const gridTop = node.getBoundingClientRect().top + window.scrollY + (parseFloat(getComputedStyle(node).paddingTop) || 0);
        const targetTop = gridTop + Math.floor(jump.index / columnCount(node)) * rowHeight(node, view);
        // No smooth traversal through unloaded rows: publish the page, then position once.
        window.scrollTo({ top: Math.max(0, targetTop - stickyHeaderHeight()), behavior: 'instant' as ScrollBehavior });
        letterAnchor.current = { y: window.scrollY, letter: jump.letter };
        pendingJump.current = null;
        const frame = window.requestAnimationFrame(() => {
            if (jump.generation !== generation.current) return;
            jumpPending.current = false;
            requestActive.current = false;
            setLoading(false);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [ items, startIndex, view ]);

    useEffect(() => {
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
    }, [ onScroll ]);

    useEffect(() => {
        const updateScrollProgress = () => {
            const maximumScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
            setScrollProgress(Math.min(1, Math.max(0, window.scrollY / maximumScroll)));
            setScrolling(true);
            if (scrollTimer.current) window.clearTimeout(scrollTimer.current);
            scrollTimer.current = window.setTimeout(() => setScrolling(false), 700);
        };
        window.addEventListener('scroll', updateScrollProgress, { passive: true });
        window.addEventListener('resize', updateScrollProgress);
        return () => {
            window.removeEventListener('scroll', updateScrollProgress);
            window.removeEventListener('resize', updateScrollProgress);
            if (scrollTimer.current) window.clearTimeout(scrollTimer.current);
        };
    }, [ total, items.length ]);

    useEffect(() => {
        if (!titleSort || typeof IntersectionObserver === 'undefined' || !grid.current) return;
        const observed = new WeakSet<Element>();
        const updateLetter = () => {
            if (scrubMoved.current || jumpPending.current) return;
            const anchor = letterAnchor.current;
            if (anchor && Math.abs(window.scrollY - anchor.y) < 1) {
                setActiveLetter(anchor.letter);
                return;
            }
            letterAnchor.current = null;
            // Intersection entries contain only changes, not all visible cards.
            const first = Array.from(grid.current?.querySelectorAll<HTMLElement>('.library-card') || [])
                .find(card => card.getBoundingClientRect().bottom > stickyHeaderHeight() + 1);
            const itemId = first?.getAttribute('data-library-item-id');
            const localIndex = itemsRef.current.findIndex(entry => entry.Id === itemId);
            if (localIndex < 0) return;
            // A boundary can fall midway through a grid row. Track the end of
            // that first visible row, so an M jump isn't labelled L by its two
            // preceding cells. List view naturally has one item per row.
            const columns = columnCount(grid.current!);
            const rowEnd = Math.floor((startIndexRef.current + localIndex) / columns) * columns + columns - 1;
            const item = itemsRef.current[Math.min(itemsRef.current.length - 1, rowEnd - startIndexRef.current)];
            if (!item) return;
            const initial = (item.SortName || item.Name).trim().charAt(0).toUpperCase();
            setActiveLetter(/[A-Z]/.test(initial) ? initial : '#');
        };
        const observer = new IntersectionObserver(updateLetter, { rootMargin: `-${Math.ceil(stickyHeaderHeight())}px 0px 0px 0px`, threshold: 0 });
        const observeCards = (root: ParentNode) => root.querySelectorAll<HTMLElement>('.library-card[data-library-item-id]').forEach(card => {
            if (!observed.has(card)) {
                observed.add(card);
                observer.observe(card);
            }
        });
        observeCards(grid.current);
        const mutations = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
            if (node instanceof HTMLElement) {
                if (node.matches('.library-card[data-library-item-id]')) observeCards(node.parentNode || grid.current!);
                else observeCards(node);
            }
        })));
        mutations.observe(grid.current, { childList: true, subtree: true });
        window.addEventListener('scroll', updateLetter, { passive: true });
        return () => { window.removeEventListener('scroll', updateLetter); mutations.disconnect(); observer.disconnect(); };
    }, [ titleSort, items, startIndex, query.SortOrder ]);

    useEffect(() => {
    const onLibraryKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (!target || target.closest('input,select,textarea,[role="menu"],.library-sheet')) return;
            if (titleSort && /^[0-9]$/.test(event.key)) {
                if (event.key === '0') { event.preventDefault(); event.stopImmediatePropagation(); void jumpToLetter('#'); return; }
                const group = T9[event.key];
                if (group) {
                    const now = Date.now();
                    const holder = window as Window & { __libraryT9?: { key: string; at: number; index: number } };
                    const previous = holder.__libraryT9;
                    const nextIndex = previous?.key === event.key && now - previous.at < 1000 ? (previous.index + 1) % group.length : 0;
                    holder.__libraryT9 = { key: event.key, at: now, index: nextIndex };
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    void jumpToLetter(group[nextIndex]);
                    return;
                }
            }
            if (!document.documentElement.classList.contains('tv-client')) return;
            if (event.key === 'ArrowUp' && target.closest('.library-toolbar')) {
                document.querySelector<HTMLElement>('.alpha-scrubber button.active, .alpha-scrubber button')?.focus();
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            const card = target.closest<HTMLElement>('.library-card');
            if (!card) return;
            const cards = Array.from(document.querySelectorAll<HTMLElement>('.library-card'));
            const index = cards.indexOf(card);
            const currentItemId = card.getAttribute('data-library-item-id');
            const localIndex = itemsRef.current.findIndex(item => item.Id === currentItemId);
            if (localIndex < 0) return;
            const columns = grid.current ? columnCount(grid.current) : 5;
            if (event.key === 'ArrowUp' && startIndex + localIndex < columns) {
                document.querySelector<HTMLElement>('.library-toolbar button, .library-toolbar select')?.focus();
                event.preventDefault();
                event.stopImmediatePropagation();
            } else if (event.key === 'ArrowUp' && localIndex < columns && startIndex > 0) {
                const targetAbsoluteIndex = Math.max(0, startIndex + localIndex - columns);
                void requestPage(Math.max(0, startIndex - PAGE_SIZE), true).then(() => window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
                    const targetId = itemsRef.current[targetAbsoluteIndex - startIndexRef.current]?.Id;
                    const next = targetId ? Array.from(document.querySelectorAll<HTMLElement>('[data-library-item-id]')).find(node => node.getAttribute('data-library-item-id') === targetId) : null;
                    next?.querySelector<HTMLElement>('[data-focusable="true"]')?.focus();
                })));
                event.preventDefault();
                event.stopImmediatePropagation();
            } else if (event.key === 'ArrowDown' && index >= cards.length - columns) {
                const node = grid.current;
                if (node) window.scrollBy({ top: rowHeight(node, view), behavior: 'auto' });
                const absoluteNextIndex = startIndexRef.current + localIndex + columns;
                const nextItemId = itemsRef.current[localIndex + columns]?.Id;
                if (absoluteNextIndex >= startIndexRef.current + itemsRef.current.length && startIndexRef.current + itemsRef.current.length < total) {
                    void requestPage(startIndex + itemsRef.current.length).then(() => window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
                        const targetLocalIndex = absoluteNextIndex - startIndexRef.current;
                        const targetId = itemsRef.current[targetLocalIndex]?.Id;
                        const next = targetId ? Array.from(document.querySelectorAll<HTMLElement>('[data-library-item-id]')).find(node => node.getAttribute('data-library-item-id') === targetId) : null;
                        next?.querySelector<HTMLElement>('[data-focusable="true"]')?.focus();
                    })));
                } else if (nextItemId) window.requestAnimationFrame(() => {
                    const next = Array.from(document.querySelectorAll<HTMLElement>('[data-library-item-id]')).find(node => node.getAttribute('data-library-item-id') === nextItemId);
                    next?.querySelector<HTMLElement>('[data-focusable="true"]')?.focus();
                });
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };
        window.addEventListener('keydown', onLibraryKey, true);
        return () => window.removeEventListener('keydown', onLibraryKey, true);
    }, [ titleSort, query.SortOrder, startIndex, items.length, total, requestPage ]);

    const setFilter = (key: keyof LibraryQuery, value: string | boolean | LibraryFeature[]) => reset({ ...query, [key]: value } as LibraryQuery);
    const [ titleDraft, setTitleDraft ] = useState(query.Title);
    useEffect(() => { setTitleDraft(query.Title); }, [ query.Title ]);
    useEffect(() => {
        if (titleDraft === query.Title) return;
        const timer = window.setTimeout(() => reset({ ...query, Title: titleDraft }), 350);
        return () => window.clearTimeout(timer);
    }, [ titleDraft ]);
    const selectMode = (id: string) => {
        if (id === mode.id) return;
        reset({ ...query, Mode: id, SeriesStatus: '', Availability: '' });
    };
    const jumpToLetter = async (requested: string) => {
        if (!api || !titleSort || !LETTERS.includes(requested) || !totalRef.current) return;
        const requestGeneration = ++generation.current;
        catalogRequest.current?.abort();
        const abort = new AbortController();
        catalogRequest.current = abort;
        requestOwner.current += 1;
        pendingJump.current = null;
        requestActive.current = false;
        jumpPending.current = true;
        setLoading(true);
        setError('');
        try {
            const descending = query.SortOrder === 'Descending';
            // Descending M begins below N; '#' is the beginning in A-Z and below A in Z-A.
            const boundary = requested === '#' ? (descending ? 'A' : undefined)
                : descending ? (requested === 'Z' ? undefined : String.fromCharCode(requested.charCodeAt(0) + 1)) : requested;
            let target = letterOffsets.current.get(requested);
            if (target === undefined) {
                if (boundary === undefined) target = 0;
                else {
                    // Search the same absolute catalog that normal paging uses. Older
                    // servers can cache different alphabet-boundary queries as one result.
                    // Single-item probes keep memory bounded and don't depend on suffix counts.
                    let low = 0;
                    let high = totalRef.current;
                    while (low < high) {
                        const middle = Math.floor((low + high) / 2);
                        const probe = await api.getItems(library.Id, middle, undefined, itemTypes, recursive, 1, {
                            Query: query, Source: source, Limit: 1, Years: selectedYears, Fields: 'SortName', Signal: abort.signal
                        }, 3);
                        if (requestGeneration !== generation.current) return;
                        const item = probe.Items?.[0];
                        if (!item) { high = middle; continue; }
                        const initial = (item.SortName || item.Name).trim().charAt(0).toUpperCase();
                        const beforeBoundary = descending ? initial >= boundary : initial < boundary;
                        if (beforeBoundary) low = middle + 1;
                        else high = middle;
                    }
                    target = Math.min(totalRef.current - 1, low);
                }
                letterOffsets.current.set(requested, target);
            }
            const columns = grid.current ? columnCount(grid.current) : 1;
            // Keep two rows before the destination so ordinary paging needn't immediately prepend.
            const pageStart = Math.max(0, Math.floor(target / columns) * columns - columns * 2);
            const page = await api.getItems(library.Id, pageStart, undefined, itemTypes, recursive, PAGE_SIZE, {
                Query: query, Source: source, Limit: PAGE_SIZE, Years: selectedYears, Signal: abort.signal
            }, 3);
            if (requestGeneration !== generation.current) return;
            pendingJump.current = { index: target, generation: requestGeneration, letter: requested };
            setItems(page.Items || []);
            setStartIndex(pageStart);
            setTotal(page.TotalRecordCount ?? totalRef.current);
            setActiveLetter(requested);
        } catch (error) {
            if (requestGeneration === generation.current) setError(userMessage(error, t('Could not jump to that title.')));
        } finally {
            if (requestGeneration === generation.current && !pendingJump.current) {
                jumpPending.current = false;
                requestActive.current = false;
                setLoading(false);
            }
        }
    };

    const letterAtPointer = (clientY: number, element: HTMLElement): string => {
        const bounds = element.getBoundingClientRect();
        const index = Math.max(0, Math.min(LETTERS.length - 1, Math.floor((clientY - bounds.top) / bounds.height * LETTERS.length)));
        return (query.SortOrder === 'Descending' ? LETTERS.slice().reverse() : LETTERS)[index];
    };
    const startScrub = (event: PointerEvent) => {
        if (document.documentElement.classList.contains('tv-client')) return;
        const target = event.currentTarget as HTMLElement;
        scrubMoved.current = true;
        suppressScrubClickUntil.current = 0;
        generation.current += 1;
        requestOwner.current += 1;
        catalogRequest.current?.abort();
        pendingJump.current = null;
        jumpPending.current = true;
        requestActive.current = false;
        if (event.isTrusted) target.setPointerCapture?.(event.pointerId);
        const letter = letterAtPointer(event.clientY, target);
        setScrubLetter(letter);
        setScrubBubbleY(event.clientY);
    };
    const moveScrub = (event: PointerEvent) => {
        if (!scrubMoved.current) return;
        const target = event.currentTarget as HTMLElement;
        const letter = letterAtPointer(event.clientY, target);
        setScrubLetter(letter);
        setScrubBubbleY(event.clientY);
    };
    const endScrub = (event: PointerEvent) => {
        if (!scrubMoved.current) return;
        const letter = letterAtPointer(event.clientY, event.currentTarget as HTMLElement);
        scrubMoved.current = false;
        suppressScrubClickUntil.current = Date.now() + 400;
        setScrubLetter('');
        if (letter) void jumpToLetter(letter);
    };
    const cancelScrub = () => {
        scrubMoved.current = false;
        jumpPending.current = false;
        setScrubLetter('');
    };
    const clickScrubLetter = (event: MouseEvent, letter: string) => {
        if (event.detail > 0 && Date.now() < suppressScrubClickUntil.current) {
            event.preventDefault();
            return;
        }
        void jumpToLetter(letter);
    };
    const selectSort = (value: string) => {
        const [ sortBy, sortOrder ] = value.split(':');
        setSortControl(value);
        reset({ ...query, SortBy: sortBy as LibraryQuery['SortBy'], SortOrder: sortOrder as LibraryQuery['SortOrder'] });
    };

    const toggleUserData = async (item: MediaItem, field: 'favorite' | 'played') => {
        if (!api || busyId) return;
        setBusyId(item.Id);
        const next = field === 'favorite' ? !item.UserData?.IsFavorite : !item.UserData?.Played;
        try {
            const returned = field === 'favorite' ? await api.setFavorite(item.Id, next) : await api.setPlayed(item.Id, next);
            const userData = field === 'favorite' ? { ...item.UserData, ...(returned || { IsFavorite: next }) } : playedUserData(item.UserData, next, returned);
            const change = applyUserDataChange(itemsRef.current, item.Id, userData, query.WatchStatus, query.Favorite);
            setItems(change.items);
            if (change.removed) setTotal(current => Math.max(0, current - change.removed));
        } catch (e) { setError(userMessage(e, t('Could not update item.'))); }
        finally { setBusyId(''); }
    };

    const removeItem = async (item: MediaItem, mode: 'delete' | 'uncollect') => {
        if (!api || busyId) return;
        setBusyId(item.Id);
        try {
            if (mode === 'delete') await api.deleteItem(item.Id);
            else await api.removeFromCollection(library.Id, [ item.Id ]);
            setItems(withoutItem(itemsRef.current, item.Id));
            setTotal(current => Math.max(0, current - 1));
        } catch (e) { setError(userMessage(e, mode === 'delete' ? t('Could not delete the item.') : t('Could not remove the item from the collection.'))); }
        finally { setBusyId(''); }
    };
    const canUncollect = library.Type === 'BoxSet' && !!user && canManageCollections(user);

    const [ selecting, setSelecting ] = useState(false);
    const [ selection, setSelection ] = useState<Map<string, MediaItem>>(() => new Map());
    const [ bulkBusy, setBulkBusy ] = useState(false);
    const [ bulkNotice, setBulkNotice ] = useState<{ text: string; error: boolean } | null>(null);
    const [ bulkPicker, setBulkPicker ] = useState(false);
    const [ bulkPlaylistPicker, setBulkPlaylistPicker ] = useState(false);
    const [ confirmBulkDelete, setConfirmBulkDelete ] = useState(false);
    const [ queueNotice, setQueueNotice ] = useState('');
    const enqueue = (item: MediaItem, where: 'next' | 'end') => {
        if (isMusicTarget(item)) {
            void (where === 'next' ? musicEngine.playNext(item) : musicEngine.addToQueue(item));
            return;
        }
        playQueue.update(queue => where === 'next' ? playNext(queue, item) : addToQueue(queue, item));
        setQueueNotice(where === 'next' ? t('{0} will play next.', item.Name) : t('{0} added to the queue.', item.Name));
    };
    useEffect(() => {
        setSelection(new Map());
        setBulkPicker(false);
        setConfirmBulkDelete(false);
    }, [ library.Id, query ]);
    const endSelecting = () => {
        setSelecting(false);
        setSelection(new Map());
        setBulkPicker(false);
        setConfirmBulkDelete(false);
        setBulkNotice(null);
    };
    const selected = Array.from(selection.values());
    const bulk = bulkCapabilities(selected, user);
    const queueMusic = async (targets: MediaItem[]) => {
        setBulkBusy(true);
        try {
            for (const target of targets) await musicEngine.addToQueue(target);
            setBulkNotice({ text: t('Added {0} music selections to the queue.', targets.length), error: false });
        } finally {
            setBulkBusy(false);
        }
    };
    const runBulk = async (action: BulkAction) => {
        if (!api || bulkBusy || !selected.length) return;
        const targets = actionTargets(selected, action);
        setBulkBusy(true);
        setBulkNotice(null);
        try {
            const result = await runBatch(targets, item => action === 'delete' ? api.deleteItem(item.Id).then(() => null)
                : action === 'played' || action === 'unplayed' ? api.setPlayed(item.Id, action === 'played')
                    : api.setFavorite(item.Id, action === 'favorite'));
            let current = itemsRef.current;
            let removed = 0;
            for (const { item, value } of result.succeeded) {
                if (action === 'delete') {
                    const next = withoutItem(current, item.Id);
                    removed += current.length - next.length;
                    current = next;
                    continue;
                }
                const latest = current.find(entry => entry.Id === item.Id) || item;
                const returned = value as MediaItem['UserData'] | null;
                const userData = action === 'played' || action === 'unplayed'
                    ? playedUserData(latest.UserData, action === 'played', returned)
                    : { ...latest.UserData, ...(returned || { IsFavorite: action === 'favorite' }) };
                const change = applyUserDataChange(current, item.Id, userData, query.WatchStatus, query.Favorite);
                current = change.items;
                removed += change.removed;
            }
            setItems(current);
            if (removed) setTotal(count => Math.max(0, count - removed));
            setSelection(new Map(result.failed.map(item => [ item.Id, item ])));
            setBulkNotice(batchMessage(action, result.succeeded.length, result.failed.length, selected.length - targets.length));
        } finally {
            setBulkBusy(false);
            setConfirmBulkDelete(false);
        }
    };
    const bulkBar = selecting && <div class="library-bulk-bar" role="toolbar" aria-label={t('Actions for selected titles')} data-focusable="scope">
        <span class="library-bulk-count" aria-live="polite">{t('{0} selected{1}', selection.size, selection.size >= MAX_SELECTION ? ` (limit ${MAX_SELECTION})` : '')}</span>
        <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy || !items.length} onClick={() => setSelection(current => selectAll(current, items))}>{t('Select loaded')}</button>
        <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy || !selection.size} onClick={() => setSelection(new Map())}>{t('Clear')}</button>
        {bulk.played && <>
            <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} onClick={() => void runBulk('played')}>{t('Mark played')}</button>
            <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} onClick={() => void runBulk('unplayed')}>{t('Mark unplayed')}</button>
        </>}
        {bulk.favorite && <>
            <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} onClick={() => void runBulk('favorite')}>{t('Favorite')}</button>
            <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} onClick={() => void runBulk('unfavorite')}>{t('Unfavorite')}</button>
        </>}
        {selected.some(queueable) && <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} onClick={() => { const titles = selected.filter(queueable); playQueue.update(queue => titles.reduce((next, item) => addToQueue(next, item), queue)); setBulkNotice({ text: `Added ${titles.length} ${titles.length === 1 ? 'title' : 'titles'} to the queue.`, error: false }); }}>{t('Add to queue')}</button>}
        {selected.some(isMusicTarget) && <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} onClick={() => void queueMusic(selected.filter(isMusicTarget))}>{t('Add to music queue')}</button>}
        {bulk.collection && <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} aria-expanded={bulkPicker} onClick={() => setBulkPicker(open => !open)}>{t('Add to collection')}</button>}
        {bulk.playlist && <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} aria-expanded={bulkPlaylistPicker} onClick={() => setBulkPlaylistPicker(open => !open)}>{t('Add to playlist')}</button>}
        {bulk.deletable > 0 && (confirmBulkDelete
            ? <button type="button" class="button danger" data-focusable="true" disabled={bulkBusy} onClick={() => void runBulk('delete')}>{t('Confirm: delete {0} from server', bulk.deletable)}</button>
            : <button type="button" class="button secondary" data-focusable="true" disabled={bulkBusy} onClick={() => setConfirmBulkDelete(true)}>{t('Delete…')}</button>)}
        <button type="button" class="button primary" data-focusable="true" onClick={endSelecting}>{t('Done')}</button>
        {bulkBusy && <span class="mini-spinner" role="status" aria-label={t('Working')} />}
        {bulkNotice && <p class={bulkNotice.error ? 'notice error' : 'notice success'} role={bulkNotice.error ? 'alert' : 'status'}>{bulkNotice.text}</p>}
        {bulkPicker && api && selected.length > 0 && <CollectionPicker api={api} itemIds={selected.map(item => item.Id)} onDone={text => { setBulkPicker(false); setBulkNotice({ text, error: false }); }} />}
        {bulkPlaylistPicker && api && selected.length > 0 && <PlaylistPicker api={api} itemIds={selected.map(item => item.Id)} onDone={text => { setBulkPlaylistPicker(false); setBulkNotice({ text, error: false }); }} />}
    </div>;

    const yearOptions = Array.from(new Set(years.map(year => Math.floor(year / 10) * 10))).sort((a, b) => b - a);
    const countLabel = mode.noun;
    const listControls = !suggestionsMode && !mode.fixedOrder;
    const chips = (label: string, key: 'Genre' | 'Decade' | 'Tags' | 'Ratings', options: Array<[string, string]>) => options.length > 0 && <fieldset class="library-filter-chips">
        <legend>{t(label)}</legend>
        <div>{options.map(([ value, text ]) => {
            const on = splitValues(query[key]).includes(value);
            return <button key={value} type="button" data-focusable="true" class={on ? 'active' : ''} aria-pressed={on} onClick={() => setFilter(key, toggleValue(query[key], value))}>{text}</button>;
        })}</div>
    </fieldset>;
    const toggleFeature = (feature: LibraryFeature) => setFilter('Features', (query.Features || []).includes(feature) ? query.Features.filter(entry => entry !== feature) : [ ...(query.Features || []), feature ]);
    const filterContent = <>
        <Select label={t('Watch status')} value={query.WatchStatus === 'favorite' ? '' : query.WatchStatus} onChange={value => reset({ ...query, WatchStatus: value as LibraryQuery['WatchStatus'], Favorite: query.Favorite || query.WatchStatus === 'favorite' })} options={[[ '', 'Watch status' ], [ 'unplayed', 'Unplayed' ], [ 'played', 'Played' ], [ 'resumable', 'In progress' ]]} />
        <Select label={t('Resolution')} value={query.Resolution} onChange={value => setFilter('Resolution', value)} options={[[ '', 'Resolution' ], [ '4k', '4K' ], [ '1080p', '1080p' ]]} />
        {mode.id === 'shows' && <Select label={t('Series status')} value={query.SeriesStatus || ''} onChange={value => setFilter('SeriesStatus', value)} options={[[ '', 'Series status' ], [ 'Continuing', 'Continuing' ], [ 'Ended', 'Ended' ]]} />}
        {mode.id === 'episodes' && <Select label={t('Availability')} value={query.Availability || ''} onChange={value => setFilter('Availability', value)} options={[[ '', 'Availability' ], [ 'missing', 'Missing episodes' ], [ 'unaired', 'Unaired episodes' ]]} />}
        <div class="library-filter-toggles" role="group" aria-label={t('Flags')}>
            <button type="button" data-focusable="true" class={query.Favorite || query.WatchStatus === 'favorite' ? 'active' : ''} aria-pressed={query.Favorite || query.WatchStatus === 'favorite'} onClick={() => reset({ ...query, Favorite: !(query.Favorite || query.WatchStatus === 'favorite'), WatchStatus: query.WatchStatus === 'favorite' ? '' : query.WatchStatus })}>{t('Favorites')}</button>
            {([ [ 'subtitles', 'Has subtitles' ], [ 'trailer', 'Has trailer' ], [ 'special', 'Has extras' ] ] as Array<[LibraryFeature, string]>).map(([ feature, label ]) => {
                const on = (query.Features || []).includes(feature);
                return <button key={feature} type="button" data-focusable="true" class={on ? 'active' : ''} aria-pressed={on} onClick={() => toggleFeature(feature)}>{t(label)}</button>;
            })}
        </div>
        {chips('Genres', 'Genre', genres.map(g => [ g.Name || '', g.Name || '' ] as [string, string]))}
        {chips('Decades', 'Decade', yearOptions.map(year => [ String(year), `${year}s` ] as [string, string]))}
        {chips(t('Parental ratings'), 'Ratings', facets.ratings.map(rating => [ rating, rating ] as [string, string]))}
        {chips('Tags', 'Tags', facets.tags.slice(0, 60).map(tag => [ tag, tag ] as [string, string]))}
        {activeFilterCount > 0 && <button type="button" class="button secondary" data-focusable="true" onClick={() => reset({ ...defaultLibraryQuery(), Mode: query.Mode, SortBy: query.SortBy, SortOrder: query.SortOrder, Title: query.Title })}>{t('Clear filters')}</button>}
        {genreError && <p class="library-filter-error" role="alert">{genreError} <button class="button secondary" data-focusable="true" type="button" onClick={() => setGenreAttempt(value => value + 1)}>{t('Retry genres')}</button></p>}
        {yearError && <p class="library-filter-error" role="alert">{yearError} <button class="button secondary" data-focusable="true" type="button" onClick={() => setYearAttempt(value => value + 1)}>{t('Retry decades')}</button></p>}
    </>;
    const modeTabs = modes.length > 1 && <div class="library-mode-tabs" role="group" aria-label={t('Library view')}>
        {modes.map(entry => <button key={entry.id} type="button" data-focusable="true" class={entry.id === mode.id ? 'active' : ''} aria-pressed={entry.id === mode.id} onClick={() => selectMode(entry.id)}>{t(entry.label)}</button>)}
    </div>;
    const toggleFilters = () => {
        if (filterOpen) {
            setFilterOpen(false);
            return;
        }
        if (mobileFilterSheet && searchExpanded) onCloseSearch();
        setFilterOpen(true);
    };
    const filterButton = <button class="library-filter-open" data-focusable="true" aria-controls="library-filters" aria-expanded={filterOpen} onClick={toggleFilters}>{t('Filters')}{activeFilterCount > 0 && <span class="filter-count-pill">{activeFilterCount}</span>} <span aria-hidden="true">⌄</span></button>;
    const rail = <div class="library-controls library-toolbar" data-focusable="scope">
        {!suggestionsMode && <span class="library-count">{total.toLocaleString()} {countLabel}</span>}
        <div class="library-operation-controls">
            {listControls && <label class="library-title-search"><span class="visually-hidden">{t('Search this library')}</span><input type="search" data-focusable="true" placeholder={t('Search {0}', library.Name)} aria-label={t('Search {0}', library.Name)} value={titleDraft} onInput={event => setTitleDraft((event.currentTarget as HTMLInputElement).value)} /></label>}
            {listControls && filterButton}
            {!suggestionsMode && <button type="button" class={selecting ? 'library-select-toggle active' : 'library-select-toggle'} data-focusable="true" aria-pressed={selecting} onClick={() => (selecting ? endSelecting() : setSelecting(true))}>{selecting ? t('Done') : t('Select')}</button>}
            {listControls && <Select label={t('Sort')} value={sortControl} onChange={selectSort} options={librarySortOptions} />}
        {!suggestionsMode && !document.documentElement.classList.contains('tv-client') && <ViewSwitch view={view} onChange={next => reset(query, next)} />}
        </div>
    </div>;

    return <section class={[ 'library-page', titleSort ? 'has-alpha' : '', modes.length > 1 ? 'has-modes' : '' ].filter(Boolean).join(' ')}>
        <header class={modes.length > 1 ? 'library-sticky has-modes' : 'library-sticky'}>
            {onUp && parentLabel && <button class="back-link library-up" data-focusable="true" type="button" onClick={onUp}><span class="dir-arrow" aria-hidden="true">←</span> <span>{t('Back to {0}', parentLabel)}</span></button>}
            {modeTabs}
            {rail}
        </header>
        {titleSort && <nav class="alpha-scrubber" aria-label={t('Jump to title')} data-focusable="scope" onPointerDown={startScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={cancelScrub}>
            {(query.SortOrder === 'Descending' ? LETTERS.slice().reverse() : LETTERS).map(letter => <button key={letter} data-letter={letter} data-focusable="true" class={activeLetter === letter ? 'active' : ''} aria-label={letter === '#' ? t('Numbers and symbols') : letter} onClick={event => clickScrubLetter(event, letter)}>{letter}</button>)}
        </nav>}
        {!titleSort && <div class={`library-scroll-progress${scrolling ? ' visible' : ''}`} aria-hidden="true"><i style={{ height: `${Math.max(4, scrollProgress * 100)}%` }} /></div>}
        {scrubLetter && <span class="alpha-bubble" style={{ top: `${scrubBubbleY}px` }} aria-hidden="true">{scrubLetter}</span>}
        {filterOpen && listControls && (mobileFilterSheet
            ? <div class="library-sheet-layer">
                <button class="library-sheet-backdrop" type="button" tabIndex={-1} data-dialog-backdrop aria-hidden="true" onClick={() => setFilterOpen(false)} />
                <div id="library-filters" ref={filterDialogRef} class="library-sheet" role="dialog" aria-modal="true" aria-labelledby="library-filters-heading">
                    <div class="library-sheet-heading">
                        <h2 id="library-filters-heading">{t('Filters')}</h2>
                        <button class="library-sheet-close" type="button" data-focusable="true" aria-label={t('Close')} onClick={() => setFilterOpen(false)}>×</button>
                    </div>
                    {filterContent}
                </div>
            </div>
            : <div id="library-filters" class="library-filter-popover" role="group" aria-label={t('Library filters')}>{filterContent}</div>)}
        {suggestionsMode && <LibrarySuggestions api={api} library={library} onSelect={onSelect} onPlay={onPlay} />}
        {error && <div class="home-section-error" role="alert"><p>{error}</p><button class="button secondary" data-focusable="true" onClick={() => void load(startIndex, true)}>{t('Retry')}</button></div>}
        {!suggestionsMode && items.length > 0 && <VirtualizedLibraryGrid gridRef={grid} square={Boolean(mode.square) && view === 'poster'} items={items} startIndex={startIndex} total={total} api={api} view={view} onSelect={onSelect} onPlay={onPlay} onToggle={toggleUserData} onRemove={removeItem} canUncollect={canUncollect} busyId={busyId} selecting={selecting} selection={selection} onToggleSelect={item => setSelection(current => toggleSelection(current, item))} onQueue={enqueue} />}
        {bulkBar}
        {queueNotice && <p class="notice success library-queue-notice" role="status">{queueNotice} <button type="button" class="button secondary" data-focusable="true" onClick={() => setQueueNotice('')}>{t('Dismiss')}</button></p>}
        {!suggestionsMode && loading && <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />{items.length ? t('Loading titles…') : t('Loading library…')}</div>}
        {!suggestionsMode && !loading && !items.length && !error && <div class="empty-state"><span aria-hidden="true">✳</span><h2>{t('Nothing here yet')}</h2><p>{t('This library does not contain any matching items.')}</p></div>}
    </section>;
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
    return <label class="library-select"><span class="visually-hidden">{t(label)}</span><select data-focusable="true" aria-label={label} value={value} onChange={event => onChange((event.currentTarget as HTMLSelectElement).value)}>{options.map(([ option, text ]) => <option value={option} key={option}>{t(text)}</option>)}</select></label>;
}

function ViewSwitch({ view, onChange }: { view: LibraryView; onChange: (view: LibraryView) => void }) {
    return <div class="library-view-switch" role="group" aria-label={t('Library view')}>{([ [ 'poster', 'Grid' ], [ 'thumb', 'Thumb' ], [ 'banner', 'Banner' ], [ 'list', 'List' ] ] as Array<[LibraryView, string]>).map(([ key, label ]) => <button data-focusable="true" key={key} class={view === key ? 'active' : ''} aria-label={t('{0} view', label)} aria-pressed={view === key} onClick={() => onChange(key)}>{t(label)}</button>)}</div>;
}

function columnCount(element: HTMLElement): number {
    const style = getComputedStyle(element);
    return Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
}

function stickyHeaderHeight(): number {
    const header = document.querySelector<HTMLElement>('.library-sticky');
    return header ? Math.max(0, header.getBoundingClientRect().bottom) + 12 : 16;
}

// Row pitch must match the rendered rows exactly: spacers and the paging trigger are sized from it,
// so any drift accumulates across thousands of titles and pulls the viewport off the loaded window.
function rowHeight(element: HTMLElement, view: LibraryView): number {
    const style = getComputedStyle(element);
    const gapY = parseFloat(style.rowGap || '0') || 0;
    // Geometry must be independent of mounted cards (and their hover/focus transforms), so it reads the
    // same custom properties style.css uses to size list rows and poster art.
    if (view === 'list') return libraryGeometry(style).listRow + gapY;
    const columns = columnCount(element);
    const gapX = parseFloat(style.columnGap || '0') || 0;
    const contentWidth = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const width = (contentWidth - gapX * (columns - 1)) / columns;
    return width * libraryGeometry(style).posterRatio + gapY;
}

interface GridProps {
    items: MediaItem[]; startIndex: number; total: number; api: JellyfinApi | null; view: LibraryView;
    onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void;
    onToggle: (item: MediaItem, field: 'favorite' | 'played') => void; busyId: string;
    onRemove: (item: MediaItem, mode: 'delete' | 'uncollect') => void; canUncollect: boolean; square?: boolean;
    selecting: boolean; selection: Map<string, MediaItem>; onToggleSelect: (item: MediaItem) => void;
    onQueue: (item: MediaItem, where: 'next' | 'end') => void;
}

const VirtualizedLibraryGrid = ({ items, startIndex, total, api, view, onSelect, onPlay, onToggle, onRemove, canUncollect, square, busyId, selecting, selection, onToggleSelect, onQueue, gridRef }: GridProps & { gridRef: { current: HTMLDivElement | null } }) => {
    const elementRef = gridRef;
    const [ range, setRange ] = useState({ firstRow: 0, endRow: 4, columns: 5, height: 400, gap: 0 });
    const pendingFocus = useRef<number | null>(null);
    const update = useCallback(() => {
        const element = elementRef.current;
        if (!element) return;
        const columns = columnCount(element);
        const height = rowHeight(element, view);
        const gap = parseFloat(getComputedStyle(element).rowGap || '0') || 0;
        const top = element.getBoundingClientRect().top + window.scrollY + (parseFloat(getComputedStyle(element).paddingTop) || 0);
        const windowStartRow = Math.floor(startIndex / columns);
        const windowEndRow = Math.ceil((startIndex + items.length) / columns);
        const firstVisibleRow = Math.min(windowEndRow - 1, Math.max(windowStartRow, Math.floor((window.scrollY + stickyHeaderHeight() - top) / height)));
        const visibleRows = Math.ceil(window.innerHeight / height) + 1;
        const firstRow = Math.max(windowStartRow, firstVisibleRow - 2);
        const endRow = Math.min(windowEndRow, firstVisibleRow + visibleRows + 2);
        setRange(current => current.firstRow === firstRow && current.endRow === endRow && current.columns === columns && current.height === height && current.gap === gap ? current : { firstRow, endRow, columns, height, gap });
    }, [ items.length, view, startIndex, square ]);
    useLayoutEffect(() => {
        window.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        return () => { window.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
    }, [ update ]);
    // Re-measure after every render: the first pass may only have the estimated row height (no card in the DOM yet),
    // and setRange bails out once the measured geometry is stable.
    useLayoutEffect(() => { update(); });
    // Cells are placed by absolute index so a window start that is not a multiple of the column count
    // keeps every title in the same row and column as the window slides.
    const columns = range.columns;
    // Clamp stale range state during a replacement render so a new page never renders empty.
    const firstRow = Math.max(Math.floor(startIndex / columns), Math.min(range.firstRow, Math.ceil((startIndex + items.length) / columns) - 1));
    const endRow = Math.min(Math.ceil((startIndex + items.length) / columns), Math.max(firstRow + 1, range.endRow));
    const absStart = Math.max(startIndex, firstRow * columns);
    const absEnd = Math.min(startIndex + items.length, endRow * columns);
    const leading = absStart - firstRow * columns;
    const visible = absEnd > absStart ? items.slice(absStart - startIndex, absEnd - startIndex) : [];
    const gridStyle = elementRef.current ? getComputedStyle(elementRef.current) : null;
    const paddingTop = parseFloat(gridStyle?.paddingTop || '16');
    const paddingBottom = parseFloat(gridStyle?.paddingBottom || '32');
    const canvasHeight = Math.ceil(total / columns) * range.height - range.gap + paddingTop + paddingBottom;
    useLayoutEffect(() => {
        const index = pendingFocus.current;
        if (index === null || index < absStart || index >= absEnd) return;
        pendingFocus.current = null;
        elementRef.current?.querySelector<HTMLElement>(`[data-grid-index="${index}"] [data-focusable="true"], [data-grid-index="${index}"] button`)?.focus({ preventScroll: true });
    }, [ absStart, absEnd ]);
    const onGridKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Tab' || !(event.target instanceof HTMLElement)) return;
        const cell = event.target.closest<HTMLElement>('[data-grid-index]');
        if (!cell) return;
        const controls = tabbableWithin(cell);
        if (controls[event.shiftKey ? 0 : controls.length - 1] !== event.target) return;
        const target = virtualTabTarget(Number(cell.dataset.gridIndex), absStart, absEnd, total, event.shiftKey);
        if (target === null) return;
        event.preventDefault();
        pendingFocus.current = target;
        const element = elementRef.current;
        if (!element) return;
        const top = element.getBoundingClientRect().top + window.scrollY + paddingTop;
        window.scrollTo({ top: Math.max(0, top + Math.floor(target / columns) * range.height - window.innerHeight / 3), behavior: 'auto' });
        update();
    };
    return <div ref={elementRef} class={`library-grid-items library-view-${view}${square ? ' library-art-square' : ''}`} role="list" aria-label={t('Titles')} onKeyDown={onGridKeyDown} style={{ position: 'relative', height: `${Math.max(0, canvasHeight)}px`, '--library-columns': columns } as any}>
        <div class="library-grid-window" style={{ position: 'absolute', top: `${paddingTop + firstRow * range.height}px`, left: gridStyle?.paddingLeft || '32px', right: gridStyle?.paddingRight || '36px', display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gridStyle?.columnGap || '16px', rowGap: `${range.gap}px` }}>
            {Array.from({ length: leading }, (_value, index) => <div key={`lead-${index}`} class="library-grid-gap" aria-hidden="true" />)}
            {visible.map((item, offset) => <div key={item.Id} class="library-grid-cell" role="listitem" aria-posinset={absStart + offset + 1} aria-setsize={total} data-grid-index={absStart + offset}><LibraryCard api={api} item={item} view={view} onSelect={onSelect} onPlay={onPlay} onToggle={onToggle} onRemove={onRemove} canUncollect={canUncollect} busy={busyId === item.Id} selecting={selecting} selected={selection.has(item.Id)} onToggleSelect={onToggleSelect} onQueue={onQueue} /></div>)}
        </div>
    </div>;
};

function LibraryCard({ api, item, view, onSelect, onPlay, onToggle, onRemove, canUncollect, busy, selecting = false, selected = false, onToggleSelect, onQueue }: {
    api: JellyfinApi | null; item: MediaItem; view: LibraryView; onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void;
    onToggle: (item: MediaItem, field: 'favorite' | 'played') => void; onRemove: (item: MediaItem, mode: 'delete' | 'uncollect') => void; canUncollect: boolean; busy: boolean;
    selecting?: boolean; selected?: boolean; onToggleSelect?: (item: MediaItem) => void;
    onQueue?: (item: MediaItem, where: 'next' | 'end') => void;
}) {
    const [ menu, setMenu ] = useState(false);
    const [ confirmDelete, setConfirmDelete ] = useState(false);
    const [ playlistPicker, setPlaylistPicker ] = useState<'' | 'open' | string>('');
    const [ menuPosition, setMenuPosition ] = useState({ left: 0, top: 0 });
    const cardRef = useRef<HTMLElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const menuTriggerRef = useRef<HTMLButtonElement>(null);
    const [ director, setDirector ] = useState('');
    const pressTimer = useRef<number>();
    const longPressed = useRef(false);
    const prefetch = useItemPrefetch(api, item.Id, !selecting);
    const video = item.MediaStreams?.find(stream => stream.Type === 'Video' || stream.Type === 1);
    const audio = defaultAudioStream(item);
    const quality = mediaBadge(item);
    useEffect(() => {
        setDirector('');
        if (!api || view !== 'list' || !cardRef.current) return;
        const abort = new AbortController();
        // People on an entire 80-item page can time out on large libraries.
        // Enrich only mounted rows near the viewport, retaining just the director name.
        const loadDirector = () => {
            void api.getItemPeople(item.Id, abort.signal).then(people => {
                if (!abort.signal.aborted) setDirector(people.find(person => person.Type === 'Director')?.Name || '');
            }).catch(() => undefined);
        };
        if (typeof IntersectionObserver === 'undefined') loadDirector();
        const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); loadDirector(); }
        }, { rootMargin: '200px' });
        observer?.observe(cardRef.current);
        return () => { observer?.disconnect(); abort.abort(); };
    }, [ api, item.Id, view ]);
    const imageType = cardImageType(item, view);
    const imageWidth = view === 'list' ? 160 : view === 'poster' || view === 'compact' ? 300 : 640;
    const key = api?.imageUrl(item, imageType, imageWidth, 80) || '';
    const [ image, setImage ] = useState(() => key ? peekCachedImage(key) : '');
    useEffect(() => {
        let active = true;
        const bag: { cancel?: () => void } = {};
        if (!api || !key) return;
        const cached = peekCachedImage(key);
        if (cached) setImage(cached);
        else void api.loadImage(item, imageType, imageWidth, 80, bag).then(url => {
            if (active) {
                if (url) retainCachedImage(key);
                setImage(url);
            }
        });
        retainCachedImage(key);
        return () => { active = false; bag.cancel?.(); releaseCachedImage(key); };
    }, [ api, item.Id, key, view ]);
    const openMenu = () => {
        const rect = menuTriggerRef.current?.getBoundingClientRect();
        if (rect && !document.documentElement.classList.contains('tv-client') && window.innerWidth > 767) {
            setMenuPosition({ left: Math.max(12, Math.min(window.innerWidth - 272, rect.right - 260)), top: Math.min(window.innerHeight - 380, rect.bottom + 8) });
        }
        setMenu(true);
        window.setTimeout(() => menuRef.current?.querySelector<HTMLElement>('button')?.focus(), 0);
    };
    const closeMenu = () => { setMenu(false); setPlaylistPicker(''); window.requestAnimationFrame(() => menuTriggerRef.current?.focus()); };
    useDialogFocus(menuRef, menu, closeMenu, { initial: 'button', fallback: () => menuTriggerRef.current });
    const onPointerDown = () => { longPressed.current = false; pressTimer.current = window.setTimeout(() => { longPressed.current = true; openMenu(); }, 550); };
    const clearPress = () => { if (pressTimer.current) window.clearTimeout(pressTimer.current); };
    const metadata = [ item.ProductionYear, formatRuntime(item.RunTimeTicks) ].filter(Boolean).join(' • ');
    const progress = item.UserData?.PlayedPercentage || 0;
    const unplayedCount = item.UserData?.UnplayedItemCount || 0;
    const showWatchedCheck = !unplayedCount && Boolean(item.UserData?.Played) && item.Type !== 'Series';
    const posterOverlay = <span class="library-card-overlay"><strong>{item.Name}</strong><small>{metadata}</small></span>;
    const description = describeCard(item);
    const can = itemCapabilities(item);
    const label = description ? `${item.Name}, ${description}` : item.Name;
    return <article ref={cardRef} class={`library-card library-card-${view}${selecting ? ' selecting' : ''}${selected ? ' selected' : ''}`} data-library-item-id={item.Id} onPointerEnter={prefetch.onPointerEnter} onPointerLeave={prefetch.onPointerLeave} onFocusIn={prefetch.onFocusIn} onFocusOut={prefetch.onFocusOut}>
        <button class="library-card-open" data-focusable="true" aria-label={selecting ? t('Select {0}', label) : t('View {0}', label)} aria-pressed={selecting ? selected : undefined} onClick={() => { if (longPressed.current) { longPressed.current = false; return; } if (selecting) onToggleSelect?.(item); else onSelect(item); }} onTouchStart={onPointerDown} onTouchEnd={clearPress} onTouchMove={clearPress}>
            <span class="library-card-art"><img src={image || undefined} alt="" loading="lazy" />{!image && <span class="art-placeholder">{item.Name.slice(0, 1)}</span>}
                {selecting && <span class="library-select-check" aria-hidden="true">{selected ? '✓' : ''}</span>}
                {view !== 'list' && <>{unplayedCount > 0 && <span class="library-unplayed" aria-label={t('{0} unplayed', unplayedCount)}>{unplayedCount}</span>}{showWatchedCheck && <span class="library-watched" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="m5 12 4 4L19 6" /></svg></span>}{quality && <span class="library-quality" title={quality}>{quality}</span>}{progress > 0 && progress < 100 && <span class="library-progress"><i style={{ width: `${progress}%` }} /></span>}{posterOverlay}</>}
            </span>
            {view === 'list' && <span class="library-card-copy"><strong>{item.Name}</strong><small>{item.ProductionYear || '—'} <span>·</span> {metadataRuntime(item.RunTimeTicks)} <span>·</span> {item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : t('Unrated')} <span>·</span> {director || t('Director unknown')} <span>·</span> {[ video?.Codec, audio?.Codec ].filter(Boolean).join(' / ') || t('Codec unknown')}</small></span>}
        </button>
        {!selecting && view === 'list' && <div class="library-list-actions"><button data-focusable="true" aria-label={`${item.UserData?.IsFavorite ? t('Remove') : t('Add')} ${item.Name} ${item.UserData?.IsFavorite ? t('from') : t('to')} favorites`} disabled={busy} onClick={() => onToggle(item, 'favorite')}>{item.UserData?.IsFavorite ? '★' : '☆'}</button></div>}
        {!selecting && <div class="library-card-hover">{(can.playable || isMusicTarget(item)) && <button class="library-play-overlay" data-focusable="true" aria-label={t('Play {0}', item.Name)} onClick={() => onPlay(item)}>▶</button>}{can.canFavorite && <button class="library-card-favorite" data-focusable="true" aria-label={t('Toggle favorite')} disabled={busy} onClick={() => onToggle(item, 'favorite')}>{item.UserData?.IsFavorite ? '★' : '☆'}</button>}<button ref={menuTriggerRef} class="library-card-more" data-focusable="true" aria-label={t('More actions')} onClick={openMenu}>⋯</button></div>}
        {menu && <div class="library-menu-shade" onClick={event => { if (event.target === event.currentTarget) closeMenu(); }}><div ref={menuRef} style={!document.documentElement.classList.contains('tv-client') && window.innerWidth > 767 ? { left: `${menuPosition.left}px`, top: `${menuPosition.top}px` } : undefined} class="library-card-menu" role="menu" aria-label={t('Actions for {0}', item.Name)} onClick={e => e.stopPropagation()}><strong>{item.Name}</strong>{playlistPicker !== '' && api ? <>{playlistPicker === 'open' ? <PlaylistPicker api={api} itemIds={[ item.Id ]} onDone={text => setPlaylistPicker(text)} /> : <p class="notice success" role="status">{playlistPicker}</p>}<button data-focusable="true" role="menuitem" onClick={closeMenu}>{t('Close')}</button></> : <>{(can.playable || isMusicTarget(item)) && <button data-focusable="true" role="menuitem" onClick={() => { closeMenu(); onPlay(item); }}>{t('▶ Play')}</button>}{isMusicTarget(item) && <button data-focusable="true" role="menuitem" onClick={() => { closeMenu(); void musicEngine.instantMix(item); }}>{t('Instant Mix')}</button>}{onQueue && (queueable(item) || isMusicTarget(item)) && <><button data-focusable="true" role="menuitem" onClick={() => { closeMenu(); onQueue(item, 'next'); }}>{t('Play next')}</button><button data-focusable="true" role="menuitem" onClick={() => { closeMenu(); onQueue(item, 'end'); }}>{t('Add to queue')}</button></>}{can.canFavorite && <button data-focusable="true" role="menuitem" onClick={() => { onToggle(item, 'favorite'); closeMenu(); }}>{item.UserData?.IsFavorite ? t('Remove favorite') : t('Add favorite')}</button>}{can.canMarkPlayed && <button data-focusable="true" role="menuitem" onClick={() => { onToggle(item, 'played'); closeMenu(); }}>{t('Mark')}{' '}{item.UserData?.Played ? 'unplayed' : 'played'}</button>}{api && canAddToPlaylist(item) && <button data-focusable="true" role="menuitem" onClick={() => setPlaylistPicker('open')}>{t('Add to playlist…')}</button>}<button data-focusable="true" role="menuitem" onClick={() => { closeMenu(); onSelect(item); }}>{t('Open details')}</button>{canUncollect && <button data-focusable="true" role="menuitem" onClick={() => { closeMenu(); onRemove(item, 'uncollect'); }}>{t('Remove from collection')}</button>}{item.CanDelete && (confirmDelete
            ? <button data-focusable="true" role="menuitem" class="danger" onClick={() => { setConfirmDelete(false); closeMenu(); onRemove(item, 'delete'); }}>{t('Confirm: delete from server')}</button>
            : <button data-focusable="true" role="menuitem" onClick={() => setConfirmDelete(true)}>{t('Delete…')}</button>)}<button data-focusable="true" role="menuitem" onClick={() => { setConfirmDelete(false); closeMenu(); }}>{t('Close')}</button></>}</div></div>}
    </article>;
}

const TICKS_PER_MINUTE = 600000000;

function formatRuntime(ticks?: number): string {
    if (!ticks) return '';
    const minutes = Math.round(ticks / TICKS_PER_MINUTE);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function metadataRuntime(ticks?: number): string {
    return formatRuntime(ticks) || 'Runtime unknown';
}

type LibraryStream = NonNullable<MediaItem['MediaStreams']>[number];

function defaultAudioStream(item: MediaItem): LibraryStream | undefined {
    const audio = (item.MediaStreams || []).filter(stream => stream.Type === 'Audio' || stream.Type === 0);
    return audio.find(stream => stream.IsDefault) || audio[0];
}

function mediaBadge(item: MediaItem): string {
    const video = item.MediaStreams?.find(stream => stream.Type === 'Video' || stream.Type === 1);
    if (!video) return '';
    const width = video.Width || item.Width || 0;
    const height = video.Height || item.Height || 0;
    const uhd = width >= 3200 || height >= 2000;
    const rangeType = (video.VideoRangeType || '').toUpperCase();
    const range = rangeType.indexOf('DOVI') === 0 ? 'DV' : (video.VideoRange || '').toUpperCase() === 'HDR' ? 'HDR' : '';
    if (uhd) return range ? `4K ${range}` : '4K';
    if (range) return range === 'DV' ? 'Dolby Vision' : 'HDR';
    return audioBadge(defaultAudioStream(item));
}

function audioBadge(stream?: LibraryStream): string {
    if (!stream) return '';
    const profile = (stream.Profile || '').toLowerCase();
    const codec = (stream.Codec || '').toLowerCase();
    let label: string;
    if (profile.indexOf('atmos') >= 0) return 'Atmos';
    if (profile.indexOf('dts:x') >= 0 || profile.indexOf('dts-x') >= 0) return 'DTS:X';
    if (codec === 'truehd') label = 'TrueHD';
    else if (codec === 'dts' || codec === 'dca') label = profile.indexOf('ma') >= 0 ? 'DTS-HD MA' : 'DTS';
    else if (codec === 'eac3') label = 'DD+';
    else if (codec === 'ac3') label = 'DD';
    else if (codec === 'aac' || codec === 'flac' || codec === 'opus' || codec === 'mp3') label = codec.toUpperCase();
    else return '';
    const channels = stream.Channels || 0;
    const layout = channels >= 8 ? '7.1' : channels >= 6 ? '5.1' : '';
    return layout ? `${label} ${layout}` : label;
}

/** Library-local Continue watching, Next up, Latest and recommendation rows (Jellyfin Web's Suggestions tab). */
function LibrarySuggestions({ api, library, onSelect, onPlay }: { api: JellyfinApi | null; library: MediaItem; onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void }) {
    const [ rows, setRows ] = useState<Array<{ title: string; items: MediaItem[] }> | null>(null);
    const [ error, setError ] = useState('');
    const [ attempt, setAttempt ] = useState(0);
    useEffect(() => {
        let active = true;
        setRows(null);
        setError('');
        if (!api) return;
        void api.getLibrarySuggestions(library).then(next => { if (active) setRows(next); }).catch(cause => { if (active) setError(userMessage(cause, t('Suggestions could not load.'))); });
        return () => { active = false; };
    }, [ api, library.Id, attempt ]);
    if (error) return <div class="home-section-error" role="alert"><p>{error}</p><button class="button secondary" data-focusable="true" onClick={() => setAttempt(value => value + 1)}>{t('Retry')}</button></div>;
    if (!rows) return <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />{t('Loading suggestions…')}</div>;
    if (!rows.length) return <div class="empty-state"><span aria-hidden="true">✳</span><h2>{t('No suggestions yet')}</h2><p>{t('Watch something from this library to get suggestions here.')}</p></div>;
    return <div class="library-suggestions">{rows.map(row => <MediaRow key={row.title} api={api} title={row.title} items={row.items} onOpen={onSelect} onPlay={onPlay} />)}</div>;
}
