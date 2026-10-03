import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { JellyfinApi, peekCachedImage, releaseCachedImage, retainCachedImage } from './api';
import { defaultLibraryQuery } from './library-query';
import type { LibraryQuery } from './library-query';
import type { ItemResponse, MediaItem } from './types';

const PAGE_SIZE = 80;
const WINDOW_SIZE = PAGE_SIZE * 3;
const LETTERS = [ '#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ' ];
const T9: Record<string, string> = { '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ' };

type LibraryView = 'poster' | 'compact' | 'list';

export function LibraryPage({ api, library, onBack, onSelect, onPlay }: {
    api: JellyfinApi | null;
    library: MediaItem;
    onBack: () => void;
    onSelect: (item: MediaItem) => void;
    onPlay: (item: MediaItem) => void;
}) {
    const [ query, setQuery ] = useState<LibraryQuery>(defaultLibraryQuery);
    const [ view, setView ] = useState<LibraryView>('poster');
    const [ genres, setGenres ] = useState<Array<{ Name?: string; Id?: string }>>([]);
    const [ years, setYears ] = useState<number[]>([]);
    const [ items, setItems ] = useState<MediaItem[]>([]);
    const [ startIndex, setStartIndex ] = useState(0);
    const [ total, setTotal ] = useState(0);
    const [ loading, setLoading ] = useState(false);
    const [ error, setError ] = useState('');
    const [ filterOpen, setFilterOpen ] = useState(false);
    const [ busyId, setBusyId ] = useState('');
    const [ scrubLetter, setScrubLetter ] = useState('');
    const [ scrubBubbleY, setScrubBubbleY ] = useState(0);
    const [ activeLetter, setActiveLetter ] = useState('#');
    const [ tvAlphaOpen, setTvAlphaOpen ] = useState(false);
    const [ scrolling, setScrolling ] = useState(false);
    const [ scrollProgress, setScrollProgress ] = useState(0);
    const [ sortControl, setSortControl ] = useState(`${query.SortBy}:${query.SortOrder}`);
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
    const itemsRef = useRef<MediaItem[]>(items);
    const startIndexRef = useRef(startIndex);
    const totalRef = useRef(total);
    const previousLoad = useRef({ libraryId: library.Id, query, view });
    const titleSort = query.SortBy === 'SortName';
    const isTvLibrary = library.CollectionType?.toLowerCase() === 'tvshows';
    const selectedYears = useMemo(() => query.Decade ? Array.from({ length: 10 }, (_value, offset) => Number(query.Decade) + offset) : undefined, [ query.Decade ]);
    const activeFilterCount = Number(Boolean(query.Genre)) + Number(Boolean(query.Resolution)) + Number(Boolean(query.Decade)) + Number(Boolean(query.WatchStatus));

    const load = useCallback(async (absoluteStart: number, replace: boolean, nextQuery = query, nextView = view, scroll = false) => {
        if (!api || requestActive.current || jumpPending.current || scrubMoved.current) return;
        const currentGeneration = generation.current;
        const requestId = ++requestOwner.current;
        const abort = new AbortController();
        catalogRequest.current = abort;
        requestActive.current = true;
        setLoading(true);
        setError('');
        try {
            const response = await api.getItems(library.Id, absoluteStart, undefined, isTvLibrary ? [ 'Series' ] : undefined, !isTvLibrary, PAGE_SIZE, {
                Query: nextQuery,
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
            if (currentGeneration === generation.current) setError(e instanceof Error ? e.message : 'Library items could not load.');
        } finally {
            if (requestOwner.current === requestId) {
                requestActive.current = false;
                setLoading(false);
            }
        }
    }, [ api, library.Id, isTvLibrary, query, view, selectedYears, total, startIndex ]);

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

    useEffect(() => () => {
        generation.current += 1;
        requestOwner.current += 1;
        catalogRequest.current?.abort();
    }, []);

    useEffect(() => {
        let active = true;
        setGenres([]);
        setYears([]);
        if (!api) return;
        void Promise.all([ api.getGenres(library.Id), api.getYears(library.Id) ]).then(([ nextGenres, nextYears ]) => {
            if (!active) return;
            setGenres(nextGenres.filter(item => item.Name).sort((a, b) => (a.Name || '').localeCompare(b.Name || '')));
            setYears(nextYears);
        }).catch(() => undefined);
        return () => { active = false; };
    }, [ api, library.Id ]);

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
        const onlyViewChanged = previousLoad.current.libraryId === library.Id && previousLoad.current.query === query && previousLoad.current.view !== view;
        previousLoad.current = { libraryId: library.Id, query, view };
        generation.current += 1;
        catalogRequest.current?.abort();
        pendingJump.current = null;
        letterAnchor.current = null;
        letterOffsets.current.clear();
        requestOwner.current += 1;
        requestActive.current = false;
        jumpPending.current = false;
        setItems([]);
        if (onlyViewChanged) void load(startIndex, true, query, view);
        else {
            setStartIndex(0);
            setTotal(0);
            void load(0, true, query, view);
        }
        // Initial request per library and when filter/sort/view changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ library.Id, query, view, selectedYears ]);

    const requestPage = useCallback(async (offset: number, prepend = false) => {
        if (!api || requestActive.current || jumpPending.current || scrubMoved.current || offset < 0 || offset >= totalRef.current) return;
        requestActive.current = true;
        const currentGeneration = generation.current;
        const requestId = ++requestOwner.current;
        const abort = new AbortController();
        catalogRequest.current = abort;
        setLoading(true);
        setError('');
        try {
            const response: ItemResponse = await api.getItems(library.Id, offset, undefined, isTvLibrary ? [ 'Series' ] : undefined, !isTvLibrary, PAGE_SIZE, {
                Query: query, StartIndex: offset, Limit: PAGE_SIZE, Years: selectedYears, Signal: abort.signal
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
            if (currentGeneration === generation.current) setError(e instanceof Error ? e.message : 'Library items could not load.');
        } finally {
            if (requestOwner.current === requestId) {
                requestActive.current = false;
                setLoading(false);
            }
        }
    }, [ api, library.Id, isTvLibrary, query, selectedYears, view ]);
    const currentItemsLength = useRef(0);
    currentItemsLength.current = items.length;
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
                setTvAlphaOpen(true);
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

    const setFilter = (key: keyof LibraryQuery, value: string) => reset({ ...query, [key]: value } as LibraryQuery);
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
                        const probe = await api.getItems(library.Id, middle, undefined, isTvLibrary ? [ 'Series' ] : undefined, !isTvLibrary, 1, {
                            Query: query, Limit: 1, Years: selectedYears, Fields: 'SortName', Signal: abort.signal
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
            const page = await api.getItems(library.Id, pageStart, undefined, isTvLibrary ? [ 'Series' ] : undefined, !isTvLibrary, PAGE_SIZE, {
                Query: query, Limit: PAGE_SIZE, Years: selectedYears, Signal: abort.signal
            }, 3);
            if (requestGeneration !== generation.current) return;
            pendingJump.current = { index: target, generation: requestGeneration, letter: requested };
            setItems(page.Items || []);
            setStartIndex(pageStart);
            setTotal(page.TotalRecordCount ?? totalRef.current);
            setActiveLetter(requested);
        } catch (error) {
            if (requestGeneration === generation.current) setError(error instanceof Error ? error.message : 'Could not jump to that title.');
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
            if (field === 'favorite') await api.setFavorite(item.Id, next);
            else await api.setPlayed(item.Id, next);
            setItems(current => current.map(entry => entry.Id === item.Id ? { ...entry, UserData: { ...entry.UserData, ...(field === 'favorite' ? { IsFavorite: next } : { Played: next, UnplayedItemCount: next ? 0 : 1 }) } } : entry));
        } catch (e) { setError(e instanceof Error ? e.message : 'Could not update item.'); }
        finally { setBusyId(''); }
    };

    const yearOptions = Array.from(new Set(years.map(year => Math.floor(year / 10) * 10))).sort((a, b) => b - a);
    const countLabel = isTvLibrary ? 'shows' : 'titles';
    const filterButton = <button class="library-filter-open" data-focusable="true" aria-expanded={filterOpen} onClick={() => setFilterOpen(open => !open)}>Filters{activeFilterCount > 0 && <span class="filter-count-pill">{activeFilterCount}</span>} <span aria-hidden="true">⌄</span></button>;
    const rail = <div class="library-controls library-toolbar" data-focusable="scope">
        <span class="library-count">{total.toLocaleString()} {countLabel}</span>
        <div class="library-operation-controls">
            {filterButton}
            <Select label="Sort" value={sortControl} onChange={selectSort} options={[[ 'SortName:Ascending', 'Sort: Title (A-Z)' ], [ 'SortName:Descending', 'Sort: Title (Z-A)' ], [ 'PremiereDate:Descending', 'Sort: Release date (newest)' ], [ 'PremiereDate:Ascending', 'Sort: Release date (oldest)' ], [ 'DateCreated:Descending', 'Sort: Date added (newest)' ], [ 'CriticRating:Descending', 'Sort: Rating (high-low)' ], [ 'Runtime:Descending', 'Sort: Runtime' ]]} />
        {!document.documentElement.classList.contains('tv-client') && <ViewSwitch view={view} onChange={next => reset(query, next)} />}
        </div>
    </div>;

    return <section class={titleSort ? 'library-page has-alpha' : 'library-page'}>
        <header class="library-sticky">
            {rail}
        </header>
        {titleSort && !document.documentElement.classList.contains('tv-client') && <nav class="alpha-scrubber" aria-label="Jump to title" data-focusable="scope" onPointerDown={startScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={cancelScrub}>
            {(query.SortOrder === 'Descending' ? LETTERS.slice().reverse() : LETTERS).map(letter => <button key={letter} data-letter={letter} data-focusable="true" class={activeLetter === letter ? 'active' : ''} aria-label={letter === '#' ? 'Numbers and symbols' : letter} onClick={event => clickScrubLetter(event, letter)}>{letter}</button>)}
        </nav>}
        {!titleSort && <div class={`library-scroll-progress${scrolling ? ' visible' : ''}`} aria-hidden="true"><i style={{ height: `${Math.max(4, scrollProgress * 100)}%` }} /></div>}
        {scrubLetter && <span class="alpha-bubble" style={{ top: `${scrubBubbleY}px` }} aria-hidden="true">{scrubLetter}</span>}
        {filterOpen && <div class="library-filter-popover" role="group" aria-label="Library filters">
            <Select label="Genre" value={query.Genre} onChange={value => setFilter('Genre', value)} options={[ [ '', 'Genre' ], ...genres.map(g => [ g.Name || '', g.Name || '' ] as [string, string]) ]} />
            <Select label="Resolution" value={query.Resolution} onChange={value => setFilter('Resolution', value)} options={[[ '', 'Resolution' ], [ '4k', '4K' ], [ '1080p', '1080p' ]]} />
            <Select label="Decade" value={query.Decade} onChange={value => setFilter('Decade', value)} options={[[ '', 'Decade' ], ...yearOptions.map(year => [ String(year), `${year}s` ] as [string, string])]} />
            <Select label="Watch status" value={query.WatchStatus} onChange={value => setFilter('WatchStatus', value)} options={[[ '', 'Watch status' ], [ 'unplayed', 'Unplayed' ], [ 'resumable', 'In progress' ], [ 'favorite', 'Favorites' ]]} />
        </div>}
        {error && <div class="home-section-error" role="alert"><p>{error}</p><button class="button secondary" data-focusable="true" onClick={() => void load(startIndex, true)}>Retry</button></div>}
        {items.length > 0 && <VirtualizedLibraryGrid gridRef={grid} items={items} startIndex={startIndex} total={total} api={api} view={view} onSelect={onSelect} onPlay={onPlay} onToggle={toggleUserData} busyId={busyId} />}
        {loading && <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />{items.length ? 'Loading titles…' : 'Loading library…'}</div>}
        {!loading && !items.length && !error && <div class="empty-state"><span aria-hidden="true">✳</span><h2>Nothing here yet</h2><p>This library does not contain any matching items.</p></div>}
        {tvAlphaOpen && <div class="tv-alpha-layer" role="presentation" onClick={event => { if (event.target === event.currentTarget) setTvAlphaOpen(false); }}><section class="tv-alpha-dialog" role="dialog" aria-modal="true" aria-label="Jump to title"><div class="library-sheet-heading"><h2>Jump to title</h2><button data-focusable="true" aria-label="Close letters" onClick={() => setTvAlphaOpen(false)}>×</button></div><div class="tv-alpha-letters">{LETTERS.map(letter => <button key={letter} data-focusable="true" onClick={() => { setTvAlphaOpen(false); void jumpToLetter(letter); }}>{letter}</button>)}</div></section></div>}
    </section>;
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
    return <label class="library-select"><span class="visually-hidden">{label}</span><select data-focusable="true" aria-label={label} value={value} onChange={event => onChange((event.currentTarget as HTMLSelectElement).value)}>{options.map(([ option, text ]) => <option value={option} key={option}>{text}</option>)}</select></label>;
}

function ViewSwitch({ view, onChange }: { view: LibraryView; onChange: (view: LibraryView) => void }) {
    return <div class="library-view-switch" role="group" aria-label="Library view">{([ [ 'poster', 'Grid' ], [ 'list', 'List' ] ] as Array<[LibraryView, string]>).map(([ key, label ]) => <button data-focusable="true" key={key} class={view === key ? 'active' : ''} aria-label={`${label} view`} aria-pressed={view === key} onClick={() => onChange(key)}>{label}</button>)}</div>;
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
    // Geometry must be independent of mounted cards (and their hover/focus transforms).
    if (view === 'list') return 92 + gapY;
    const columns = columnCount(element);
    const gapX = parseFloat(style.columnGap || '0') || 0;
    const contentWidth = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const width = (contentWidth - gapX * (columns - 1)) / columns;
    return width * 1.5 + (view === 'poster' ? 49 : 0) + gapY;
}

interface GridProps {
    items: MediaItem[]; startIndex: number; total: number; api: JellyfinApi | null; view: LibraryView;
    onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void;
    onToggle: (item: MediaItem, field: 'favorite' | 'played') => void; busyId: string;
}

const VirtualizedLibraryGrid = ({ items, startIndex, total, api, view, onSelect, onPlay, onToggle, busyId, gridRef }: GridProps & { gridRef: { current: HTMLDivElement | null } }) => {
    const elementRef = gridRef;
    const [ range, setRange ] = useState({ firstRow: 0, endRow: 4, columns: 5, height: 400, gap: 0 });
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
    }, [ items.length, view, startIndex ]);
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
    return <div ref={elementRef} class={`library-grid-items library-view-${view}`} style={{ position: 'relative', height: `${Math.max(0, canvasHeight)}px`, '--library-columns': columns } as any}>
        <div class="library-grid-window" style={{ position: 'absolute', top: `${paddingTop + firstRow * range.height}px`, left: gridStyle?.paddingLeft || '32px', right: gridStyle?.paddingRight || '36px', display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gridStyle?.columnGap || '16px', rowGap: `${range.gap}px` }}>
            {Array.from({ length: leading }, (_value, index) => <div key={`lead-${index}`} class="library-grid-gap" aria-hidden="true" />)}
            {visible.map(item => <LibraryCard key={item.Id} api={api} item={item} view={view} onSelect={onSelect} onPlay={onPlay} onToggle={onToggle} busy={busyId === item.Id} />)}
        </div>
    </div>;
};

function LibraryCard({ api, item, view, onSelect, onPlay, onToggle, busy }: {
    api: JellyfinApi | null; item: MediaItem; view: LibraryView; onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void;
    onToggle: (item: MediaItem, field: 'favorite' | 'played') => void; busy: boolean;
}) {
    const [ menu, setMenu ] = useState(false);
    const cardRef = useRef<HTMLElement>(null);
    const [ director, setDirector ] = useState('');
    const pressTimer = useRef<number>();
    const longPressed = useRef(false);
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
    const key = api?.imageUrl(item, 'Primary', view === 'list' ? 160 : 300, 80) || '';
    const [ image, setImage ] = useState(() => key ? peekCachedImage(key) : '');
    useEffect(() => {
        let active = true;
        const bag: { cancel?: () => void } = {};
        if (!api || !key) return;
        const cached = peekCachedImage(key);
        if (cached) setImage(cached);
        else void api.loadImage(item, 'Primary', view === 'list' ? 160 : 300, 80, bag).then(url => {
            if (active) {
                if (url) retainCachedImage(key);
                setImage(url);
            }
        });
        retainCachedImage(key);
        return () => { active = false; bag.cancel?.(); releaseCachedImage(key); };
    }, [ api, item.Id, key, view ]);
    const openMenu = () => { setMenu(true); window.setTimeout(() => document.querySelector<HTMLElement>('.library-card-menu button')?.focus(), 0); };
    const onPointerDown = () => { longPressed.current = false; pressTimer.current = window.setTimeout(() => { longPressed.current = true; openMenu(); }, 550); };
    const clearPress = () => { if (pressTimer.current) window.clearTimeout(pressTimer.current); };
    const metadata = [ item.ProductionYear, formatRuntime(item.RunTimeTicks) ].filter(Boolean).join(' • ');
    const progress = item.UserData?.PlayedPercentage || 0;
    const unplayedCount = item.UserData?.UnplayedItemCount || 0;
    const showUnplayedDot = !unplayedCount && !item.UserData?.Played && !progress && item.Type !== 'Series';
    return <article ref={cardRef} class={`library-card library-card-${view}`} data-library-item-id={item.Id}>
        <button class="library-card-open" data-focusable="true" aria-label={`View ${item.Name}`} onClick={() => { if (longPressed.current) { longPressed.current = false; return; } onSelect(item); }} onTouchStart={onPointerDown} onTouchEnd={clearPress} onTouchMove={clearPress}>
            <span class="library-card-art"><img src={image || undefined} alt="" loading="lazy" />{!image && <span class="art-placeholder">{item.Name.slice(0, 1)}</span>}
                {view !== 'list' && <>{unplayedCount > 0 && <span class="library-unplayed" aria-label={`${unplayedCount} unplayed`}>{unplayedCount}</span>}{showUnplayedDot && <span class="library-unplayed-dot" aria-label="Unplayed" />}{quality && <span class="library-quality" title={quality}>{quality}</span>}{progress > 0 && progress < 100 && <span class="library-progress"><i style={{ width: `${progress}%` }} /></span>}</>}
            </span>
            {view !== 'compact' && <span class="library-card-copy"><strong>{item.Name}</strong>{view === 'poster' ? <small>{metadata}</small> : <small>{item.ProductionYear || '—'} <span>·</span> {metadataRuntime(item.RunTimeTicks)} <span>·</span> {item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : 'Unrated'} <span>·</span> {director || 'Director unknown'} <span>·</span> {[ video?.Codec, audio?.Codec ].filter(Boolean).join(' / ') || 'Codec unknown'}</small>}</span>}
        </button>
        {view === 'list' && <div class="library-list-actions"><button data-focusable="true" aria-label={`${item.UserData?.IsFavorite ? 'Remove' : 'Add'} ${item.Name} ${item.UserData?.IsFavorite ? 'from' : 'to'} favorites`} disabled={busy} onClick={() => onToggle(item, 'favorite')}>{item.UserData?.IsFavorite ? '★' : '☆'}</button></div>}
        <div class="library-card-hover"><button class="library-play-overlay" data-focusable="true" aria-label={`Play ${item.Name}`} onClick={() => onPlay(item)}>▶</button><button class="library-card-favorite" data-focusable="true" aria-label="Toggle favorite" disabled={busy} onClick={() => onToggle(item, 'favorite')}>{item.UserData?.IsFavorite ? '★' : '☆'}</button><button class="library-card-more" data-focusable="true" aria-label="More actions" onClick={openMenu}>⋯</button></div>
        {menu && <div class="library-menu-shade" onClick={() => setMenu(false)}><div class="library-card-menu" role="menu" onClick={e => e.stopPropagation()}><button data-focusable="true" role="menuitem" onClick={() => { setMenu(false); onPlay(item); }}>▶ Play</button><button data-focusable="true" role="menuitem" onClick={() => { onToggle(item, 'favorite'); setMenu(false); }}>{item.UserData?.IsFavorite ? 'Remove favorite' : 'Add favorite'}</button><button data-focusable="true" role="menuitem" onClick={() => { onToggle(item, 'played'); setMenu(false); }}>Mark {item.UserData?.Played ? 'unplayed' : 'played'}</button><button data-focusable="true" role="menuitem" onClick={() => { setMenu(false); onSelect(item); }}>Open details</button><button data-focusable="true" role="menuitem" onClick={() => setMenu(false)}>Close</button></div></div>}
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
