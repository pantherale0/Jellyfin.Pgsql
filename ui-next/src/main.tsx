import { h, render } from 'preact';
import { memo, lazy, Suspense } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { JellyfinApi, peekCachedImage, releaseCachedImage, retainCachedImage } from './api';
import { classicWebAvailable } from './build-features';
import { LiveTvPage } from './live-tv';
import { LibraryPage } from './library';
import { Player } from './player';
import { ProfileScreen, type ProfileScreenName } from './profile';
import { buildHomeFeedBlocks, HomeFeed } from './home-feed';
import { clearRememberedToken, getRememberedUsers, rememberUser, type RememberedUser } from './remembered-users';
import { episodeCode, formatClock, isAiring } from './live-model';
import { canCommitSsoRestore, parseSsoHandoff, SSO_HANDOFF_KEY, UI_NEXT_SIGNED_OUT_KEY } from './sso-session';
import type { PlaybackChoice } from './player-model';
import type { LiveTab, MediaItem, RecommendationGroup, Session } from './types';
import { enterShowSeason, moveShowFocus, type Context, type Direction, type EpisodeControl, type ShowBookmark, type ShowFocusResult, type ShowTarget } from './show-navigation';
import './style.css';

const AdminDashboard = lazy(() => import('./admin/admin-dashboard').then(module => ({ default: module.AdminDashboard })));

const SESSION_KEY = 'jellyfin-ui-next-session';
const SAVED_SERVER_KEY = 'jellyfin-ui-next-server';
const SIGNED_OUT_KEY = UI_NEXT_SIGNED_OUT_KEY;
const configuredServer = import.meta.env.VITE_JELLYFIN_SERVER_URL?.trim() || '';
const classicWebLinksAvailable = classicWebAvailable(import.meta.env.VITE_CLASSIC_WEB_AVAILABLE);

function comparableServer(server: string): string | null {
    try {
        const url = new URL(server);
        url.pathname = url.pathname.replace(/\/(web|web\/index\.html)\/?$/i, '').replace(/\/$/, '');
        return url.origin + url.pathname;
    } catch (_error) {
        return null;
    }
}

function queryParameter(name: string): string | null {
    const parts = window.location.search.replace(/^\?/, '').split('&');
    for (let i = 0; i < parts.length; i++) {
        const pair = parts[i].split('=');
        if (decodeURIComponent(pair[0].replace(/\+/g, ' ')) === name) {
            return decodeURIComponent((pair.slice(1).join('=') || '').replace(/\+/g, ' '));
        }
    }
    return null;
}

function parseLiveTab(value: string | null): LiveTab {
    if (value === 'guide' || value === 'channels' || value === 'dvr' || value === 'now') return value;
    return 'now';
}

function isTvClient(): boolean {
    const ua = navigator.userAgent.toLowerCase();
    return /web0s|webos|tizen|smart[- ]?tv|samsungbrowser|netcast|vidaa|titanos|roku|playstation|xbox|android tv|jellyfin.*tv|aft[a-z0-9]+/.test(ua)
        || Boolean((window as Window & { NativeShell?: unknown }).NativeShell);
}

type ContentOrigin =
    | { kind: 'show'; bookmark: ShowBookmark }
    | { kind: 'home' | 'library' | 'search' | 'live'; scrollY: number };

type PlaybackOrigin = ContentOrigin | { kind: 'details'; item: MediaItem; parent: ContentOrigin; scrollY: number };

interface FocusEntry {
    element: HTMLElement;
    left: number;
    top: number;
    width: number;
    height: number;
}

let focusScan: { at: number; scrollX: number; scrollY: number; entries: FocusEntry[] } | null = null;

function collectFocusEntries(root: ParentNode): FocusEntry[] {
    const nodes = root.querySelectorAll<HTMLElement>('[data-focusable="true"]');
    const entries: FocusEntry[] = [];
    for (let index = 0; index < nodes.length; index++) {
        const element = nodes[index];
        // A disabled control swallows .focus() with no effect, so offering
        // one as a navigation target pins remote users with no feedback.
        if ((element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true') continue;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) entries.push({ element, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
    return entries;
}

function focusEntries(): FocusEntry[] {
    const now = performance.now();
    if (focusScan && now - focusScan.at < 120 && focusScan.scrollX === window.scrollX && focusScan.scrollY === window.scrollY) return focusScan.entries;
    const entries = collectFocusEntries(document);
    focusScan = { at: now, scrollX: window.scrollX, scrollY: window.scrollY, entries };
    return entries;
}

function focusTarget(entries: FocusEntry[], current: HTMLElement, direction: [number, number]): { known: boolean; element: HTMLElement | null } {
    let currentEntry: FocusEntry | null = null;
    for (let index = 0; index < entries.length; index++) {
        if (entries[index].element === current) {
            currentEntry = entries[index];
            break;
        }
    }
    if (!currentEntry) return { known: false, element: null };
    const cx = currentEntry.left + currentEntry.width / 2;
    const cy = currentEntry.top + currentEntry.height / 2;
    const cRight = currentEntry.left + currentEntry.width;
    const cBottom = currentEntry.top + currentEntry.height;
    let nearest: HTMLElement | null = null;
    let nearestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (entry.element === current) continue;
        const dx = entry.left + entry.width / 2 - cx;
        const dy = entry.top + entry.height / 2 - cy;
        const primary = direction[0] ? dx * direction[0] : dy * direction[1];
        const cross = direction[0] ? Math.abs(dy) : Math.abs(dx);
        // Wide controls (keyboard space bar, rails) center far from their
        // edge, so pure center geometry prefers a slightly-offset near key
        // over the directly-adjacent same-row key. Prefer candidates that
        // share the current element's cross-axis band.
        const overlap = direction[0]
            ? Math.min(entry.top + entry.height, cBottom) - Math.max(entry.top, currentEntry.top)
            : Math.min(entry.left + entry.width, cRight) - Math.max(entry.left, currentEntry.left);
        if (primary > 4) {
            const score = primary + cross * 2 + (overlap > 0 ? 0 : 1000);
            if (score < nearestScore) {
                nearest = entry.element;
                nearestScore = score;
            }
        }
    }
    return { known: true, element: nearest };
}

function mergeMeasuredHeights(current: Record<string, number>, heights: Record<string, number>): Record<string, number> {
    let changed = false;
    const next = { ...current };
    Object.keys(heights).forEach(id => {
        if (Math.abs((current[id] || 0) - heights[id]) > 8) {
            next[id] = heights[id];
            changed = true;
        }
    });
    return changed ? next : current;
}

function readSession(): Session | null {
    try {
        if (localStorage.getItem(SIGNED_OUT_KEY) === 'true') return null;
        if (queryParameter('server') !== null) return null;
        let raw = localStorage.getItem(SESSION_KEY);
        if (!raw) {
            // Migrate sessions created by earlier UI Next builds.
            raw = sessionStorage.getItem(SESSION_KEY);
            if (raw) {
                localStorage.setItem(SESSION_KEY, raw);
                sessionStorage.removeItem(SESSION_KEY);
            }
        }
        if (!raw) return null;
        const candidate = JSON.parse(raw) as Partial<Session>;
        if (configuredServer && comparableServer(candidate.server || '') !== comparableServer(configuredServer)) return null;
        const serverUrl = new URL(candidate.server || '');
        const validProtocol = serverUrl.protocol === 'https:' || serverUrl.protocol === 'http:' && (import.meta.env.DEV || serverUrl.hostname === 'localhost' || serverUrl.hostname === '127.0.0.1' || serverUrl.origin === window.location.origin);
        if (!validProtocol || serverUrl.username || serverUrl.password || serverUrl.search || serverUrl.hash || typeof candidate.token !== 'string' || !candidate.token || typeof candidate.user?.Id !== 'string' || typeof candidate.user.Name !== 'string') {
            localStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(SESSION_KEY);
            return null;
        }
        return candidate as Session;
    } catch (_error) {
        try { localStorage.removeItem(SESSION_KEY); } catch (_storageError) { /* Storage may be disabled. */ }
        return null;
    }
}

function getSavedServer(): string {
    try {
        if (configuredServer) return configuredServer;
        const targetServer = queryParameter('server');
        if (targetServer) return targetServer;
        return localStorage.getItem(SAVED_SERVER_KEY) || window.location.origin;
    } catch (_error) {
        return window.location.origin;
    }
}

function App() {
    const [ session, setSession ] = useState<Session | null>(() => readSession());
    const [ ssoHandoffAttempt, setSsoHandoffAttempt ] = useState<string | null>(() => {
        try { return sessionStorage.getItem(SSO_HANDOFF_KEY); } catch (_error) { return null; }
    });
    const [ view, setView ] = useState<'home' | 'library' | 'show' | 'search' | 'details' | 'player' | 'live' | 'profile' | 'admin'>(() => window.location.hash.startsWith('#admin/') ? 'admin' : 'home');
    const [ profileScreen, setProfileScreen ] = useState<ProfileScreenName>('playback');
    const [ profileMenuOpen, setProfileMenuOpen ] = useState(false);
    const [ rememberedUsers, setRememberedUsers ] = useState<RememberedUser[]>([]);
    const [ isAdministrator, setIsAdministrator ] = useState(false);
    const [ adminAccessChecked, setAdminAccessChecked ] = useState(false);
    const [ liveTab, setLiveTab ] = useState<LiveTab>('now');
    const [ server, setServer ] = useState(getSavedServer);
    const [ username, setUsername ] = useState('');
    const [ password, setPassword ] = useState('');
    const [ error, setError ] = useState('');
    const [ busy, setBusy ] = useState(false);
    const [ views, setViews ] = useState<MediaItem[]>([]);
    const [ resumeItems, setResumeItems ] = useState<MediaItem[]>([]);
    const [ latestItems, setLatestItems ] = useState<MediaItem[]>([]);
    const [ recommendations, setRecommendations ] = useState<MediaItem[]>([]);
    const [ recommendationGroups, setRecommendationGroups ] = useState<RecommendationGroup[]>([]);
    const [ homeCollections, setHomeCollections ] = useState<MediaItem[]>([]);
    const [ homeOnNow, setHomeOnNow ] = useState<MediaItem[]>([]);
    const [ homeVaultCandidates, setHomeVaultCandidates ] = useState<MediaItem[]>([]);
    const [ homeExploreItems, setHomeExploreItems ] = useState<MediaItem[]>([]);
    const [ homeExploreStart, setHomeExploreStart ] = useState(0);
    const [ homeExploreTotal, setHomeExploreTotal ] = useState(0);
    const [ loadingHomeExplore, setLoadingHomeExplore ] = useState(false);
    const [ activeRecommendation, setActiveRecommendation ] = useState(0);
    const [ recommendationDirection, setRecommendationDirection ] = useState<'next' | 'previous'>('next');
    const [ recommendationsLoading, setRecommendationsLoading ] = useState(false);
    const [ homeLoading, setHomeLoading ] = useState({ views: false, resume: false, latest: false });
    const [ homeErrors, setHomeErrors ] = useState<{ views: string; resume: string; latest: string }>({ views: '', resume: '', latest: '' });
    const [ activeLibrary, setActiveLibrary ] = useState<MediaItem | null>(null);
    const [ tvSeries, setTvSeries ] = useState<MediaItem | null>(null);
    const [ showSeasons, setShowSeasons ] = useState<MediaItem[]>([]);
    const [ activeSeasonId, setActiveSeasonId ] = useState('');
    const [ episodesBySeason, setEpisodesBySeason ] = useState<Record<string, MediaItem[]>>({});
    const [ loadingSeasons, setLoadingSeasons ] = useState<Record<string, boolean>>({});
    const [ seasonSpacerHeights, setSeasonSpacerHeights ] = useState<Record<string, number>>({});
    const [ items, setItems ] = useState<MediaItem[]>([]);
    const [ selected, setSelected ] = useState<MediaItem | null>(null);
    const [ showRestore, setShowRestore ] = useState<ShowBookmark | null>(null);
    const [ contentRestore, setContentRestore ] = useState<{ kind: 'home' | 'library' | 'search' | 'live'; scrollY: number } | null>(null);
    const [ detailRestore, setDetailRestore ] = useState<{ itemId: string; scrollY: number } | null>(null);
    const detailOrigin = useRef<ContentOrigin | null>(null);
    const playbackOrigin = useRef<PlaybackOrigin | null>(null);
    const detailRequest = useRef(0);
    const playbackRequest = useRef(0);
    const renderedView = useRef(view);
    renderedView.current = view;
    const [ search, setSearch ] = useState('');
    const [ searchDraft, setSearchDraft ] = useState('');
    const searchReq = useRef(0);
    const searchReturn = useRef(false);
    const [ searchExpanded, setSearchExpanded ] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const lastFocusRect = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
    const lastModality = useRef<'keyboard' | 'pointer'>('pointer');
    const [ playerUrl, setPlayerUrl ] = useState('');
    const [ playerItem, setPlayerItem ] = useState<MediaItem | null>(null);
    const [ playback, setPlayback ] = useState<PlaybackChoice | null>(null);
    const [ loading, setLoading ] = useState(false);
    const [ isMobileNavOpen, setIsMobileNavOpen ] = useState(false);
    const [ persistentSession, setPersistentSession ] = useState(true);
    const [ ssoEnabled, setSsoEnabled ] = useState<boolean | null>(null);
    const [ ssoCheckFailed, setSsoCheckFailed ] = useState(false);
    const [ quickConnectEnabled, setQuickConnectEnabled ] = useState<boolean | null>(null);
    const [ quickConnectCode, setQuickConnectCode ] = useState('');
    const [ quickConnectError, setQuickConnectError ] = useState('');
    const [ quickConnectBusy, setQuickConnectBusy ] = useState(false);
    const [ localLogin, setLocalLogin ] = useState(queryParameter('local') === 'true');
    const [ quickConnectSelected, setQuickConnectSelected ] = useState(() => queryParameter('local') !== 'true' && isTvClient());
    const mobileNavRef = useRef<HTMLElement>(null);
    const profileMenuRef = useRef<HTMLDivElement>(null);
    const profileReturnView = useRef<'home' | 'library' | 'show' | 'search' | 'details' | 'live' | 'admin'>('home');
    const hamburgerRef = useRef<HTMLButtonElement>(null);
    const recommendationPaginationRef = useRef<HTMLDivElement>(null);
    const seasonNodes = useRef<Record<string, HTMLElement | null>>({});
    const episodeRequests = useRef<Record<string, Promise<MediaItem[]>>>({});
    const showGeneration = useRef(0);
    const showSeasonsRef = useRef(showSeasons);
    showSeasonsRef.current = showSeasons;
    const scrollSeasonSync = useRef<() => void>(() => undefined);
    const episodesBySeasonRef = useRef<Record<string, MediaItem[]>>({});
    const activeSeasonIdRef = useRef('');
    const programmaticScroll = useRef(false);
    const programmaticScrollTimer = useRef<number>();
    const urlUpdateTimer = useRef<number>();
    const showInUrl = useRef(false);
    const openItemRef = useRef<(item: MediaItem) => void>(() => undefined);
    const playRef = useRef<(item: MediaItem) => void>(() => undefined);
    const restoredLive = useRef(false);
    const selectItem = useCallback((item: MediaItem) => { void openItemRef.current(item); }, []);
    const playItem = useCallback((item: MediaItem) => { void playRef.current(item); }, []);
    episodesBySeasonRef.current = episodesBySeason;
    activeSeasonIdRef.current = activeSeasonId;
    const api = useMemo(() => session ? new JellyfinApi(session) : null, [ session ]);
    const tvClient = isTvClient();
    const switchReturnSession = useRef<Session | null>(null);

    useEffect(() => {
        if (session) {
            switchReturnSession.current = null;
            return;
        }
        const frame = window.requestAnimationFrame(() => {
            const card = document.querySelector<HTMLElement>('.login-card');
            if (!card || card.contains(document.activeElement)) return;
            card.querySelector<HTMLElement>('[data-focusable="true"]:not(:disabled)')?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [ session, localLogin, quickConnectSelected, ssoEnabled, quickConnectEnabled ]);

    useEffect(() => {
        setAdminAccessChecked(false);
        setIsAdministrator(false);
        if (!session) {
            setIsAdministrator(false);
            setRememberedUsers([]);
            return;
        }
        rememberUser(session);
        setRememberedUsers(getRememberedUsers(session));
        let active = true;
        void JellyfinApi.getUserSession(session).then(user => {
            if (active) setIsAdministrator(user.Policy?.IsAdministrator === true);
        }).catch(() => {
            if (active) setIsAdministrator(false);
        }).finally(() => { if (active) setAdminAccessChecked(true); });
        return () => { active = false; };
    }, [ session ]);

    useEffect(() => {
        const route = () => { if (window.location.hash.startsWith('#admin/')) setView('admin'); };
        window.addEventListener('hashchange', route);
        return () => window.removeEventListener('hashchange', route);
    }, []);

    const closeProfileMenu = useCallback(() => {
        setProfileMenuOpen(false);
        window.requestAnimationFrame(() => profileMenuRef.current?.querySelector<HTMLElement>('.profile-button')?.focus());
    }, []);

    useEffect(() => {
        if (!profileMenuOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
        };
        // A remote user arrows focus out onto the page behind the open menu.
        // Close it as focus leaves, so it never lingers over content with no
        // way back in. Focus on the toggle itself keeps it open.
        const onFocusIn = (event: FocusEvent) => {
            if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            // TV remotes report Back under several names and codes. Escape
            // alone strands remotes whose Back key never reaches the page,
            // and the open menu has no on-screen close path otherwise.
            const back = event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Back' || event.key === 'BrowserBack' || event.key === 'GoBack' || event.keyCode === 461 || event.keyCode === 10009;
            if (!back) return;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
            if (document.querySelector('.profile-modal-backdrop, .mobile-nav-layer, .player-stage')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            closeProfileMenu();
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('focusin', onFocusIn);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('focusin', onFocusIn);
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [ profileMenuOpen, closeProfileMenu ]);

    useEffect(() => {
        let active = true;
        setSsoEnabled(null);
        setSsoCheckFailed(false);
        setQuickConnectEnabled(null);
        if (!server) return () => { active = false; };
        void JellyfinApi.getSsoConfig(server).then(enabled => {
            if (active) setSsoEnabled(enabled);
        }).catch(() => {
            if (active) {
                setSsoEnabled(false);
                setSsoCheckFailed(true);
            }
        });
        void JellyfinApi.isQuickConnectEnabled(server).then(enabled => {
            if (active) setQuickConnectEnabled(enabled);
        }).catch(() => {
            if (active) setQuickConnectEnabled(false);
        });
        return () => { active = false; };
    }, [ server, tvClient ]);

    useEffect(() => {
        if (session || localLogin || !quickConnectSelected || !quickConnectEnabled) return;
        let cancelled = false;
        let timer: number | undefined;
        setQuickConnectBusy(true);
        setQuickConnectError('');
        void JellyfinApi.initiateQuickConnect(server).then(challenge => {
            if (cancelled) return;
            setQuickConnectCode(challenge.code);
            timer = window.setInterval(() => {
                void JellyfinApi.isQuickConnectAuthenticated(server, challenge.secret).then(authenticated => {
                    if (!authenticated || cancelled) return;
                    if (timer !== undefined) window.clearInterval(timer);
                    void JellyfinApi.loginWithQuickConnect(server, challenge.secret).then(result => {
                        if (!cancelled) setSession(result);
                    }).catch(e => {
                        if (!cancelled) setQuickConnectError(messageOf(e));
                    });
                }).catch(e => {
                    if (!cancelled) setQuickConnectError(messageOf(e));
                });
            }, 5000);
        }).catch(e => {
            if (!cancelled) setQuickConnectError(messageOf(e));
        }).finally(() => {
            if (!cancelled) setQuickConnectBusy(false);
        });
        return () => {
            cancelled = true;
            if (timer !== undefined) window.clearInterval(timer);
        };
    }, [ session, localLogin, quickConnectSelected, quickConnectEnabled, server ]);

    useEffect(() => {
        document.documentElement.classList.toggle('tv-client', isTvClient());
    }, []);

    useEffect(() => {
        if (!isMobileNavOpen) return;
        const firstLink = mobileNavRef.current?.querySelector<HTMLElement>('[data-focusable="true"]');
        firstLink?.focus();
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, [ isMobileNavOpen ]);

    const closeMobileNav = useCallback(() => {
        setIsMobileNavOpen(false);
        window.requestAnimationFrame(() => hamburgerRef.current?.focus());
    }, []);

    useEffect(() => {
        if (!searchExpanded || tvClient) return;
        searchInputRef.current?.focus();
    }, [ searchExpanded, tvClient ]);

    useEffect(() => {
        // Virtualized windows (home feed, library grid, episode feed) unmount
        // the focused node when the window slides. The browser then parks
        // focus on <body> and remote users lose their place with no feedback.
        const onFocusIn = (event: FocusEvent) => {
            const element = event.target as HTMLElement | null;
            if (!element || element === document.body) return;
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            lastFocusRect.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        };
        const onFocusOut = (event: FocusEvent) => {
            const lost = event.target as HTMLElement | null;
            if (!lost || lost === document.body) return;
            // Overlays and menus manage their own focus. Recover only inside
            // virtualized content (and the remounting hero copy) where
            // unmounts happen under focus.
            if (!lost.closest?.('.home-feed-blocks, .library-grid-items, .live-guide-canvas, .recommendation-hero')) return;
            // Removal fires focusout while the node is still connected, then
            // detaches it. Defer the check a frame: deliberate moves land
            // somewhere synchronously, only a removal strands focus on body.
            window.requestAnimationFrame(() => {
                if (lost.isConnected) return;
                if (document.activeElement && document.activeElement !== document.body) return;
                const origin = lastFocusRect.current;
                if (!origin) return;
                const cx = origin.left + origin.width / 2;
                const cy = origin.top + origin.height / 2;
                let best: HTMLElement | null = null;
                let bestScore = Number.POSITIVE_INFINITY;
                for (const entry of collectFocusEntries(document)) {
                    const dx = entry.left + entry.width / 2 - cx;
                    const dy = entry.top + entry.height / 2 - cy;
                    const score = Math.sqrt(dx * dx + dy * dy);
                    if (score < bestScore) {
                        bestScore = score;
                        best = entry.element;
                    }
                }
                if (best) {
                    best.focus();
                    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }
            });
        };
        document.addEventListener('focusin', onFocusIn);
        document.addEventListener('focusout', onFocusOut);
        return () => {
            document.removeEventListener('focusin', onFocusIn);
            document.removeEventListener('focusout', onFocusOut);
        };
    }, []);

    useEffect(() => {
        if (!tvClient) return;
        let frame = 0;
        let settleFrame = 0;
        let observedFocus: HTMLElement | null = null;
        const viewport = window.visualViewport;
        const measure = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const viewportTop = viewport?.offsetTop ?? 0;
            const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
            const left = viewport?.offsetLeft ?? 0;
            const right = left + (viewport?.width ?? window.innerWidth);
            const headerBottoms: number[] = [];
            let targetHeaderTop: number | null = null;
            for (const header of document.querySelectorAll<HTMLElement>('.topbar, .library-sticky, .season-mobile-rail, .season-section-header')) {
                const headerRect = header.getBoundingClientRect();
                if (!headerRect.width || !headerRect.height || headerRect.right <= rect.left || headerRect.left >= rect.right) continue;
                const style = window.getComputedStyle(header);
                const pinnedTop = Number.parseFloat(style.top);
                if ((style.position !== 'sticky' && style.position !== 'fixed') || !Number.isFinite(pinnedTop)) continue;
                if (headerRect.top > viewportTop + pinnedTop + 1 || headerRect.bottom <= viewportTop) continue;
                if (header.contains(element)) targetHeaderTop = headerRect.top;
                else headerBottoms.push(headerRect.bottom);
            }
            const top = Math.max(viewportTop, ...headerBottoms.filter(bottom => targetHeaderTop === null || bottom <= targetHeaderTop + 1));
            let clipped = rect.left < left - 1 || rect.right > right + 1;
            for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                const style = window.getComputedStyle(parent);
                const parentRect = parent.getBoundingClientRect();
                const parentTop = parentRect.top + parent.clientTop;
                const parentLeft = parentRect.left + parent.clientLeft;
                const parentBottom = parentTop + parent.clientHeight;
                const parentRight = parentLeft + parent.clientWidth;
                if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                    clipped ||= rect.width > parent.clientWidth
                        ? rect.right < parentLeft - 1 || rect.left > parentRight + 1
                        : rect.left < parentLeft - 1 || rect.right > parentRight + 1;
                }
                if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                    clipped ||= rect.height > parent.clientHeight
                        ? rect.bottom < parentTop - 1 || rect.top > parentBottom + 1
                        : rect.top < parentTop - 1 || rect.bottom > parentBottom + 1;
                }
            }
            // Pinned toolbar controls cannot move away from their own header or clear headers below it.
            return { rect, top: top + (targetHeaderTop === null ? 16 : 0), bottom: viewportBottom - 16, clipped };
        };
        const keep = () => {
            frame = 0;
            if (lastModality.current !== 'keyboard') return;
            if (document.querySelector('.profile-modal-backdrop, .mobile-nav-layer, .player-stage, .library-sheet-layer, [role="dialog"][aria-modal="true"]')) return;
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || active === document.body) return;
            const element = active.closest<HTMLElement>('[data-focusable="true"]');
            if (!element || element.closest('[role="menu"], [role="dialog"], .mobile-library-drawer, .player-drawer, .player-menu')) return;
            let measured = measure(element);
            if (!measured.rect.width || !measured.rect.height) return;
            if (measured.clipped) {
                for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                    const style = window.getComputedStyle(parent);
                    const rect = element.getBoundingClientRect();
                    const parentRect = parent.getBoundingClientRect();
                    const top = parentRect.top + parent.clientTop;
                    const left = parentRect.left + parent.clientLeft;
                    if (/auto|scroll|hidden/.test(style.overflowY)) {
                        const delta = rect.height > parent.clientHeight || rect.top < top - 1
                            ? rect.top - top
                            : rect.bottom > top + parent.clientHeight + 1 ? rect.bottom - top - parent.clientHeight : 0;
                        if (Math.abs(delta) > 1) parent.scrollTop += delta;
                    }
                    if (/auto|scroll|hidden/.test(style.overflowX)) {
                        const delta = rect.width > parent.clientWidth || rect.left < left - 1
                            ? rect.left - left
                            : rect.right > left + parent.clientWidth + 1 ? rect.right - left - parent.clientWidth : 0;
                        if (Math.abs(delta) > 1) parent.scrollLeft += delta;
                    }
                }
                measured = measure(element);
            }
            const { rect, top, bottom } = measured;
            const delta = rect.height > bottom - top || rect.top < top - 1
                ? rect.top - top
                : rect.bottom > bottom + 1 ? rect.bottom - bottom : 0;
            if (Math.abs(delta) > 1) window.scrollBy(0, delta);
        };
        const schedule = () => {
            if (lastModality.current !== 'keyboard' || settleFrame || frame) return;
            // Allow capture handlers and next-frame navigation to finish first.
            settleFrame = window.requestAnimationFrame(() => {
                settleFrame = 0;
                frame = window.requestAnimationFrame(keep);
            });
        };
        const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
        const onFocusIn = () => {
            if (observedFocus) resize?.unobserve(observedFocus);
            const active = document.activeElement;
            observedFocus = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-focusable="true"]') : null;
            if (observedFocus) resize?.observe(observedFocus);
            schedule();
        };
        const onKey = (event: KeyboardEvent) => {
            lastModality.current = 'keyboard';
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                schedule();
            }
        };
        const onPointer = () => {
            lastModality.current = 'pointer';
            if (settleFrame) window.cancelAnimationFrame(settleFrame);
            if (frame) window.cancelAnimationFrame(frame);
            settleFrame = frame = 0;
        };
        const mutations = new MutationObserver(schedule);
        resize?.observe(document.body);
        mutations.observe(document.body, { childList: true, subtree: true });
        onFocusIn();
        document.addEventListener('focusin', onFocusIn);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('pointerdown', onPointer, true);
        window.addEventListener('mousedown', onPointer, true);
        window.addEventListener('wheel', onPointer, { capture: true, passive: true });
        window.addEventListener('touchstart', onPointer, { capture: true, passive: true });
        window.addEventListener('scroll', schedule, { capture: true, passive: true });
        window.addEventListener('resize', schedule);
        viewport?.addEventListener('resize', schedule);
        viewport?.addEventListener('scroll', schedule);
        return () => {
            document.removeEventListener('focusin', onFocusIn);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('pointerdown', onPointer, true);
            window.removeEventListener('mousedown', onPointer, true);
            window.removeEventListener('wheel', onPointer, true);
            window.removeEventListener('touchstart', onPointer, true);
            window.removeEventListener('scroll', schedule, true);
            window.removeEventListener('resize', schedule);
            viewport?.removeEventListener('resize', schedule);
            viewport?.removeEventListener('scroll', schedule);
            resize?.disconnect();
            mutations.disconnect();
            if (settleFrame) window.cancelAnimationFrame(settleFrame);
            if (frame) window.cancelAnimationFrame(frame);
        };
    }, [ tvClient ]);

    const loadHome = useCallback(async () => {
        if (!api) return;
        setLoading(true);
        setError('');
        setHomeLoading({ views: true, resume: true, latest: true });
        setHomeErrors({ views: '', resume: '', latest: '' });
        setRecommendationsLoading(true);
        const recommendationSources = Promise.all([
            api.getForYouRecommendations('Movie').catch(() => [] as MediaItem[]),
            api.getForYouRecommendations('Series').catch(() => [] as MediaItem[]),
            api.getRecommendations().then(groups => {
                setRecommendationGroups(groups);
                const items: MediaItem[] = [];
                (groups as RecommendationGroup[]).forEach(group => {
                    (group.Items || []).forEach(item => {
                        if (item.Id) items.push({ ...item, RecommendationType: group.RecommendationType, BaselineItemName: group.BaselineItemName });
                    });
                });
                return items;
            }).catch(() => { setRecommendationGroups([]); return [] as MediaItem[]; })
        ]).then(sources => deduplicateItems(sources.reduce((all, source) => all.concat(source), [] as MediaItem[])));
        const latestPromise = api.getLatestItems();
        void api.getRecentCollections().then(setHomeCollections).catch(() => setHomeCollections([]));
        void api.getAiringPrograms(24).then(result => setHomeOnNow(result.Items || [])).catch(() => setHomeOnNow([]));
        void api.getVaultCandidates(48).then(setHomeVaultCandidates).catch(() => setHomeVaultCandidates([]));
        setHomeExploreItems([]);
        setHomeExploreStart(0);
        setHomeExploreTotal(0);
        void api.getHomeFeedPage(0, 24).then(page => {
            setHomeExploreItems(page.Items || []);
            setHomeExploreStart((page.Items || []).length);
            setHomeExploreTotal(page.TotalRecordCount || 0);
        }).catch(() => undefined);
        void recommendationSources.then(recommended => {
            setRecommendations(recommended);
            setActiveRecommendation(0);
            setRecommendationsLoading(false);
            if (!recommended.length) {
                void latestPromise.then(latest => {
                    setRecommendations(shuffleItems(latest).map(item => ({ ...item, RecommendationType: 8 })));
                    setActiveRecommendation(0);
                }).catch(() => setRecommendations([]));
            }
        }).catch(() => setRecommendationsLoading(false));
        const finish = (section: 'views' | 'resume' | 'latest', promise: Promise<MediaItem[]>, save: (items: MediaItem[]) => void) => promise
            .then(save)
            .catch(error => setHomeErrors(current => ({ ...current, [section]: messageOf(error) })))
            .finally(() => setHomeLoading(current => ({ ...current, [section]: false })));
        await Promise.all([
            finish('views', api.getViews(), setViews),
            finish('resume', api.getResumeItems(), setResumeItems),
            finish('latest', latestPromise, setLatestItems)
        ]);
        setLoading(false);
    }, [ api ]);

    const stepRecommendation = useCallback((step: number) => {
        setRecommendationDirection(step >= 0 ? 'next' : 'previous');
        setActiveRecommendation(index => recommendations.length
            ? (index + step + recommendations.length) % recommendations.length
            : 0);
    }, [ recommendations.length ]);

    const selectRecommendation = (index: number) => {
        setRecommendationDirection(index >= activeRecommendation ? 'next' : 'previous');
        setActiveRecommendation(index);
    };

    const homeFeedBlocks = useMemo(() => buildHomeFeedBlocks(resumeItems, latestItems, recommendationGroups, homeCollections, homeOnNow, homeVaultCandidates, homeExploreItems), [ resumeItems, latestItems, recommendationGroups, homeCollections, homeOnNow, homeVaultCandidates, homeExploreItems ]);

    const loadMoreHomeFeed = useCallback(() => {
        if (!api || loadingHomeExplore || homeExploreStart >= homeExploreTotal || view !== 'home') return;
        setLoadingHomeExplore(true);
        void api.getHomeFeedPage(homeExploreStart, 24).then(page => {
            const next = page.Items || [];
            setHomeExploreItems(current => {
                const seen = new Set(current.map(item => item.Id));
                return current.concat(next.filter(item => !seen.has(item.Id)));
            });
            setHomeExploreStart(homeExploreStart + next.length);
            setHomeExploreTotal(page.TotalRecordCount || homeExploreTotal);
        }).catch(() => undefined).finally(() => setLoadingHomeExplore(false));
    }, [ api, loadingHomeExplore, homeExploreStart, homeExploreTotal, view ]);

    useEffect(() => {
        const activeDot = recommendationPaginationRef.current?.querySelector<HTMLElement>('.recommendation-dot.active');
        if (activeDot) {
            try {
                activeDot.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
            } catch (_error) {
                activeDot.scrollIntoView();
            }
        }
    }, [ activeRecommendation ]);

    const openRecommendation = useCallback(() => {
        const item = recommendations[activeRecommendation];
        if (item) void openItem(item);
    }, [ recommendations, activeRecommendation ]);

    const retryHomeSection = useCallback((section: 'views' | 'resume' | 'latest') => {
        if (!api) return;
        setHomeErrors(current => ({ ...current, [section]: '' }));
        setHomeLoading(current => ({ ...current, [section]: true }));
        const request = section === 'views' ? api.getViews() : section === 'resume' ? api.getResumeItems() : api.getLatestItems();
        const save = section === 'views' ? setViews : section === 'resume' ? setResumeItems : setLatestItems;
        void request.then(save)
            .catch(error => setHomeErrors(current => ({ ...current, [section]: messageOf(error) })))
            .finally(() => setHomeLoading(current => ({ ...current, [section]: false })));
    }, [ api ]);

    useEffect(() => {
        if (session) void loadHome();
    }, [ session, loadHome ]);

    useEffect(() => {
        if (session) {
            try {
                localStorage.setItem(SESSION_KEY, JSON.stringify(session));
                localStorage.setItem(SAVED_SERVER_KEY, session.server);
                try { sessionStorage.removeItem(SESSION_KEY); } catch (_error) { /* Migration cleanup is best effort. */ }
                setPersistentSession(true);
            } catch (_error) {
                setPersistentSession(false);
            }
        }
    }, [ session ]);

    useEffect(() => {
        if (session || !ssoHandoffAttempt) return;
        let credentials: string | null = null;
        let apiKey: string | null = null;
        let userId: string | null = null;
        let serverId: string | null = null;
        try {
            credentials = localStorage.getItem('jellyfin_credentials');
            apiKey = localStorage.getItem('api_key');
            userId = localStorage.getItem('userId');
            serverId = localStorage.getItem('serverId');
        } catch (_error) { /* The login screen remains available when storage is disabled. */ }
        const handoff = parseSsoHandoff({
            serverOrigin: window.location.origin,
            credentials,
            apiKey,
            userId,
            serverId,
            attempt: ssoHandoffAttempt,
            now: Date.now()
        });
        const clearHandoff = () => {
            try { sessionStorage.removeItem(SSO_HANDOFF_KEY); } catch (_error) { /* Clearing the marker is best effort. */ }
            setSsoHandoffAttempt(null);
        };
        if (!handoff) {
            clearHandoff();
            setError('SSO sign-in could not be restored. Please sign in again.');
            return;
        }
        const signedOut = () => {
            try { return localStorage.getItem(SIGNED_OUT_KEY) === 'true'; } catch (_error) { return true; }
        };
        if (!canCommitSsoRestore({ requestActive: true, signedOut: signedOut() })) {
            clearHandoff();
            return;
        }
        let active = true;
        const onStorage = (event: StorageEvent) => {
            if (event.key !== SIGNED_OUT_KEY || event.newValue !== 'true') return;
            active = false;
            clearHandoff();
        };
        window.addEventListener('storage', onStorage);
        void JellyfinApi.restoreSsoSession(handoff).then(nextSession => {
            if (!canCommitSsoRestore({ requestActive: active, signedOut: signedOut() })) {
                active = false;
                clearHandoff();
                return;
            }
            try {
                localStorage.removeItem(SIGNED_OUT_KEY);
                sessionStorage.removeItem(SSO_HANDOFF_KEY);
            } catch (_error) { /* The in-memory session can still continue. */ }
            setSession(nextSession);
            setSsoHandoffAttempt(null);
        }).catch(() => {
            if (!active) return;
            clearHandoff();
            setError('SSO sign-in could not be restored. Please sign in again.');
        });
        return () => {
            active = false;
            window.removeEventListener('storage', onStorage);
        };
    }, [ session, ssoHandoffAttempt ]);

    const login = async (event: Event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const nextSession = await JellyfinApi.login(server, username, password);
            try { localStorage.removeItem(SIGNED_OUT_KEY); } catch (_error) { /* Clearing the sign-out marker is best effort. */ }
            setSession(nextSession);
            setPassword('');
            setView('home');
            if (queryParameter('server') !== null) {
                window.history.replaceState(null, '', window.location.pathname + window.location.hash);
            }
        } catch (e) {
            const message = messageOf(e);
            setError(message.indexOf('(401)') >= 0 || message.indexOf('(403)') >= 0 ? 'Sign-in failed. Check your server address and credentials.' : message);
        } finally {
            setBusy(false);
        }
    };

    const useLocalLogin = () => {
        setQuickConnectSelected(false);
        setLocalLogin(true);
        const url = new URL(window.location.href);
        url.searchParams.set('local', 'true');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    };

    const showSignInOptions = () => {
        setLocalLogin(false);
        setQuickConnectSelected(false);
        const url = new URL(window.location.href);
        url.searchParams.delete('local');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    };

    const useQuickConnect = () => {
        setLocalLogin(false);
        setQuickConnectSelected(true);
        const url = new URL(window.location.href);
        url.searchParams.delete('local');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    };

    const openProfileScreen = (screen: ProfileScreenName) => {
        profileReturnView.current = view === 'profile' || view === 'player' ? 'home' : view;
        setProfileScreen(screen);
        setProfileMenuOpen(false);
        setView('profile');
    };

    const clearSignedInState = (showLogin = false) => {
        showGeneration.current++;
        episodeRequests.current = {};
        detailRequest.current++;
        playbackRequest.current++;
        detailOrigin.current = null;
        playbackOrigin.current = null;
        setShowRestore(null);
        setDetailRestore(null);
        setContentRestore(null);
        clearShowQuery();
        clearLiveQuery();
        restoredLive.current = false;
        try { localStorage.removeItem(SESSION_KEY); } catch (_error) { /* Storage can be disabled. */ }
        try { sessionStorage.removeItem(SESSION_KEY); } catch (_error) { /* Clear pre-migration sessions if possible. */ }
        setSession(null);
        try { localStorage.removeItem(SESSION_KEY); } catch (_error) { /* Storage may be disabled. */ }
        setViews([]);
        setResumeItems([]);
        setLatestItems([]);
        setRecommendations([]);
        setRecommendationGroups([]);
        setHomeCollections([]);
        setHomeOnNow([]);
        setHomeVaultCandidates([]);
        setHomeExploreItems([]);
        setHomeExploreStart(0);
        setHomeExploreTotal(0);
        setActiveRecommendation(0);
        setRecommendationsLoading(false);
        setHomeErrors({ views: '', resume: '', latest: '' });
        setHomeLoading({ views: false, resume: false, latest: false });
        setSelected(null);
        setPlayerUrl('');
        setActiveLibrary(null);
        setTvSeries(null);
        setShowSeasons([]);
        setActiveSeasonId('');
        setEpisodesBySeason({});
        setLoadingSeasons({});
        setItems([]);
        setError('');
        setView('home');
        setLocalLogin(showLogin);
        setQuickConnectSelected(!showLogin && tvClient);
        if (showLogin) {
            const url = new URL(window.location.href);
            url.searchParams.set('local', 'true');
            window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        }
    };

    const logout = () => {
        if (api) void api.logout();
        if (session) clearRememberedToken(session);
        setRememberedUsers(session ? getRememberedUsers(session) : []);
        try { localStorage.setItem(SIGNED_OUT_KEY, 'true'); } catch (_error) { /* The current page remains signed out even when storage is blocked. */ }
        clearSignedInState();
    };

    const switchToRememberedUser = (user: RememberedUser) => {
        setProfileMenuOpen(false);
        if (user.session) {
            void JellyfinApi.getUserSession(user.session).then(currentUser => {
                try { localStorage.removeItem(SIGNED_OUT_KEY); } catch (_error) { /* The in-memory session can still be selected. */ }
                setError('');
                clearSignedInState();
                setSession({ ...user.session!, user: { ...user.session!.user, ...currentUser } });
            }).catch(() => {
                clearRememberedToken(user.session!);
                setRememberedUsers(getRememberedUsers(user.session!));
                signInAsAnotherUser(user.name);
            });
            return;
        }
        setUsername(user.name);
        setPassword('');
        signInAsAnotherUser(user.name);
    };

    const signInAsAnotherUser = (usernameHint = '') => {
        switchReturnSession.current = session;
        setProfileMenuOpen(false);
        setUsername(usernameHint);
        setPassword('');
        clearSignedInState(Boolean(usernameHint));
        if (!usernameHint) {
            const url = new URL(window.location.href);
            url.searchParams.delete('local');
            window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        }
    };

    const returnToUserSwitcher = () => {
        const previous = switchReturnSession.current;
        if (!previous) return;
        setPassword('');
        setError('');
        setSession(previous);
        setProfileScreen('accounts');
        setView('profile');
        const url = new URL(window.location.href);
        url.searchParams.delete('local');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    };

    const replaceLocation = (mutate: (params: URLSearchParams) => void) => {
        const url = new URL(window.location.href);
        mutate(url.searchParams);
        const search = url.searchParams.toString();
        window.history.replaceState(null, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
    };

    const clearShowQuery = () => {
        showInUrl.current = false;
        if (urlUpdateTimer.current) {
            window.clearTimeout(urlUpdateTimer.current);
            urlUpdateTimer.current = undefined;
        }
        const url = new URL(window.location.href);
        if (!url.searchParams.has('show') && !url.searchParams.has('season')) return;
        replaceLocation(params => {
            params.delete('show');
            params.delete('season');
        });
    };

    const clearLiveQuery = () => {
        const url = new URL(window.location.href);
        if (!url.searchParams.has('live')) return;
        replaceLocation(params => params.delete('live'));
    };

    const rememberLiveQuery = (tab: LiveTab) => {
        replaceLocation(params => {
            params.delete('show');
            params.delete('season');
            params.set('live', tab);
        });
    };

    const rememberShowQuery = (seriesId: string, seasonValue?: string) => {
        if (!showInUrl.current) return;
        replaceLocation(params => {
            params.set('show', seriesId);
            if (seasonValue) params.set('season', seasonValue);
            else params.delete('season');
        });
    };

    const invalidateShow = () => {
        showGeneration.current++;
        episodeRequests.current = {};
        setShowRestore(null);
    };

    const forgetShow = () => {
        invalidateShow();
        detailRequest.current++;
        playbackRequest.current++;
        detailOrigin.current = null;
        playbackOrigin.current = null;
        setSelected(null);
        clearShowQuery();
        setTvSeries(null);
        setShowSeasons([]);
        setActiveSeasonId('');
        setEpisodesBySeason({});
        setLoadingSeasons({});
        setSeasonSpacerHeights({});
    };

    const goHome = () => {
        searchReturn.current = false;
        forgetShow();
        clearLiveQuery();
        setView('home');
    };

    const openLive = (next: LiveTab = 'now', library?: MediaItem | null) => {
        searchReturn.current = false;
        invalidateShow();
        detailRequest.current++;
        clearShowQuery();
        setTvSeries(null);
        setShowSeasons([]);
        setActiveSeasonId('');
        setEpisodesBySeason({});
        setLoadingSeasons({});
        setSelected(null);
        if (library) setActiveLibrary(library);
        setLiveTab(next);
        setView('live');
        rememberLiveQuery(next);
    };

    const resetAndLoadLibrary = async (library: MediaItem) => {
        if (!api) return;
        searchReturn.current = false;
        if (library.CollectionType?.toLowerCase() === 'livetv') {
            openLive('now', library);
            return;
        }
        clearLiveQuery();
        invalidateShow();
        detailRequest.current++;
        setSelected(null);
        clearShowQuery();
        setActiveLibrary(library);
        setTvSeries(null);
        setShowSeasons([]);
        setActiveSeasonId('');
        setEpisodesBySeason({});
        setItems([]);
        setView('library');
        setLoading(false);
        setError('');
        setItems([]);
    };

    const openLibrary = resetAndLoadLibrary;

    const navigateLibraryUp = async () => {
        invalidateShow();
        detailRequest.current++;
        setSelected(null);
        clearShowQuery();
        setTvSeries(null);
        setShowSeasons([]);
        setEpisodesBySeason({});
        setActiveSeasonId('');
        if (activeLibrary) await openLibrary(activeLibrary);
        else setView('home');
    };

    const openSeries = async (series: MediaItem, requestedSeason?: string) => {
        if (!api) return;
        invalidateShow();
        const generation = showGeneration.current;
        detailRequest.current++;
        setSelected(null);
        showInUrl.current = true;
        restoredShowId.current = series.Id;
        setTvSeries(series);
        setShowSeasons([]);
        setActiveSeasonId('');
        setEpisodesBySeason({});
        setLoadingSeasons({});
        setSeasonSpacerHeights({});
        setItems([]);
        setView('show');
        rememberShowQuery(series.Id, requestedSeason);
        setLoading(true);
        setError('');
        try {
            const response = await api.getSeasons(series.Id);
            if (generation !== showGeneration.current) return;
            const seasons = (response.Items || []).slice().sort((a, b) => (a.IndexNumber ?? -1) - (b.IndexNumber ?? -1));
            showSeasonsRef.current = seasons;
            setShowSeasons(seasons);
            if (!seasons.length) return;
            const seasonRequest = requestedSeason || queryParameter('season');
            const requested = seasons.find(season => seasonRequest === season.Id || seasonRequest === String(season.IndexNumber));
            const firstUnplayed = seasons.find(season => (season.UserData?.UnplayedItemCount || 0) > 0);
            const initialSeason = requested || seasons.find(season => season.IndexNumber === 1) || firstUnplayed || seasons[0];
            setActiveSeasonId(initialSeason.Id);
            activeSeasonIdRef.current = initialSeason.Id;
            await loadSeasonWindow(series.Id, seasons, initialSeason.Id);
            if (generation === showGeneration.current && seasonRequest) window.requestAnimationFrame(() => {
                if (generation === showGeneration.current) scrollToSeason(initialSeason.Id, 'auto');
            });
        } catch (e) {
            if (generation === showGeneration.current) setError(messageOf(e));
        } finally {
            if (generation === showGeneration.current) setLoading(false);
        }
    };

    const loadSeasonEpisodes = useCallback((seriesId: string, seasonId: string): Promise<MediaItem[]> => {
        if (!api) return Promise.resolve([]);
        const cached = episodesBySeasonRef.current[seasonId];
        if (cached) return Promise.resolve(cached);
        const existing = episodeRequests.current[seasonId];
        if (existing) return existing;
        const generation = showGeneration.current;
        setLoadingSeasons(current => ({ ...current, [seasonId]: true }));
        const request = api.getAllSeasonEpisodes(seriesId, seasonId).then(episodes => {
            if (generation === showGeneration.current) setEpisodesBySeason(current => {
                const seasons = showSeasonsRef.current;
                const currentIndex = seasons.findIndex(season => season.Id === activeSeasonIdRef.current);
                const requestedIndex = seasons.findIndex(season => season.Id === seasonId);
                return currentIndex >= 0 && Math.abs(currentIndex - requestedIndex) <= 1
                    ? { ...current, [seasonId]: episodes } : current;
            });
            return episodes;
        }).catch(error => {
            if (generation === showGeneration.current) setError(messageOf(error));
            throw error;
        }).finally(() => {
            if (episodeRequests.current[seasonId] === request) {
                delete episodeRequests.current[seasonId];
                setLoadingSeasons(current => ({ ...current, [seasonId]: false }));
            }
        });
        episodeRequests.current[seasonId] = request;
        return request;
    }, [ api ]);

    const loadSeasonWindow = useCallback(async (seriesId: string, seasons: MediaItem[], seasonId: string) => {
        const index = seasons.findIndex(season => season.Id === seasonId);
        const nearby = seasons.slice(Math.max(0, index - 1), index + 2);
        await Promise.all(nearby.map(season => loadSeasonEpisodes(seriesId, season.Id).catch(() => [])));
    }, [ loadSeasonEpisodes ]);

    const trimShowSeason = (seasonId: string, seasons: MediaItem[]) => {
        const index = seasons.findIndex(season => season.Id === seasonId);
        if (index < 0) return;
        const keep = new Set(seasons.slice(Math.max(0, index - 1), index + 2).map(season => season.Id));
        const outgoingHeights: Record<string, number> = {};
        seasons.forEach(season => {
            const section = seasonNodes.current[season.Id];
            if (!keep.has(season.Id) && section && episodesBySeasonRef.current[season.Id]) {
                const height = Math.ceil(section.getBoundingClientRect().height);
                if (height > 0) outgoingHeights[season.Id] = height;
            }
        });
        if (Object.keys(outgoingHeights).length) setSeasonSpacerHeights(current => mergeMeasuredHeights(current, outgoingHeights));
        setEpisodesBySeason(current => {
            if (Object.keys(current).every(id => keep.has(id))) return current;
            const next = { ...current };
            Object.keys(next).forEach(id => { if (!keep.has(id)) delete next[id]; });
            return next;
        });
    };

    const activateShowSeason = (seasonId: string) => {
        if (!tvSeries || !showSeasons.some(season => season.Id === seasonId) || activeSeasonIdRef.current === seasonId) return;
        activeSeasonIdRef.current = seasonId;
        setActiveSeasonId(seasonId);
        trimShowSeason(seasonId, showSeasons);
        if (urlUpdateTimer.current) window.clearTimeout(urlUpdateTimer.current);
        const season = showSeasons.find(item => item.Id === seasonId);
        rememberShowQuery(tvSeries.Id, season?.IndexNumber !== undefined ? String(season.IndexNumber) : seasonId);
    };

    const scrollToSeason = useCallback((seasonId: string, behavior: ScrollBehavior = 'smooth') => {
        const section = seasonNodes.current[seasonId];
        if (!section) return;
        programmaticScroll.current = true;
        if (programmaticScrollTimer.current) window.clearTimeout(programmaticScrollTimer.current);
        activeSeasonIdRef.current = seasonId;
        setActiveSeasonId(seasonId);
        const season = showSeasons.find(item => item.Id === seasonId);
        if (season && tvSeries) rememberShowQuery(tvSeries.Id, season.IndexNumber !== undefined ? String(season.IndexNumber) : season.Id);
        try {
            section.scrollIntoView({ behavior, block: 'start' });
        } catch (_error) {
            section.scrollIntoView();
        }
        programmaticScrollTimer.current = window.setTimeout(() => {
            programmaticScroll.current = false;
            scrollSeasonSync.current();
        }, behavior === 'smooth' ? 1000 : 100);
    }, [ showSeasons, tvSeries ]);

    const scrollToSeasonAndLoad = async (seasonId: string, signal?: AbortSignal) => {
        if (!tvSeries) return;
        const loading = loadSeasonWindow(tvSeries.Id, showSeasons, seasonId);
        if (signal?.aborted) return;
        scrollToSeason(seasonId, tvClient ? 'auto' : 'smooth');
        await loading;
    };

    const loadedSeasonKey = showSeasons.map(season => episodesBySeason[season.Id] ? season.Id : '').join('|');

    useEffect(() => {
        if (!tvSeries || !showSeasons.length || loading || view !== 'show') return;
        const seasons = showSeasons;
        const series = tvSeries;
        let frame = 0;
        const syncSeason = () => {
            frame = 0;
            const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const focused = active?.closest<HTMLElement>('.episode-card[data-season-id]');
            const focusRect = focused?.getBoundingClientRect();
            const focusSeason = lastModality.current === 'keyboard' && focusRect && focusRect.bottom > 120 && focusRect.top < window.innerHeight
                ? focused?.dataset.seasonId : undefined;
            const anchor = 120 + (window.innerHeight - 120) * .18;
            const visible = seasons.map(season => ({ id: season.Id, rect: seasonNodes.current[season.Id]?.getBoundingClientRect() }))
                .filter(entry => entry.rect && entry.rect.height > 0);
            const sampled = visible.find(entry => entry.rect!.top <= anchor && entry.rect!.bottom > anchor)
                || visible.reduce<typeof visible[number] | undefined>((best, entry) =>
                    !best || Math.abs(entry.rect!.top - anchor) < Math.abs(best.rect!.top - anchor) ? entry : best, undefined);
            const seasonId = programmaticScroll.current ? activeSeasonIdRef.current : focusSeason || sampled?.id;
            if (!seasonId) return;
            const changed = seasonId !== activeSeasonIdRef.current;
            const currentIndex = seasons.findIndex(season => season.Id === seasonId);
            if (currentIndex < 0) return;
            if (changed) {
                if (currentIndex > 0) void loadSeasonEpisodes(series.Id, seasons[currentIndex - 1].Id).catch(() => undefined);
                void loadSeasonEpisodes(series.Id, seasonId).catch(() => undefined);
                if (currentIndex < seasons.length - 1) void loadSeasonEpisodes(series.Id, seasons[currentIndex + 1].Id).catch(() => undefined);
                activeSeasonIdRef.current = seasonId;
                setActiveSeasonId(seasonId);
            }
            trimShowSeason(seasonId, seasons);
            if (!changed) return;
            if (urlUpdateTimer.current) window.clearTimeout(urlUpdateTimer.current);
            urlUpdateTimer.current = window.setTimeout(() => {
                urlUpdateTimer.current = undefined;
                const season = seasons.find(item => item.Id === seasonId);
                if (!season || !showInUrl.current || activeSeasonIdRef.current !== seasonId) return;
                rememberShowQuery(series.Id, season.IndexNumber !== undefined ? String(season.IndexNumber) : season.Id);
            }, 200);
        };
        const schedule = () => { if (!frame) frame = window.requestAnimationFrame(syncSeason); };
        scrollSeasonSync.current = schedule;
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        schedule();
        return () => {
            window.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            if (frame) window.cancelAnimationFrame(frame);
            if (scrollSeasonSync.current === schedule) scrollSeasonSync.current = () => undefined;
            if (urlUpdateTimer.current) {
                window.clearTimeout(urlUpdateTimer.current);
                urlUpdateTimer.current = undefined;
            }
        };
    }, [ tvSeries, showSeasons, loadSeasonEpisodes, loadedSeasonKey, loading, view ]);

    useEffect(() => {
        if (!tvSeries || !showSeasons.length) return;
        let frame = 0;
        const recordRenderedHeights = () => {
            const heights: Record<string, number> = {};
            const loaded = episodesBySeasonRef.current;
            showSeasons.forEach(season => {
                const element = seasonNodes.current[season.Id];
                if (!element || !loaded[season.Id]) return;
                const height = Math.ceil(element.getBoundingClientRect().height);
                if (height > 0) heights[season.Id] = height;
            });
            if (Object.keys(heights).length) setSeasonSpacerHeights(current => mergeMeasuredHeights(current, heights));
        };
        const schedule = () => {
            if (frame) return;
            frame = window.requestAnimationFrame(() => {
                frame = 0;
                recordRenderedHeights();
            });
        };
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(schedule);
            showSeasons.forEach(season => {
                const element = seasonNodes.current[season.Id];
                if (element && episodesBySeasonRef.current[season.Id]) observer.observe(element);
            });
            return () => {
                if (frame) window.cancelAnimationFrame(frame);
                observer.disconnect();
            };
        }
        window.addEventListener('resize', schedule);
        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            window.removeEventListener('resize', schedule);
        };
    }, [ tvSeries, showSeasons, loadedSeasonKey ]);

    useEffect(() => {
        if (!activeSeasonId) return;
        const nodes = document.querySelectorAll<HTMLElement>('[data-season-nav]');
        let activeNavItem: HTMLElement | null = null;
        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index];
            if (node.getAttribute('data-season-nav') === activeSeasonId && node.getClientRects().length) {
                activeNavItem = node;
                break;
            }
        }
        if (!activeNavItem) return;
        const parent = activeNavItem.parentElement;
        if (parent) {
            const itemRect = activeNavItem.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            const inView = itemRect.top >= parentRect.top - 1 && itemRect.bottom <= parentRect.bottom + 1 && itemRect.left >= parentRect.left - 1 && itemRect.right <= parentRect.right + 1;
            if (inView) return;
        }
        try {
            activeNavItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (_error) {
            activeNavItem.scrollIntoView();
        }
    }, [ activeSeasonId ]);

    const restoredShowId = useRef('');
    useEffect(() => {
        if (!api || tvSeries || queryParameter('live')) return;
        const showId = queryParameter('show');
        if (!showId || restoredShowId.current === showId) return;
        restoredShowId.current = showId;
        let cancelled = false;
        void api.getItem(showId).then(series => {
            if (!cancelled && series.Type === 'Series') void openSeries(series, queryParameter('season') || undefined);
        }).catch(e => {
            if (!cancelled) setError(messageOf(e));
        });
        return () => { cancelled = true; };
    }, [ api, tvSeries?.Id ]);

    useEffect(() => {
        if (!api || restoredLive.current) return;
        const live = queryParameter('live');
        if (live !== 'now' && live !== 'guide' && live !== 'channels' && live !== 'dvr') return;
        restoredLive.current = true;
        openLive(live);
    }, [ api ]);

    const contentOrigin = (): ContentOrigin => {
        if (view === 'search') return { kind: 'search', scrollY: window.scrollY };
        if (view === 'library') return { kind: 'library', scrollY: window.scrollY };
        if (view === 'live') return { kind: 'live', scrollY: window.scrollY };
        return { kind: 'home', scrollY: window.scrollY };
    };

    const returnToContent = (origin: ContentOrigin) => {
        detailRequest.current++;
        setSelected(null);
        if (origin.kind === 'show') {
            setShowRestore({ ...origin.bookmark });
            setView('show');
            return;
        }
        if (origin.kind === 'search') searchReturn.current = false;
        setContentRestore(origin);
        setView(origin.kind);
    };

    const returnFromDetails = () => {
        const origin = detailOrigin.current || contentOrigin();
        returnToContent(origin);
        detailOrigin.current = null;
    };

    useLayoutEffect(() => {
        if (!detailRestore || view !== 'details' || selected?.Id !== detailRestore.itemId) return;
        const frame = window.requestAnimationFrame(() => {
            window.scrollTo(0, detailRestore.scrollY);
            document.querySelector<HTMLElement>('.detail-actions .button.primary')?.focus({ preventScroll: true });
            setDetailRestore(null);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [ detailRestore, view, selected?.Id ]);

    useLayoutEffect(() => {
        if (!contentRestore || contentRestore.kind !== view) return;
        const frame = window.requestAnimationFrame(() => {
            window.scrollTo(0, contentRestore.scrollY);
            setContentRestore(null);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [ contentRestore, view ]);

    const openItem = async (item: MediaItem, origin?: ContentOrigin) => {
        if (!api) return;
        if (item.Type === 'Series') {
            await openSeries(item);
            return;
        }
        if (item.Type === 'Season') {
            if (item.SeriesId) {
                const series = await api.getItem(item.SeriesId);
                if (series.Type === 'Series') void openSeries(series, item.IndexNumber !== undefined ? String(item.IndexNumber) : item.Id);
            }
            return;
        }
        if ([ 'Folder', 'CollectionFolder', 'BoxSet' ].indexOf(item.Type || '') >= 0) {
            await openLibrary(item);
            return;
        }
        const parent = origin || contentOrigin();
        if (tvSeries && item.Type === 'Episode' && parent.kind === 'show') {
            const targetId = parent.bookmark.target;
            const seasonId = targetId.kind === 'episode' ? targetId.seasonId : activeSeasonId;
            const currentSeason = showSeasons.find(season => season.Id === seasonId);
            rememberShowQuery(tvSeries.Id, currentSeason ? (currentSeason.IndexNumber !== undefined ? String(currentSeason.IndexNumber) : currentSeason.Id) : undefined);
        }
        const request = ++detailRequest.current;
        detailOrigin.current = parent;
        setSelected(item);
        setView('details');
        try {
            const full = await api.getItem(item.Id);
            if (request === detailRequest.current && renderedView.current === 'details') setSelected(full);
        } catch (_error) { /* The list item remains usable if details are unavailable. */ }
    };

    const runSearch = async (query?: string) => {
        const term = (query ?? search).trim();
        if (!api || !term) return;
        setSearch(term);
        setSearchDraft(term);
        setSearchExpanded(false);
        forgetShow();
        clearLiveQuery();
        setView('search');
        setLoading(true);
        setError('');
        try {
            const response = await api.getItems('', 0, term);
            setItems(response.Items || []);
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // TV search page queries live as the draft changes. Stale responses
        // lose by request id; the timer debounces remote key repeats.
        if (!tvClient || !api) return;
        const term = searchDraft.trim();
        if (term.length < 2) {
            searchReq.current++;
            setItems(current => current.length ? [] : current);
            setLoading(false);
            return;
        }
        const id = ++searchReq.current;
        setLoading(true);
        const timer = window.setTimeout(() => {
            void api.getItems('', 0, term).then(response => {
                if (id !== searchReq.current) return;
                setItems(response.Items || []);
                setSearch(term);
                setLoading(false);
            }).catch(e => {
                if (id !== searchReq.current) return;
                setError(messageOf(e));
                setLoading(false);
            });
        }, 300);
        return () => window.clearTimeout(timer);
    }, [ searchDraft, api, tvClient ]);

    const play = async (item: MediaItem, origin?: PlaybackOrigin) => {
        if (!api) return;
        const returnOrigin: PlaybackOrigin = origin || (view === 'details' && selected
            ? { kind: 'details', item: selected, parent: detailOrigin.current || contentOrigin(), scrollY: window.scrollY }
            : contentOrigin());
        const request = ++playbackRequest.current;
        detailRequest.current++;
        setLoading(true);
        setError('');
        try {
            let playbackItem = item;
            if ((item.Type === 'Episode' || item.SeriesId) && !item.SeriesName) {
                try { playbackItem = { ...item, ...(await api.getItem(item.Id)) }; } catch (_error) { playbackItem = item; }
            }
            if (request !== playbackRequest.current) return;
            const result = await api.play(playbackItem);
            if (request !== playbackRequest.current) return;
            setPlayerItem(playbackItem);
            setPlayback(result);
            setPlayerUrl(result.url);
            playbackOrigin.current = returnOrigin;
            setView('player');
        } catch (e) {
            if (request === playbackRequest.current) setError(messageOf(e));
        } finally {
            if (request === playbackRequest.current) setLoading(false);
        }
    };
    openItemRef.current = openItem;
    playRef.current = play;

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!session) {
                const back = event.key === 'Escape' || event.key === 'Back' || event.key === 'BrowserBack' || event.key === 'GoBack' || event.keyCode === 461 || event.keyCode === 10009;
                if (back) {
                    event.preventDefault();
                    if (localLogin || quickConnectSelected) showSignInOptions();
                    else returnToUserSwitcher();
                    return;
                }
                const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
                const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
                const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
                if (!vertical && (!horizontal || editing)) return;
                const card = document.querySelector<HTMLElement>('.login-card');
                if (!card) return;
                const controls = Array.from(card.querySelectorAll<HTMLElement>('[data-focusable="true"]:not(:disabled)'));
                const index = controls.indexOf(document.activeElement as HTMLElement);
                const next = index < 0 ? 0 : index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1);
                controls[next]?.focus();
                controls[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                event.preventDefault();
                return;
            }
            if ((event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) && (event.key === 'Backspace' || event.key === 'Delete')) return;
            if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Back' || event.key === 'BrowserBack' || event.key === 'GoBack' || event.keyCode === 461 || event.keyCode === 10009) {
                if (isMobileNavOpen) {
                    event.preventDefault();
                    closeMobileNav();
                    return;
                }
                if (view === 'profile') {
                    event.preventDefault();
                    setView(profileReturnView.current);
                    return;
                }
                if (view === 'player') return;
                if (view === 'details') {
                    event.preventDefault();
                    returnFromDetails();
                    return;
                }
                if (searchReturn.current) {
                    event.preventDefault();
                    searchReturn.current = false;
                    clearShowQuery();
                    setView('search');
                } else if (view === 'show') {
                    if (searchReturn.current) {
                        searchReturn.current = false;
                        clearShowQuery();
                        setView('search');
                    } else void navigateLibraryUp();
                } else if (view === 'live') {
                    goHome();
                } else if (view === 'library' || view === 'search') {
                    if (view === 'library' && tvSeries) void navigateLibraryUp();
                    else goHome();
                }
                return;
            }
            if (view === 'player') {
                const stage = document.querySelector<HTMLElement>('.player-stage');
                const osdOpen = stage?.getAttribute('data-osd-open') === 'true';
                const arrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown';
                if (isTvClient() && osdOpen && arrow && stage) {
                    const directions: Record<string, [number, number]> = {
                        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
                    };
                    const direction = directions[event.key];
                    const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    const entries = collectFocusEntries(stage);
                    if (!current || !entries.some(entry => entry.element === current)) {
                        entries[0]?.element.focus();
                        event.preventDefault();
                        return;
                    }
                    const result = focusTarget(entries, current, direction);
                    if (result.element) {
                        result.element.focus();
                        event.preventDefault();
                    }
                }
                return;
            }
            if ((!isTvClient() && !(view === 'profile' && profileScreen === 'accounts')) || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            if (view === 'show' && event.key === 'ArrowDown' && event.target instanceof HTMLElement && event.target.closest('.topbar')) {
                document.querySelector<HTMLElement>('.show-detail-view [data-show-control="back"]')?.focus();
                event.preventDefault();
                return;
            }
            if (view === 'home' && recommendations.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                const target = event.target as HTMLElement;
                if (target.closest('.recommendation-hero')) {
                    // The copy (title, button) remounts per item, so stepping
                    // from inside it destroys the focused button. Land on its
                    // replacement to keep focus in the reel.
                    const inEphemeral = target.closest('.recommendation-copy');
                    stepRecommendation(event.key === 'ArrowLeft' ? -1 : 1);
                    event.preventDefault();
                    if (inEphemeral) {
                        window.requestAnimationFrame(() => {
                            document.querySelector<HTMLElement>('.recommendation-copy .button')?.focus();
                        });
                    }
                    return;
                }
            }
            if (view === 'home' && event.key === 'ArrowUp' && event.target instanceof HTMLElement) {
                // The bottom chrome sits low and right, so raw geometry jumps
                // from here to the profile button and strands the hero half
                // visible with nowhere useful to go. Keep upward travel
                // inside the hero by stepping to its primary action first.
                const controls = event.target.closest<HTMLElement>('.recommendation-controls');
                const primary = controls?.closest<HTMLElement>('.recommendation-hero')?.querySelector<HTMLElement>('.recommendation-copy .button');
                if (controls && primary) {
                    primary.focus();
                    primary.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    event.preventDefault();
                    return;
                }
            }
            const directions: Record<string, [number, number]> = {
                ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
            };
            const direction = directions[event.key];
            if (!direction) return;
            const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (isMobileNavOpen && tvClient && mobileNavRef.current) {
                const entries = collectFocusEntries(mobileNavRef.current);
                const target = current ? focusTarget(entries, current, direction).element : null;
                if (target) target.focus();
                else if (!current || !mobileNavRef.current.contains(current)) entries[0]?.element.focus();
                event.preventDefault();
                return;
            }
            if (view === 'profile' && profileScreen === 'accounts') {
                const picker = document.querySelector<HTMLElement>('.account-picker');
                if (picker) {
                    const entries = collectFocusEntries(picker);
                    const result = current ? focusTarget(entries, current, direction) : null;
                    if (result?.element) {
                        result.element.focus();
                        result.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    } else if (!result?.known) {
                        picker.querySelector<HTMLElement>('.remembered-user')?.focus();
                    }
                    event.preventDefault();
                    return;
                }
            }
            if (!current) {
                focusEntries()[0]?.element.focus();
                event.preventDefault();
                return;
            }
            const scopes = [ '.episode-list', '.virtualized-poster-grid', '.library-toolbar', '.alpha-scrubber', '.library-grid-items', '.media-row', '.season-sidebar', '.season-mobile-rail', '.primary-nav', '.mobile-library-drawer', '.recommendation-controls', '.episode-feed', '.live-tabs', '.topbar', '.tv-search-keyboard', '.tv-search-panel', '.tv-search-results' ];
            for (let index = 0; index < scopes.length; index++) {
                const scope = current.closest<HTMLElement>(scopes[index]);
                if (!scope) continue;
                const scoped = focusTarget(collectFocusEntries(scope), current, direction);
                if (scoped.known && scoped.element) {
                    scoped.element.focus();
                    event.preventDefault();
                    return;
                }
            }
            const entries = focusEntries();
            const result = focusTarget(entries, current, direction);
            if (!result.known) {
                entries[0]?.element.focus();
                event.preventDefault();
                return;
            }
            if (result.element) {
                result.element.focus();
                event.preventDefault();
            } else if (current) {
                // True content edge: nothing lies in this direction. Layout
                // shifts can leave the focused control off-screen with no
                // further moves coming, so keep the focus ring visible.
                // 'nearest' is a no-op when already visible.
                current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                event.preventDefault();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [ session, localLogin, quickConnectSelected, view, profileScreen, selected, activeLibrary, isMobileNavOpen, closeMobileNav, recommendations.length, stepRecommendation, tvSeries, showSeasons ]);

    if (!session) {
        if (ssoHandoffAttempt) {
            return <main class="login-page"><section class="login-card"><div class="brand-mark">J</div><p class="eyebrow">SECURE SIGN-IN</p><h1>Completing SSO sign-in…</h1><p class="muted">Checking your Jellyfin session.</p></section></main>;
        }
        if (!localLogin && (ssoEnabled === null || quickConnectEnabled === null)) {
            return <main class="login-page"><section class="login-card"><div class="brand-mark">J</div><p class="eyebrow">SECURE SIGN-IN</p><h1>Checking sign-in…</h1><p class="muted">Connecting to your Jellyfin server.</p></section></main>;
        }
        if (!localLogin && quickConnectSelected && quickConnectEnabled) {
            return <main class="login-page">
                <section class="login-card login-layout" aria-labelledby="login-title">
                    <div class="login-intro">
                        <div class="login-brand"><span class="brand-mark">J</span><span>Jellyfin</span></div>
                        <p class="eyebrow">QUICK CONNECT</p><h1 id="login-title">Your next watch<br />starts here.</h1>
                        <p class="login-description">Sign in with your phone or computer. No typing on your TV.</p>
                        <ol class="login-steps"><li>Open Jellyfin on a signed-in device.</li><li>Open your profile menu and choose Quick Connect.</li><li>Enter the code shown here to approve this device.</li></ol>
                    </div>
                    <div class="login-panel">
                        <h2>Connect this device</h2><p class="muted">Enter this code on your signed-in device.</p>
                        {quickConnectCode ? <div class="quick-connect-code" aria-live="polite">{quickConnectCode}</div> : <p class="quick-connect-wait">{quickConnectBusy ? 'Requesting a code…' : 'Waiting for Quick Connect…'}</p>}
                        {quickConnectError && <p class="notice error" role="alert">{quickConnectError}</p>}
                        <p class="security-note">This code expires automatically. Approve it only on a device you trust.</p>
                        {!tvClient && <button data-focusable="true" class="local-login-toggle" type="button" onClick={showSignInOptions}>Back to sign-in options</button>}
                        {tvClient && <button data-focusable="true" class="button secondary full login-choice" type="button" onClick={useLocalLogin}>Username and password<span class="login-choice-detail">Sign in with your Jellyfin account</span></button>}
                        {switchReturnSession.current && <button data-focusable="true" class="local-login-toggle" type="button" onClick={returnToUserSwitcher}>Choose a profile</button>}
                    </div>
                </section>
            </main>;
        }
        return <main class="login-page">
            <section class="login-card login-layout" aria-labelledby="login-title">
                <div class="login-intro">
                    <div class="login-brand"><span class="brand-mark">J</span><span>Jellyfin</span></div>
                    <p class="eyebrow">YOUR MEDIA, YOUR WAY</p>
                    <h1 id="login-title">Make yourself<br />at home.</h1>
                    <p class="login-description">Your movies, shows, and live TV.<br />Sign in and pick up where you left off.</p>
                    <p class="login-remote-hint">Use ↑ ↓ to move · Select to continue</p>
                </div>
                <div class="login-panel">
                    <h2>{localLogin ? 'Sign in with your account' : 'Choose how to sign in'}</h2>
                    <p class="muted">{localLogin ? 'Enter your Jellyfin username and password.' : 'Quick Connect lets you sign in from another device.'}</p>
                    {ssoCheckFailed && <p class="notice error" role="status">Sign-in options could not be checked. Try reloading or sign in with your username and password.</p>}
                    {error && <p class="notice error" role="alert">{error}</p>}
                    {!localLogin && !quickConnectSelected && <>
                        {!tvClient && ssoEnabled && <button data-focusable="true" class="button secondary full" type="button" onClick={() => { void JellyfinApi.beginSso(server).catch(() => setError('SSO sign-in could not be started. Please try again.')); }}>Continue with SSO</button>}
                        <button data-focusable="true" class="button primary full login-choice" type="button" disabled={!quickConnectEnabled} onClick={useQuickConnect}>Quick Connect<span class="login-choice-detail">Use your phone or computer</span></button>
                        {!quickConnectEnabled && <p class="security-note">Quick Connect is not enabled on this Jellyfin server.</p>}
                        <button data-focusable="true" class="button secondary full login-choice" type="button" onClick={useLocalLogin}>Username and password<span class="login-choice-detail">Sign in with your Jellyfin account</span></button>
                    </>}
                    {quickConnectSelected && !quickConnectEnabled && <>
                        <p class="notice error" role="status">Quick Connect is not enabled on this Jellyfin server.</p>
                        <button data-focusable="true" class="button secondary full" type="button" onClick={tvClient ? useLocalLogin : showSignInOptions}>{tvClient ? 'Use username and password' : 'Back to sign-in options'}</button>
                    </>}
                    {localLogin && <form onSubmit={login}>
                        {!configuredServer && <label>Server address<input data-focusable="true" type="url" value={server} onInput={e => setServer((e.target as HTMLInputElement).value)} placeholder="https://jellyfin.example.com" required autocomplete="url" /></label>}
                        <label>Username<input data-focusable="true" value={username} onInput={e => setUsername((e.target as HTMLInputElement).value)} required autocomplete="username" /></label>
                        <label>Password<input data-focusable="true" type="password" value={password} onInput={e => setPassword((e.target as HTMLInputElement).value)} required autocomplete="current-password" /></label>
                        <button data-focusable="true" class="button primary full" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Sign in'}</button>
                    </form>}
                    {localLogin && <button data-focusable="true" class="local-login-toggle" type="button" onClick={showSignInOptions}>Back to sign-in options</button>}
                    {switchReturnSession.current && <button data-focusable="true" class="local-login-toggle" type="button" onClick={returnToUserSwitcher}>Choose a profile</button>}
                </div>
            </section>
        </main>;
    }

    const applyReportedPlayback = async (itemId: string) => {
        if (!api) return;
        try {
            const fresh = await api.getItem(itemId);
            const merge = (entry: MediaItem) => entry.Id === itemId ? { ...entry, UserData: fresh.UserData } : entry;
            setSelected(current => current ? merge(current) : current);
            setPlayerItem(current => current ? merge(current) : current);
            setItems(current => current.map(merge));
            setEpisodesBySeason(current => {
                const next: Record<string, MediaItem[]> = {};
                Object.keys(current).forEach(seasonId => { next[seasonId] = current[seasonId].map(merge); });
                return next;
            });
            setResumeItems(await api.getResumeItems());
        } catch (_error) { /* The session report is already saved; the next library load refreshes local progress. */ }
    };

    const leavePlayer = () => {
        playbackRequest.current++;
        const origin = playbackOrigin.current;
        playbackOrigin.current = null;
        setPlayerUrl('');
        setPlayerItem(null);
        setPlayback(null);
        if (origin?.kind === 'details') {
            detailOrigin.current = origin.parent;
            setSelected(origin.item);
            setDetailRestore({ itemId: origin.item.Id, scrollY: origin.scrollY });
            setView('details');
            return;
        }
        returnToContent(origin || { kind: 'home', scrollY: 0 });
    };

    if (view === 'admin') {
        const backToMedia = () => { window.history.replaceState(null, '', window.location.pathname + window.location.search); setView('home'); };
        if (!adminAccessChecked || !isAdministrator || !api) return <main class="admin-workspace"><section class="ad-page" role="status"><h1>{adminAccessChecked ? 'Administrator access required' : 'Checking administrator access…'}</h1><button class="ad-btn" onClick={backToMedia}>Back to media</button></section></main>;
        return <Suspense fallback={<main class="admin-workspace"><p class="ad-page" role="status">Loading admin workspace…</p></main>}><AdminDashboard key={session.user.Id} api={api} session={session} onBack={backToMedia} /></Suspense>;
    }

    return <>
    <div class="app-shell" aria-hidden={view === 'player'}>
        {!(view === 'profile' && profileScreen === 'accounts') && <header class="topbar">
            <a class="brand" href="#home" onClick={e => { e.preventDefault(); goHome(); }} aria-label="Jellyfin home"><span class="brand-mark small">J</span><span>Jellyfin</span></a>
            <button
                ref={hamburgerRef}
                class="hamburger-button"
                data-focusable="true"
                type="button"
                aria-label={isMobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
                aria-expanded={isMobileNavOpen}
                aria-controls="mobile-library-drawer"
                onClick={() => setIsMobileNavOpen(open => !open)}
            >
                <span class={isMobileNavOpen ? 'hamburger-icon open' : 'hamburger-icon'} aria-hidden="true"><i /><i /><i /></span>
            </button>
            <nav class="primary-nav" aria-label="Main navigation">
                <button data-focusable="true" class={view === 'home' ? 'nav-link active' : 'nav-link'} onClick={goHome}>Home</button>
                {views.map(library => {
                    const isActive = activeLibrary?.Id === library.Id && (view === 'library' || view === 'show' || view === 'details' || view === 'live');
                    return <button data-focusable="true" class={isActive ? 'nav-link active' : 'nav-link'} key={library.Id} aria-current={isActive ? 'page' : undefined} onClick={() => void openLibrary(library)}>{library.Name}</button>;
                })}
            </nav>
            <div class={searchExpanded && !tvClient ? 'search-box expanded' : 'search-box collapsed'} role="search">
                <button
                    class="search-toggle"
                    data-focusable="true"
                    type="button"
                    aria-label="Search your library"
                    aria-expanded={tvClient ? view === 'search' : searchExpanded}
                    onClick={() => {
                        if (tvClient) {
                            setSearchDraft(search);
                            forgetShow();
                            clearLiveQuery();
                            setView('search');
                        } else setSearchExpanded(open => !open);
                    }}
                ><span aria-hidden="true">⌕</span></button>
                {!tvClient && searchExpanded && <form class="search-expand-form" onSubmit={e => { e.preventDefault(); void runSearch(); }}>
                    <input ref={searchInputRef} data-focusable="true" value={search} onInput={e => setSearch((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Escape') setSearchExpanded(false); }} placeholder="Search your library" aria-label="Search your library" />
                    <button data-focusable="true" class="search-submit" type="submit" aria-label="Submit search">→</button>
                </form>}
            </div>
            <div class="profile-menu-container" ref={profileMenuRef}>
                <button class="profile-button" data-focusable="true" type="button" onClick={() => setProfileMenuOpen(open => !open)} aria-label={`Open ${session.user.Name} menu`} aria-haspopup="menu" aria-expanded={profileMenuOpen}><span>{session.user.Name.slice(0, 1).toUpperCase()}</span></button>
                {profileMenuOpen && <div class="profile-menu" role="menu" aria-label={`${session.user.Name} menu`}>
                    <div class="profile-menu-heading"><strong>{session.user.Name}</strong></div>
                    {!tvClient && <>
                        {quickConnectEnabled && <button data-focusable="true" role="menuitem" type="button" onClick={() => { setProfileMenuOpen(false); setProfileScreen('quickconnect'); }}>Quick Connect</button>}
                        <button data-focusable="true" role="menuitem" type="button" onClick={() => openProfileScreen('playback')}>Playback</button>
                        <button data-focusable="true" role="menuitem" type="button" onClick={() => openProfileScreen('subtitles')}>Subtitles</button>
                        <button data-focusable="true" role="menuitem" type="button" onClick={() => openProfileScreen('taste')}>Taste</button>
                        {isAdministrator && <>
                            <div class="profile-menu-divider" />
                            <p class="profile-menu-label">Server administration</p>
                            <button data-focusable="true" role="menuitem" type="button" onClick={() => { setProfileMenuOpen(false); window.location.hash = 'admin/overview'; setView('admin'); profileReturnView.current = 'home'; }}>Admin workspace</button>
                            {classicWebLinksAvailable && <>
                                <button data-focusable="true" role="menuitem" type="button" onClick={() => { setProfileMenuOpen(false); window.location.assign(`${session.server}/web/index.html#!/dashboard`); }}>Classic dashboard</button>
                                <button data-focusable="true" role="menuitem" type="button" onClick={() => { setProfileMenuOpen(false); window.location.assign(`${session.server}/web/index.html#!/metadata`); }}>Metadata manager</button>
                            </>}
                        </>}
                    </>}
                    <div class="profile-menu-divider" />
                    <button data-focusable="true" role="menuitem" type="button" onClick={() => openProfileScreen('accounts')}>Switch user</button>
                    <div class="profile-menu-divider" />
                    <button data-focusable="true" role="menuitem" class="sign-out-menu-item" type="button" onClick={logout}>Sign out</button>
                </div>}
            </div>
        </header>}

        {isMobileNavOpen && !(view === 'profile' && profileScreen === 'accounts') && <div class="mobile-nav-layer">
            <button class="mobile-nav-backdrop" type="button" aria-label="Close navigation menu" onClick={closeMobileNav} />
            <nav id="mobile-library-drawer" ref={mobileNavRef} class="mobile-library-drawer" aria-label="Libraries" aria-modal="true" role="dialog">
                <div class="drawer-heading">
                    <div><p class="eyebrow">YOUR COLLECTION</p><h2>Browse</h2></div>
                    <button class="drawer-close" type="button" data-focusable="true" aria-label="Close navigation menu" onClick={closeMobileNav}>×</button>
                </div>
                <button data-focusable="true" class={view === 'home' ? 'drawer-link active' : 'drawer-link'} onClick={() => { goHome(); closeMobileNav(); }}>Home</button>
                {views.map(library => <button data-focusable="true" class={activeLibrary?.Id === library.Id ? 'drawer-link active' : 'drawer-link'} key={library.Id} onClick={() => { closeMobileNav(); void openItem(library); }}>
                    <span class="drawer-library-icon" aria-hidden="true">{library.Name.slice(0, 1).toUpperCase()}</span>{library.Name}<span class="drawer-arrow" aria-hidden="true">›</span>
                </button>)}
                {!views.length && <p class="drawer-empty">No libraries are available for this user.</p>}
            </nav>
        </div>}

        <main class="main-content">
            {import.meta.env.DEV && session.server.indexOf('http://') === 0 && <div class="notice storage-warning" role="status"><span>Development connection is using unencrypted HTTP. Do not use real credentials or access this backend over an untrusted network.</span></div>}
            {!persistentSession && <div class="notice storage-warning" role="status"><span>This browser is not saving your session. Keep this tab open; you may need to sign in again when it closes.</span></div>}
            {error && <div class="notice error" role="alert"><span>{error}</span><button data-focusable="true" onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
            {loading && <div class="loading-bar" aria-label="Loading" />}
            {view === 'profile' && api && <ProfileScreen
                screen={profileScreen}
                api={api}
                session={session}
                isAdministrator={isAdministrator}
                rememberedUsers={rememberedUsers}
                onSelectRemembered={switchToRememberedUser}
                onSignInAnother={() => signInAsAnotherUser()}
                onBack={() => setView(profileReturnView.current)}
            />}
            {view === 'home' && <>
                {recommendations.length > 0
                    ? <section class="recommendation-hero" aria-label="Recommended for you" onFocusIn={e => {
                        // TV remotes reveal tall blocks edge-first, which can
                        // leave the hero half visible. Center it on entry
                        // from outside so remote users see the whole banner.
                        // Moves inside the hero (carousel stepping) skip this.
                        if (!tvClient) return;
                        const target = e.target as HTMLElement | null;
                        const hero = target?.closest<HTMLElement>('.recommendation-hero');
                        if (!hero) return;
                        if (e.relatedTarget instanceof HTMLElement && hero.contains(e.relatedTarget)) return;
                        hero.scrollIntoView({ block: 'center', inline: 'nearest' });
                    }}>
                        <Artwork eager key={`recommendation-art-${recommendations[activeRecommendation].Id}`} api={api} item={recommendations[activeRecommendation]} backdrop className={`recommendation-art ${recommendationDirection}`} />
                        <div class="recommendation-shade" />
                        <div key={`recommendation-copy-${recommendations[activeRecommendation].Id}`} class={`recommendation-copy ${recommendationDirection}`} aria-live="polite">
                            <p class="eyebrow">{recommendationLabel(recommendations[activeRecommendation])}</p>
                            <RecommendationTitle api={api} item={recommendations[activeRecommendation]} />
                            <div class="recommendation-metadata">
                                {recommendations[activeRecommendation].ProductionYear && <span>{recommendations[activeRecommendation].ProductionYear}</span>}
                                {recommendations[activeRecommendation].CommunityRating && <span>★ {recommendations[activeRecommendation].CommunityRating.toFixed(1)}</span>}
                                {recommendations[activeRecommendation].RunTimeTicks && <span>{Math.round(recommendations[activeRecommendation].RunTimeTicks / 600000000)} min</span>}
                            </div>
                            <p class="recommendation-overview">{recommendations[activeRecommendation].Overview || 'A recommendation picked for you from your library.'}</p>
                            <button data-focusable="true" class="button primary" onClick={openRecommendation}>View details <span aria-hidden="true">→</span></button>
                        </div>
                        {recommendations.length > 1 && <div class="recommendation-controls" aria-label="Recommendation carousel controls">
                            <button data-focusable="true" class="recommendation-arrow" aria-label="Previous recommendation" onClick={() => stepRecommendation(-1)}>‹</button>
                            <div ref={recommendationPaginationRef} class="recommendation-pagination" aria-label={`Recommendation ${activeRecommendation + 1} of ${recommendations.length}`}>
                                {recommendations.map((item, index) => <button key={item.Id} data-focusable="true" class={index === activeRecommendation ? 'recommendation-dot active' : 'recommendation-dot'} aria-label={`Show recommendation ${index + 1}: ${item.Name}`} aria-current={index === activeRecommendation ? 'true' : undefined} onClick={() => selectRecommendation(index)} />)}
                            </div>
                            <span class="recommendation-count">{activeRecommendation + 1} / {recommendations.length}</span>
                            <button data-focusable="true" class="recommendation-arrow" aria-label="Next recommendation" onClick={() => stepRecommendation(1)}>›</button>
                        </div>}
                    </section>
                    : <section class="welcome-hero">
                        <div class="hero-copy"><p class="eyebrow">{recommendationsLoading ? 'FINDING YOUR NEXT FAVORITE' : 'A LITTLE ESCAPE, ANYTIME'}</p><h1>{recommendationsLoading ? 'Made for you.' : 'Your next great story.'}</h1><p>{recommendationsLoading ? 'Loading recommendations from your library…' : 'Explore your collection and find something to enjoy.'}</p>{!recommendationsLoading && <button data-focusable="true" class="button primary" onClick={() => views[0] && void openLibrary(views[0])}>Browse your library <span aria-hidden="true">→</span></button>}</div>
                        <div class="hero-shade" />
                    </section>}
                {views.length > 0 && <section class="home-library-chips" aria-label="Libraries">{views.map(library => <button data-focusable="true" class="home-library-chip" key={library.Id} onClick={() => void openLibrary(library)}>{library.Name}</button>)}</section>}
                {homeLoading.views && <HomeSectionLoading label="Loading your libraries…" />}
                {homeErrors.views && <HomeSectionError title="Libraries could not load" message={homeErrors.views} onRetry={() => retryHomeSection('views')} />}
                <HomeFeed blocks={homeFeedBlocks} api={api} onSelect={selectItem} onPlay={playItem} onNeedMore={loadMoreHomeFeed} hasMore={homeExploreStart < homeExploreTotal} loadingMore={loadingHomeExplore} />
                {homeLoading.resume && !homeFeedBlocks.some(block => block.id === 'continue') && <HomeSectionLoading label="Loading continue watching…" />}
                {homeErrors.resume && <HomeSectionError title="Continue watching is taking too long" message={homeErrors.resume} onRetry={() => retryHomeSection('resume')} />}
                {homeLoading.latest && <HomeSectionLoading label="Loading recently added…" />}
                {homeErrors.latest && <HomeSectionError title="Recently added could not load" message={homeErrors.latest} onRetry={() => retryHomeSection('latest')} />}
                {!loading && !homeLoading.views && !homeLoading.resume && !homeLoading.latest && !homeErrors.views && !homeErrors.resume && !homeErrors.latest && !views.length && !resumeItems.length && !latestItems.length && <EmptyState title="Your library is ready" text="We could not find any libraries for this account yet." />}
            </>}
             {view === 'show' && tvSeries && <ShowDetailView
                 api={api}
                series={tvSeries}
                seasons={showSeasons}
                activeSeasonId={activeSeasonId}
                episodesBySeason={episodesBySeason}
                loadingSeasons={loadingSeasons}
                spacerHeights={seasonSpacerHeights}
                seasonNodes={seasonNodes}
                 onBack={() => { if (searchReturn.current) { searchReturn.current = false; clearShowQuery(); setView('search'); } else void navigateLibraryUp(); }}
                 backLabel={searchReturn.current ? 'Back to search' : activeLibrary ? 'Back to library' : 'Back to home'}
                 loading={loading}
                 onEnsureSeason={seasonId => loadSeasonEpisodes(tvSeries.Id, seasonId)}
                 onActivateSeason={activateShowSeason}
                 onSelectSeason={scrollToSeasonAndLoad}
                 onSelectEpisode={(episode, bookmark) => { void openItem(episode, { kind: 'show', bookmark }); }}
                 onPlayEpisode={(episode, bookmark) => { void play(episode, { kind: 'show', bookmark }); }}
                 restore={showRestore}
                 onRestoreComplete={() => setShowRestore(null)}
             />}
            {view === 'library' && activeLibrary && <LibraryPage key={activeLibrary.Id} api={api} library={activeLibrary} onBack={() => void navigateLibraryUp()} onSelect={selectItem} onPlay={playItem} />}
            {view === 'search' && (tvClient && api
                ? <TvSearchPage draft={searchDraft} onDraft={setSearchDraft} items={items} loading={loading} api={api} views={views} onOpenLibrary={library => void openLibrary(library)} onBack={goHome} onSelect={item => { searchReturn.current = true; selectItem(item); }} />
                : <section class="catalog-page"><div class="catalog-heading"><button class="back-link" data-focusable="true" onClick={goHome}>← <span>Home</span></button><p class="eyebrow">SEARCH RESULTS</p><h1>Results for “{search}”</h1><p class="muted">{items.length} titles</p></div>{items.length ? <VirtualizedMediaGrid items={items} api={api} onSelect={selectItem} /> : !loading && <EmptyState title="No matches found" text="Try another search or choose a different library." />}</section>)}
             {view === 'live' && api && <LiveTvPage api={api} userId={session.user.Id} tab={liveTab} onTab={next => { setLiveTab(next); rememberLiveQuery(next); }} onPlay={item => void play(item, { kind: 'live', scrollY: window.scrollY })} />}
             {view === 'details' && selected && <DetailPage api={api} item={selected} backLabel={detailOrigin.current?.kind === 'show' ? 'Back to show' : detailOrigin.current?.kind === 'search' ? 'Back to search' : detailOrigin.current?.kind === 'library' ? 'Back to library' : 'Back to home'} onBack={returnFromDetails} onPlay={() => void play(selected)} />}
        </main>
    </div>
    {view === 'player' && playerUrl && <Player url={playerUrl} item={playerItem} playback={playback} api={api} tvClient={tvClient} onBack={leavePlayer} onPlayItem={next => void play(next, playbackOrigin.current || undefined)} onPlaybackReported={itemId => void applyReportedPlayback(itemId)} onError={() => setError('Playback could not start in this browser. Try another quality or playback method.')} />}
    {view !== 'player' && profileScreen === 'quickconnect' && session && api && <ProfileScreen screen="quickconnect" api={api} session={session} isAdministrator={isAdministrator} onBack={() => setProfileScreen('playback')} />}
    </>;
}

function TvSearchPage({ draft, onDraft, items, loading, api, views, onOpenLibrary, onBack, onSelect }: {
    draft: string;
    onDraft: (value: string) => void;
    items: MediaItem[];
    loading: boolean;
    api: JellyfinApi | null;
    views: MediaItem[];
    onOpenLibrary: (library: MediaItem) => void;
    onBack: () => void;
    onSelect: (item: MediaItem) => void;
}) {
    const [ genres, setGenres ] = useState<Array<{ Name?: string; Id?: string }>>([]);
    const pageRef = useRef<HTMLElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const rows: string[][] = [
        [ '1', '2', '3', '4', '5', '6', '7', '8', '9', '0' ],
        [ 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P' ],
        [ 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L' ],
        [ 'Z', 'X', 'C', 'V', 'B', 'N', 'M' ]
    ];
    useEffect(() => {
        inputRef.current?.focus();
    }, []);
    useEffect(() => {
        if (!api) return;
        let active = true;
        void api.getGenres('').then(result => {
            if (active) setGenres((result || []).slice(0, 8));
        }).catch(() => undefined);
        return () => { active = false; };
    }, [ api ]);
    const focusInPage = (selector: string) => {
        pageRef.current?.querySelector<HTMLElement>(selector)?.focus();
    };
    const exitFieldKeyDown = (e: KeyboardEvent) => {
        const key = (e as KeyboardEvent).key;
        const code = (e as KeyboardEvent).keyCode;
        if (key === 'ArrowDown' || code === 40) {
            e.preventDefault();
            focusInPage('.tv-search-keyboard .tv-search-key');
        } else if (key === 'ArrowUp' || code === 38) {
            e.preventDefault();
            focusInPage('.tv-search-back');
        } else if (key === 'Escape') {
            e.preventDefault();
            onBack();
        }
    };
    const append = (key: string) => {
        onDraft((draft + (/^[A-Z]$/.test(key) ? key.toLowerCase() : key)).slice(0, 60));
    };
    const backspace = () => onDraft(draft.slice(0, -1));
    const searching = draft.trim().length >= 2;
    return <section ref={pageRef} class="tv-search-page" aria-label="Search your library">
        <div class="tv-search-panel">
            <button data-focusable="true" class="back-link tv-search-back" type="button" onClick={onBack}>← <span>Back</span></button>
            <p class="eyebrow">SEARCH</p>
            <h1>Find movies, shows and episodes</h1>
            <form class="tv-search-field" onSubmit={e => e.preventDefault()}>
                <input ref={inputRef} data-focusable="true" value={draft} onInput={e => onDraft((e.target as HTMLInputElement).value.slice(0, 60))} onKeyDown={exitFieldKeyDown} placeholder="Type a title…" aria-label="Search query" />
            </form>
            <div class="tv-search-keyboard" aria-label="On-screen keyboard">
                {rows.map((row, rowIndex) => <div class="tv-search-row" key={rowIndex}>
                    {row.map(key => <button data-focusable="true" class="tv-search-key" type="button" key={key} aria-label={`Type ${key}`} onClick={() => append(key)}>{key}</button>)}
                    {rowIndex === 3 && <button data-focusable="true" class="tv-search-key tv-search-key-wide" type="button" aria-label="Backspace" onClick={backspace}>⌫</button>}
                </div>)}
                <div class="tv-search-row">
                    <button data-focusable="true" class="tv-search-key tv-search-key-wide" type="button" onClick={() => onDraft(draft && !draft.endsWith(' ') ? draft + ' ' : draft)}>Space</button>
                    <button data-focusable="true" class="tv-search-key tv-search-key-wide" type="button" onClick={() => onDraft('')}>Clear</button>
                </div>
            </div>
        </div>
        <div class="tv-search-results" aria-live="polite">
            {searching ? <>
                <p class="eyebrow">RESULTS</p>
                {loading && <p class="muted" role="status">Searching…</p>}
                {!loading && items.length > 0 && <p class="muted">{items.length} titles</p>}
                {items.length > 0
                    ? <VirtualizedMediaGrid items={items} api={api} onSelect={onSelect} showKind />
                    : !loading && <EmptyState title="No matches found" text="Try another search or pick a suggestion." />}
            </> : <>
                <p class="eyebrow">POPULAR RIGHT NOW</p>
                <h2>Start exploring</h2>
                {genres.length > 0 && <div class="tv-suggest-group" aria-label="Genres">
                    {genres.map(genre => genre.Name && <button key={genre.Name} data-focusable="true" class="home-library-chip" type="button" onClick={() => onDraft(genre.Name || '')}>{genre.Name}</button>)}
                </div>}
                {views.length > 0 && <div class="tv-suggest-group" aria-label="Libraries">
                    {views.map(library => <button key={library.Id} data-focusable="true" class="home-library-chip" type="button" onClick={() => onOpenLibrary(library)}>{library.Name}</button>)}
                </div>}
                <p class="muted">Type two or more letters to search your whole library.</p>
            </>}
        </div>
    </section>;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function deduplicateItems(items: MediaItem[]): MediaItem[] {
    const seen = new Set<string>();
    return items.filter(item => {
        if (!item.Id || seen.has(item.Id)) return false;
        seen.add(item.Id);
        return true;
    });
}

function shuffleItems(items: MediaItem[]): MediaItem[] {
    const shuffled = items.slice();
    for (let index = shuffled.length - 1; index > 0; index--) {
        const target = Math.floor(Math.random() * (index + 1));
        const current = shuffled[index];
        shuffled[index] = shuffled[target];
        shuffled[target] = current;
    }
    return shuffled;
}

function recommendationLabel(item: MediaItem): string {
    const type = item.RecommendationType;
    if (type === 6) return 'FOR YOU · MOVIES';
    if (type === 7) return 'FOR YOU · TV SHOWS';
    if (type === 8) return 'FROM YOUR LIBRARY';
    if (type === 0) return item.BaselineItemName ? `BECAUSE YOU WATCHED ${item.BaselineItemName.toUpperCase()}` : 'BECAUSE YOU WATCHED';
    if (type === 1) return item.BaselineItemName ? `BECAUSE YOU LIKED ${item.BaselineItemName.toUpperCase()}` : 'BECAUSE YOU LIKED';
    if (type === 2 || type === 4) return item.BaselineItemName ? `DIRECTED BY ${item.BaselineItemName.toUpperCase()}` : 'DIRECTOR PICK';
    if (type === 3 || type === 5) return item.BaselineItemName ? `STARRING ${item.BaselineItemName.toUpperCase()}` : 'CAST PICK';
    return 'PICKED FOR YOU';
}

function findSection(element: Element | null): Element | null {
    let current = element;
    while (current && current.className !== 'section-block') current = current.parentElement;
    return current;
}

const artworkWaiters = new Map<Element, () => void>();
let sharedArtworkObserver: IntersectionObserver | null | undefined;
let legacyArtworkListening = false;
let legacyArtworkFrame = 0;

function sharedArtworkObserverInstance(): IntersectionObserver | null {
    if (sharedArtworkObserver !== undefined) return sharedArtworkObserver;
    if (typeof IntersectionObserver === 'undefined') {
        sharedArtworkObserver = null;
        return null;
    }
    sharedArtworkObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const load = artworkWaiters.get(entry.target);
            if (!load) return;
            artworkWaiters.delete(entry.target);
            sharedArtworkObserver?.unobserve(entry.target);
            load();
        });
    }, { rootMargin: '280px' });
    return sharedArtworkObserver;
}

function checkLegacyArtwork(): void {
    Array.from(artworkWaiters.entries()).forEach(([element, load]) => {
        const rect = element.getBoundingClientRect();
        if (rect.bottom >= -280 && rect.top <= window.innerHeight + 280) {
            artworkWaiters.delete(element);
            load();
        }
    });
    if (!artworkWaiters.size && legacyArtworkListening) {
        window.removeEventListener('scroll', scheduleLegacyArtwork);
        window.removeEventListener('resize', scheduleLegacyArtwork);
        legacyArtworkListening = false;
    }
}

function scheduleLegacyArtwork(): void {
    if (legacyArtworkFrame) return;
    legacyArtworkFrame = window.requestAnimationFrame(() => {
        legacyArtworkFrame = 0;
        checkLegacyArtwork();
    });
}

function watchArtwork(element: Element, load: () => void): () => void {
    const observer = sharedArtworkObserverInstance();
    artworkWaiters.set(element, load);
    if (!observer) {
        if (!legacyArtworkListening) {
            window.addEventListener('scroll', scheduleLegacyArtwork, { passive: true });
            window.addEventListener('resize', scheduleLegacyArtwork);
            legacyArtworkListening = true;
        }
        scheduleLegacyArtwork();
        return () => {
            artworkWaiters.delete(element);
            if (!artworkWaiters.size && legacyArtworkListening) {
                window.removeEventListener('scroll', scheduleLegacyArtwork);
                window.removeEventListener('resize', scheduleLegacyArtwork);
                legacyArtworkListening = false;
            }
        };
    }
    observer.observe(element);
    return () => {
        artworkWaiters.delete(element);
        observer.unobserve(element);
    };
}

function initialArtwork(api: JellyfinApi | null, item: MediaItem, backdrop: boolean): { src: string; fallback: boolean } {
    if (!api) return { src: '', fallback: false };
    if (!backdrop) return { src: peekCachedImage(api.imageUrl(item, 'Primary', 460)), fallback: false };
    const backdropSrc = peekCachedImage(api.imageUrl(item, 'Backdrop', 1280));
    if (backdropSrc) return { src: backdropSrc, fallback: false };
    return { src: '', fallback: false };
}

const Artwork = memo(function Artwork({ api, item, backdrop = false, className = '', eager = false }: { api: JellyfinApi | null; item: MediaItem; backdrop?: boolean; className?: string; eager?: boolean }) {
    const initial = initialArtwork(api, item, backdrop);
    const [ src, setSrc ] = useState(initial.src);
    const [ usedPosterFallback, setUsedPosterFallback ] = useState(initial.fallback);
    const holder = useRef<HTMLDivElement>(null);
    const retainedKeyRef = useRef('');
    const fallbackCancel = useRef<(() => void) | undefined>(undefined);
    useEffect(() => {
        if (!api) return;
        let active = true;
        let stopWatch: (() => void) | undefined;
        const bags: Array<{ cancel?: () => void }> = [];
        const track = () => {
            const bag: { cancel?: () => void } = {};
            bags.push(bag);
            return bag;
        };
        const hold = (key: string, objectUrl: string, fallback: boolean) => {
            if (!active) return;
            if (objectUrl && retainedKeyRef.current !== key) {
                if (retainedKeyRef.current) releaseCachedImage(retainedKeyRef.current);
                retainedKeyRef.current = key;
                retainCachedImage(key);
            }
            setSrc(objectUrl);
            setUsedPosterFallback(fallback);
        };
        const load = () => {
            if (!active || !api) return;
            if (!backdrop) {
                const key = api.imageUrl(item, 'Primary', 460);
                const cached = peekCachedImage(key);
                if (cached) {
                    hold(key, cached, false);
                    return;
                }
                void api.loadImage(item, 'Primary', 460, 90, track()).then(url => hold(key, url, false));
                return;
            }
            const backdropKey = api.imageUrl(item, 'Backdrop', 1280);
            const cachedBackdrop = peekCachedImage(backdropKey);
            if (cachedBackdrop) {
                hold(backdropKey, cachedBackdrop, false);
                return;
            }
            void api.loadImage(item, 'Backdrop', 1280, 90, track()).then(url => {
                if (!active) return;
                if (url) {
                    hold(backdropKey, url, false);
                    return;
                }
                const posterKey = api.imageUrl(item, 'Primary', 960);
                void api.loadImage(item, 'Primary', 960, 90, track()).then(poster => hold(posterKey, poster, Boolean(poster)));
            });
        };
        if (eager) load();
        else if (holder.current) stopWatch = watchArtwork(holder.current, load);
        else load();
        return () => {
            active = false;
            bags.forEach(bag => bag.cancel?.());
            fallbackCancel.current?.();
            stopWatch?.();
            if (retainedKeyRef.current) {
                releaseCachedImage(retainedKeyRef.current);
                retainedKeyRef.current = '';
            }
        };
    }, [ api, item.Id, item.ImageTags?.Primary, item.ImageTags?.Backdrop, item.BackdropImageTags?.[0], backdrop, eager ]);
    const onImageError = () => {
        if (!api || !backdrop || usedPosterFallback) {
            setSrc('');
            return;
        }
        setUsedPosterFallback(true);
        const posterKey = api.imageUrl(item, 'Primary', 960);
        const bag: { cancel?: () => void } = {};
        fallbackCancel.current?.();
        void api.loadImage(item, 'Primary', 960, 90, bag).then(url => {
            if (!url || !holder.current?.isConnected) return;
            if (retainedKeyRef.current && retainedKeyRef.current !== posterKey) releaseCachedImage(retainedKeyRef.current);
            retainedKeyRef.current = posterKey;
            retainCachedImage(posterKey);
            setSrc(url);
        });
        fallbackCancel.current = () => bag.cancel?.();
    };
    return <div ref={holder} class={`artwork ${className} ${src ? 'has-image' : ''} ${usedPosterFallback ? 'poster-fallback' : ''}`} aria-hidden="true">{src && <img class="artwork-image" src={src} alt="" decoding="async" onError={onImageError} />}<span class="art-placeholder">{item.Name.slice(0, 1)}</span></div>;
});

function RecommendationTitle({ api, item }: { api: JellyfinApi | null; item: MediaItem }) {
    const logoUrl = api && item.ImageTags?.Logo ? api.imageUrl(item, 'Logo', 1000) : '';
    const cachedLogo = peekCachedImage(logoUrl);
    const [ logoState, setLogoState ] = useState<{ status: 'loading' | 'logo' | 'text'; url: string }>(() => ({
        status: cachedLogo ? 'logo' : logoUrl ? 'loading' : 'text',
        url: cachedLogo
    }));
    useEffect(() => {
        let active = true;
        if (!api || !logoUrl) {
            setLogoState({ status: 'text', url: '' });
            return;
        }
        const apply = (url: string) => {
            if (!active) return;
            if (url) retainCachedImage(logoUrl);
            setLogoState({ status: url ? 'logo' : 'text', url });
        };
        const cached = peekCachedImage(logoUrl);
        if (cached) apply(cached);
        else {
            setLogoState({ status: 'loading', url: '' });
            const bag: { cancel?: () => void } = {};
            void api.loadImage(item, 'Logo', 1000, 90, bag).then(apply).catch(() => {
                if (active) setLogoState({ status: 'text', url: '' });
            });
            return () => {
                active = false;
                bag.cancel?.();
                releaseCachedImage(logoUrl);
            };
        }
        return () => {
            active = false;
            releaseCachedImage(logoUrl);
        };
    }, [ api, item.Id, logoUrl ]);

    if (logoState.status === 'loading') {
        return <div class="recommendation-title-slot logo-loading" role="status" aria-label={`Loading ${item.Name} logo`}><span /></div>;
    }
    if (logoState.status === 'logo' && logoState.url) {
        return <div class="recommendation-title-slot"><img class="recommendation-title-logo" src={logoState.url} alt={item.Name} decoding="async" onError={() => { releaseCachedImage(logoUrl); setLogoState({ status: 'text', url: '' }); }} /></div>;
    }
    return <div class="recommendation-title-slot"><h1>{item.Name}</h1></div>;
}

function MediaRow({ title, subtitle, items, api, onSelect }: { title: string; subtitle: string; items: MediaItem[]; api: JellyfinApi | null; onSelect: (item: MediaItem) => void }) {
    return <section class="section-block"><div class="section-heading"><div><p class="eyebrow">{subtitle}</p><h2>{title}</h2></div><div class="row-controls"><button data-focusable="true" aria-label="Scroll row left" onClick={e => (findSection(e.currentTarget)?.querySelector('.media-row') as HTMLElement)?.scrollBy({ left: -700, behavior: 'smooth' })}>←</button><button data-focusable="true" aria-label="Scroll row right" onClick={e => (findSection(e.currentTarget)?.querySelector('.media-row') as HTMLElement)?.scrollBy({ left: 700, behavior: 'smooth' })}>→</button></div></div><div class="media-row">{items.map(item => <MediaCard key={item.Id} api={api} item={item} onSelect={onSelect} />)}</div></section>;
}

function mediaKind(item: MediaItem): { label: string; detail: string; live: boolean } | null {
    const liveProgram = Boolean(item.ChannelId || item.IsLive || item.Type === 'Program');
    if (liveProgram) {
        const now = Date.now();
        if (isAiring(item, now)) return { label: 'Live', detail: item.ChannelName || '', live: true };
        if (item.StartDate) {
            const start = Date.parse(item.StartDate);
            if (Number.isFinite(start)) return { label: formatClock(start), detail: item.ChannelName || '', live: false };
        }
        return { label: 'Live TV', detail: item.ChannelName || '', live: false };
    }
    if (item.Type === 'Episode' || item.SeriesId) {
        const code = episodeCode(item);
        return { label: code || 'Episode', detail: item.SeriesName || (item.ProductionYear ? String(item.ProductionYear) : ''), live: false };
    }
    const detail = item.ProductionYear ? String(item.ProductionYear) : '';
    switch (item.Type) {
        case 'Series': return { label: 'Series', detail, live: false };
        case 'Movie': return { label: 'Movie', detail, live: false };
        case 'BoxSet': return { label: 'Collection', detail, live: false };
        case 'Person': return { label: 'Person', detail, live: false };
        case 'TvChannel': return { label: 'Channel', detail, live: false };
        case 'MusicAlbum':
        case 'MusicArtist':
        case 'Audio': return { label: 'Music', detail, live: false };
        default: return item.Type ? { label: item.Type, detail, live: false } : (detail ? { label: '', detail, live: false } : null);
    }
}

const MediaCard = memo(function MediaCard({ api, item, onSelect, eager = false, showKind = false }: { api: JellyfinApi | null; item: MediaItem; onSelect: (item: MediaItem) => void; eager?: boolean; showKind?: boolean }) {
    const kind = showKind ? mediaKind(item) : null;
    const fallback = item.ProductionYear ? String(item.ProductionYear) : (item.SeriesName || 'In your library');
    return <button data-focusable="true" class="media-card" onClick={() => onSelect(item)} aria-label={`View ${item.Name}`}><span class="media-card-art"><Artwork eager={eager} api={api} item={item} /><span class="media-card-overlay"><span class="media-name">{item.Name}</span>{kind
        ? <span class="media-year">{kind.label && <span class={kind.live ? 'media-kind-live' : 'media-kind'}>{kind.label}</span>}{kind.label && kind.detail ? ' · ' : ''}{kind.detail || (!kind.label ? fallback : '')}</span>
        : <>{item.ProductionYear && <span class="media-year">{item.ProductionYear}</span>}</>}</span>{item.UserData?.PlayedPercentage !== undefined && item.UserData.PlayedPercentage > 0 && <span class="progress-track"><span style={{ width: `${Math.min(100, item.UserData.PlayedPercentage)}%` }} /></span>}</span></button>;
});

function VirtualizedMediaGrid({ items, api, onSelect, hasMore = false, onNearEnd, showKind = false }: { items: MediaItem[]; api: JellyfinApi | null; onSelect: (item: MediaItem) => void; hasMore?: boolean; onNearEnd?: () => void; showKind?: boolean }) {
    const gridRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const itemsLengthRef = useRef(items.length);
    const onNearEndRef = useRef(onNearEnd);
    const geometryRef = useRef({ columns: 6, rowHeight: 360, rowGap: 24, top: 0 });
    const [ range, setRange ] = useState({ start: 0, end: 8, columns: 6, rowHeight: 360, rowGap: 24 });
    const rangeRef = useRef(range);
    itemsLengthRef.current = items.length;
    onNearEndRef.current = onNearEnd;

    const publishWindow = useCallback(() => {
        const geometry = geometryRef.current;
        const count = itemsLengthRef.current;
        const columns = Math.max(1, geometry.columns);
        const rowHeight = Math.max(1, geometry.rowHeight);
        const rowCount = Math.max(1, Math.ceil(count / columns));
        const firstVisibleRow = Math.max(0, Math.floor((window.scrollY - geometry.top) / rowHeight));
        const visibleRowCount = Math.ceil(window.innerHeight / rowHeight) + 1;
        const startRow = Math.max(0, firstVisibleRow - 2);
        const endRow = Math.min(rowCount, firstVisibleRow + visibleRowCount + 2);
        const current = rangeRef.current;
        if (current.start === startRow && current.end === endRow && current.columns === columns && current.rowHeight === rowHeight && current.rowGap === geometry.rowGap) return;
        const next = { start: startRow, end: endRow, columns, rowHeight, rowGap: geometry.rowGap };
        rangeRef.current = next;
        setRange(next);
    }, []);

    useLayoutEffect(() => {
        const grid = gridRef.current;
        if (!grid) return;
        let frame = 0;
        const measure = () => {
            const card = grid.querySelector<HTMLElement>('.media-card');
            const style = window.getComputedStyle(grid);
            const columns = Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
            const rowGap = parseFloat(style.rowGap || style.gap || '0') || 0;
            const cardHeight = card?.getBoundingClientRect().height || 350;
            geometryRef.current = {
                columns,
                rowHeight: Math.max(1, cardHeight + rowGap),
                rowGap,
                top: grid.getBoundingClientRect().top + window.scrollY
            };
            publishWindow();
        };
        let observer: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => {
                if (frame) return;
                frame = window.requestAnimationFrame(() => {
                    frame = 0;
                    measure();
                });
            });
            observer.observe(grid);
        }
        window.addEventListener('resize', measure);
        measure();
        return () => {
            observer?.disconnect();
            if (frame) window.cancelAnimationFrame(frame);
            window.removeEventListener('resize', measure);
        };
    }, [ items.length, publishWindow ]);

    useEffect(() => {
        let frame = 0;
        const onScroll = () => {
            if (frame) return;
            frame = window.requestAnimationFrame(() => {
                frame = 0;
                publishWindow();
            });
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
        return () => {
            window.removeEventListener('scroll', onScroll);
            if (frame) window.cancelAnimationFrame(frame);
        };
    }, [ items.length, publishWindow ]);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!hasMore || !sentinel || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) onNearEndRef.current?.();
        }, { rootMargin: '0px 0px 100% 0px' });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [ hasMore, items.length ]);

    const columns = Math.max(1, range.columns);
    const startIndex = range.start * columns;
    const endIndex = Math.min(items.length, range.end * columns);
    const beforeHeight = range.start * range.rowHeight;
    const rowCount = Math.ceil(items.length / columns);
    const afterHeight = Math.max(0, (rowCount - range.end) * range.rowHeight - range.rowGap);

    return <div ref={gridRef} class="poster-grid virtualized-poster-grid">
        {beforeHeight > 0 && <div class="virtual-grid-spacer" aria-hidden="true" style={{ height: `${beforeHeight}px`, gridColumn: '1 / -1' }} />}
        {items.slice(startIndex, endIndex).map(item => <div class="virtual-grid-cell" key={item.Id}><MediaCard eager api={api} item={item} onSelect={onSelect} showKind={showKind} /></div>)}
        {afterHeight > 0 && <div class="virtual-grid-spacer" aria-hidden="true" style={{ height: `${afterHeight}px`, gridColumn: '1 / -1' }} />}
        {hasMore && <div ref={sentinelRef} class="virtual-grid-sentinel" style={{ height: '1px', gridColumn: '1 / -1' }} aria-hidden="true" />}
    </div>;
}

function DetailPage({ api, item, backLabel, onBack, onPlay }: { api: JellyfinApi | null; item: MediaItem; backLabel: string; onBack: () => void; onPlay: () => void }) {
    const playRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!isTvClient()) return;
        const frame = window.requestAnimationFrame(() => playRef.current?.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [ item.Id ]);
    return <section class="detail-page"><Artwork eager api={api} item={item} backdrop className="detail-backdrop" /><div class="detail-gradient" /><div class="detail-content"><button data-focusable="true" class="back-link" onClick={onBack}>← <span>{backLabel}</span></button><p class="eyebrow">{item.Type || 'FEATURED'}</p><h1>{item.Name}</h1><div class="metadata">{item.ProductionYear && <span>{item.ProductionYear}</span>}{item.CommunityRating && <span>★ {item.CommunityRating.toFixed(1)}</span>}{item.RunTimeTicks && <span>{Math.round(item.RunTimeTicks / 600000000)} min</span>}</div><p class="overview">{item.Overview || 'A story waiting to be discovered.'}</p><div class="detail-actions"><button ref={playRef} data-focusable="true" class="button primary" onClick={onPlay}>▶ <span>Play</span></button><button data-focusable="true" class="button secondary" onClick={onBack}>{backLabel}</button></div></div></section>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
    return <div class="empty-state"><span aria-hidden="true">✳</span><h2>{title}</h2><p>{text}</p></div>;
}

function HomeSectionLoading({ label }: { label: string }) {
    return <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />{label}</div>;
}

function HomeSectionError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
    const friendlyMessage = message.indexOf('took too long') >= 0
        ? 'The server is taking longer than expected. Other sections can still load while this one is unavailable.'
        : message;
    return <div class="home-section-error" role="alert">
        <div><h3>{title}</h3><p>{friendlyMessage}</p></div>
        <button data-focusable="true" class="button secondary" onClick={onRetry}>Retry</button>
    </div>;
}

interface ShowDetailViewProps {
    api: JellyfinApi | null;
    series: MediaItem;
    seasons: MediaItem[];
    activeSeasonId: string;
    episodesBySeason: Record<string, MediaItem[]>;
    loadingSeasons: Record<string, boolean>;
    spacerHeights: Record<string, number>;
    seasonNodes: { current: Record<string, HTMLElement | null> };
    onBack: () => void;
    onEnsureSeason: (seasonId: string) => Promise<MediaItem[]>;
    onActivateSeason: (seasonId: string) => void;
    onSelectSeason: (seasonId: string, signal?: AbortSignal) => Promise<void>;
    onSelectEpisode: (episode: MediaItem, bookmark: ShowBookmark) => void;
    onPlayEpisode: (episode: MediaItem, bookmark: ShowBookmark) => void;
    restore: ShowBookmark | null;
    onRestoreComplete: () => void;
    loading: boolean;
    backLabel: string;
}

function ShowDetailView(props: ShowDetailViewProps) {
    const { api, series, seasons, activeSeasonId, episodesBySeason, loadingSeasons, spacerHeights, seasonNodes, onBack, onSelectEpisode, onPlayEpisode, backLabel } = props;
    const root = useRef<HTMLDivElement>(null);
    const latest = useRef(props);
    latest.current = props;
    const intent = useRef<AbortController | null>(null);
    const internalFocus = useRef(false);
    const lastTarget = useRef<ShowTarget | null>(null);
    const lastElement = useRef<HTMLElement | null>(null);
    const userInput = useRef(false);
    const initialEntry = useRef(false);
    const restoreSeen = useRef<ShowBookmark | null>(null);
    type PendingFocus = { owner: AbortController; target: ShowTarget; bookmark: ShowBookmark | null; settle: (focused: boolean) => void };
    const pending = useRef<PendingFocus | null>(null);
    const [ commit, setCommit ] = useState(0);

    useLayoutEffect(() => {
        cancelIntent();
        lastTarget.current = null;
        lastElement.current = null;
        userInput.current = false;
        initialEntry.current = false;
        restoreSeen.current = null;
        return cancelIntent;
    }, [ series.Id ]);

    function owns(owner: AbortController): boolean {
        return intent.current === owner && !owner.signal.aborted && Boolean(root.current?.isConnected);
    }

    function cancelIntent() {
        intent.current?.abort();
        intent.current = null;
        pending.current?.settle(false);
        pending.current = null;
    }

    function beginIntent(): AbortController {
        cancelIntent();
        const owner = new AbortController();
        intent.current = owner;
        return owner;
    }

    function visible(element: HTMLElement | null): element is HTMLElement {
        return Boolean(element && element.getBoundingClientRect().width && element.getBoundingClientRect().height);
    }

    function navigatorNode(): HTMLElement | null {
        const sidebar = root.current?.querySelector<HTMLElement>('.season-sidebar') || null;
        return visible(sidebar) ? sidebar : root.current?.querySelector<HTMLElement>('.season-mobile-rail') || null;
    }

    function context(): Context {
        const play = root.current?.querySelector<HTMLElement>('[data-show-control="play"]') || null;
        const sidebar = root.current?.querySelector<HTMLElement>('.season-sidebar') || null;
        return {
            seasons: latest.current.seasons.map(season => ({ id: season.Id, episodeIds: latest.current.episodesBySeason[season.Id]?.map(episode => episode.Id) ?? null })),
            activeSeasonId: latest.current.activeSeasonId,
            layout: visible(sidebar) ? 'sidebar' : 'rail',
            controls: visible(play) ? ['art', 'title', 'play'] : ['art', 'title']
        };
    }

    function parseTarget(element: EventTarget | null): ShowTarget | null {
        if (!(element instanceof HTMLElement)) return null;
        const control = element.closest<HTMLElement>('[data-show-control]');
        if (control && root.current?.contains(control)) {
            const part = control.dataset.showControl;
            if (part === 'back') return { kind: 'back' };
            const episodeId = control.dataset.episodeId;
            const seasonId = control.dataset.seasonId;
            if ((part === 'art' || part === 'title' || part === 'play') && episodeId && seasonId) return { kind: 'episode', seasonId, episodeId, control: part };
        }
        const season = element.closest<HTMLElement>('[data-season-nav]');
        if (season?.dataset.seasonNav && root.current?.contains(season)) return { kind: 'season', id: season.dataset.seasonNav };
        return element.closest('.topbar') ? { kind: 'header' } : null;
    }

    function normalizeTarget(target: ShowTarget): ShowTarget {
        if (target.kind === 'episode' && target.control === 'play' && !context().controls.includes('play')) return { ...target, control: 'title' };
        return target;
    }

    function targetNode(target: ShowTarget): HTMLElement | null {
        switch (target.kind) {
            case 'header': {
                const active = document.querySelector<HTMLElement>('.topbar .nav-link.active');
                return visible(active) ? active : Array.from(document.querySelectorAll<HTMLElement>('.topbar [data-focusable="true"]')).find(element => visible(element)) || null;
            }
            case 'back':
                return root.current?.querySelector<HTMLElement>('[data-show-control="back"]') || null;
            case 'season':
                return navigatorNode()?.querySelector<HTMLElement>(`[data-season-nav="${CSS.escape(target.id)}"]`) || null;
            case 'episode':
                return root.current?.querySelector<HTMLElement>(`[data-season-id="${CSS.escape(target.seasonId)}"][data-episode-id="${CSS.escape(target.episodeId)}"][data-show-control="${target.control}"]`) || null;
        }
    }

    function focusTarget(target: ShowTarget, owner: AbortController, bookmark: ShowBookmark | null = null): boolean {
        if (!owns(owner)) return false;
        const normalized = normalizeTarget(target);
        const node = targetNode(normalized);
        if (!visible(node)) return false;
        if (bookmark) {
            window.scrollTo({ top: bookmark.scrollY, behavior: 'instant' });
            const nav = navigatorNode();
            if (nav) { nav.scrollTop = bookmark.navScroll.top; nav.scrollLeft = bookmark.navScroll.left; }
        }
        internalFocus.current = true;
        try { node.focus({ preventScroll: true }); } finally { internalFocus.current = false; }
        if (document.activeElement !== node || !owns(owner)) return false;
        lastTarget.current = normalized;
        lastElement.current = node;
        if (!bookmark) node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        return true;
    }

    function frame(owner: AbortController): Promise<boolean> {
        if (!owns(owner)) return Promise.resolve(false);
        return new Promise(resolve => {
            const aborted = () => { window.cancelAnimationFrame(id); resolve(false); };
            const id = window.requestAnimationFrame(() => {
                owner.signal.removeEventListener('abort', aborted);
                resolve(owns(owner));
            });
            owner.signal.addEventListener('abort', aborted, { once: true });
        });
    }

    function focusOnCommit(target: ShowTarget, owner: AbortController, bookmark: ShowBookmark | null = null): Promise<boolean> {
        if (!owns(owner)) return Promise.resolve(false);
        return new Promise(resolve => {
            pending.current = { owner, target, bookmark, settle: resolve };
            setCommit(value => value + 1);
        });
    }

    useLayoutEffect(() => {
        const request = pending.current;
        if (!request) return;
        pending.current = null;
        request.settle(focusTarget(request.target, request.owner, request.bookmark));
    }, [ commit, episodesBySeason, activeSeasonId, seasons ]);

    async function selectSeason(id: string, owner: AbortController) {
        if (!owns(owner)) return;
        focusTarget({ kind: 'season', id }, owner);
        latest.current.onActivateSeason(id);
        try {
            await latest.current.onSelectSeason(id, owner.signal);
            if (!owns(owner)) return;
            await frame(owner);
            if (!owns(owner)) return;
        } catch (_error) {
            // The parent reports load failures; the navigator keeps focus.
        }
    }

    async function applyMove(result: ShowFocusResult, owner: AbortController) {
        const loaded = new Map<string, readonly string[]>();
        const visited = new Set<string>();
        while (owns(owner)) {
            if (result.kind !== 'boundary') {
                if (result.kind === 'season') {
                    focusTarget(result, owner);
                    latest.current.onActivateSeason(result.id);
                } else if (result.kind === 'episode') {
                    latest.current.onActivateSeason(result.seasonId);
                    if (!focusTarget(result, owner)) {
                        if (!await frame(owner) || !owns(owner)) return;
                        if (!await focusOnCommit(result, owner) && owns(owner)) focusTarget({ kind: 'season', id: result.seasonId }, owner);
                    }
                } else focusTarget(result, owner);
                return;
            }
            if (visited.has(result.seasonId)) return;
            visited.add(result.seasonId);
            const boundary = result;
            focusTarget({ kind: 'season', id: boundary.seasonId }, owner);
            latest.current.onActivateSeason(boundary.seasonId);
            let episodes: MediaItem[];
            try { episodes = await latest.current.onEnsureSeason(boundary.seasonId); } catch (_error) { return; }
            if (!owns(owner)) return;
            loaded.set(boundary.seasonId, episodes.map(episode => episode.Id));
            if (!await frame(owner) || !owns(owner)) return;
            const fresh = context();
            const snapshot: Context = { ...fresh, seasons: fresh.seasons.map(season => ({ ...season, episodeIds: season.episodeIds ?? loaded.get(season.id) ?? null })) };
            result = enterShowSeason(snapshot, boundary.seasonId, boundary.edge, boundary.control, boundary.step);
            if (result.kind === 'episode') {
                latest.current.onActivateSeason(result.seasonId);
                const focused = await focusOnCommit(result, owner);
                if (!owns(owner)) return;
                if (!focused) focusTarget({ kind: 'season', id: result.seasonId }, owner);
                return;
            }
        }
    }

    async function restoreBookmark(bookmark: ShowBookmark, owner: AbortController) {
        let target = bookmark.target;
        if (target.kind === 'episode' || target.kind === 'season') {
            const id = target.kind === 'episode' ? target.seasonId : target.id;
            if (!latest.current.seasons.some(season => season.Id === id)) {
                const active = latest.current.activeSeasonId || latest.current.seasons[0]?.Id;
                target = active ? { kind: 'season', id: active } : { kind: 'back' };
            } else {
                latest.current.onActivateSeason(id);
                if (target.kind === 'episode') {
                    let episodes = latest.current.episodesBySeason[id];
                    if (!episodes) {
                        focusTarget({ kind: 'season', id }, owner);
                        try { episodes = await latest.current.onEnsureSeason(id); } catch (_error) { episodes = []; }
                        if (!owns(owner)) return;
                    }
                    if (!episodes.some(episode => target.kind === 'episode' && episode.Id === target.episodeId)) target = { kind: 'season', id };
                }
            }
        }
        if (!await frame(owner) || !owns(owner)) return;
        let focused = await focusOnCommit(target, owner, bookmark);
        if (!owns(owner)) return;
        if (!focused && target.kind === 'episode') {
            focused = await focusOnCommit({ kind: 'season', id: target.seasonId }, owner, bookmark);
            if (!owns(owner)) return;
        }
        if (focused) latest.current.onRestoreComplete();
    }

    useEffect(() => {
        const onFocusIn = (event: FocusEvent) => {
            if (!internalFocus.current) { userInput.current = true; cancelIntent(); }
            const target = parseTarget(event.target);
            lastTarget.current = target;
            lastElement.current = event.target instanceof HTMLElement ? event.target : null;
            if (target?.kind === 'episode') latest.current.onActivateSeason(target.seasonId);
        };
        const onInput = (event: Event) => {
            if (event instanceof KeyboardEvent && !internalFocus.current) {
                userInput.current = true;
                cancelIntent();
            } else if (!(event instanceof KeyboardEvent)) {
                userInput.current = true;
                lastElement.current = null;
                cancelIntent();
            }
        };
        const onResize = () => {
            const active = document.activeElement;
            const target = parseTarget(active) || lastTarget.current;
            const element = active === document.body ? lastElement.current : active;
            cancelIntent();
            if (!target || !(element instanceof HTMLElement) || !root.current?.contains(element) || visible(element)) return;
            const owner = beginIntent();
            focusTarget(normalizeTarget(target), owner);
        };
        document.addEventListener('focusin', onFocusIn);
        window.addEventListener('keydown', onInput, true);
        window.addEventListener('pointerdown', onInput, true);
        window.addEventListener('mousedown', onInput, true);
        window.addEventListener('touchstart', onInput, true);
        window.addEventListener('resize', onResize);
        window.visualViewport?.addEventListener('resize', onResize);
        return () => {
            cancelIntent();
            document.removeEventListener('focusin', onFocusIn);
            window.removeEventListener('keydown', onInput, true);
            window.removeEventListener('pointerdown', onInput, true);
            window.removeEventListener('mousedown', onInput, true);
            window.removeEventListener('touchstart', onInput, true);
            window.removeEventListener('resize', onResize);
            window.visualViewport?.removeEventListener('resize', onResize);
        };
    }, []);

    useLayoutEffect(() => {
        if (props.restore && props.restore.seriesId === series.Id) {
            if (props.loading || restoreSeen.current === props.restore || userInput.current) return;
            restoreSeen.current = props.restore;
            initialEntry.current = true;
            void restoreBookmark(props.restore, beginIntent());
            return;
        }
        if (initialEntry.current || userInput.current || props.loading || !seasons.length || !activeSeasonId) return;
        initialEntry.current = true;
        if (!document.documentElement.classList.contains('tv-client') || document.activeElement !== document.body) return;
        focusTarget({ kind: 'season', id: activeSeasonId }, beginIntent());
    }, [ props.restore, props.loading, seasons, activeSeasonId, series.Id ]);

    function handleKey(event: KeyboardEvent) {
        if (!document.documentElement.classList.contains('tv-client')) return;
        const key = event.key;
        if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight') return;
        const direction: Direction = key;
        const from = parseTarget(event.target);
        if (!from) return;
        event.preventDefault();
        event.stopPropagation();
        userInput.current = true;
        const owner = beginIntent();
        const result = moveShowFocus(from, direction, context());
        if (from.kind === 'season' && result.kind === 'season' && result.id !== from.id) {
            void selectSeason(result.id, owner);
        } else void applyMove(result, owner);
    }

    function clickSeason(id: string) {
        userInput.current = true;
        void selectSeason(id, beginIntent());
    }

    function captureBookmark(seasonId: string, episodeId: string, control: EpisodeControl): ShowBookmark {
        const nav = navigatorNode();
        const bookmark: ShowBookmark = { seriesId: latest.current.series.Id, target: { kind: 'episode', seasonId, episodeId, control }, scrollY: window.scrollY, navScroll: { top: nav?.scrollTop || 0, left: nav?.scrollLeft || 0 } };
        cancelIntent();
        return bookmark;
    }

    const totalEpisodes = seasons.reduce((sum, season) => sum + (season.ChildCount || 0), 0);
    const endYear = series.EndDate ? new Date(series.EndDate).getFullYear() : null;

    return <div ref={root} class="show-detail-view" onKeyDown={handleKey}>
        <section class="show-backdrop">
            <Artwork eager api={api} item={series} backdrop className="show-backdrop-art" />
            <div class="show-backdrop-shade" />
            <div class="show-header-copy">
                <button class="back-link" data-show-control="back" data-focusable="true" onClick={() => { cancelIntent(); onBack(); }}>← <span>{backLabel}</span></button>
                <p class="eyebrow">TV SERIES</p>
                <h1>{series.Name}</h1>
                <div class="show-metadata">
                    {series.ProductionYear && <span>{series.ProductionYear}{endYear && endYear !== series.ProductionYear && `–${endYear}`}</span>}
                    {series.CommunityRating && <span>★ {series.CommunityRating.toFixed(1)}</span>}
                    <span>{seasons.length} seasons</span>
                    {totalEpisodes > 0 && <span>{totalEpisodes} episodes</span>}
                </div>
                {series.Overview && <p class="show-overview">{series.Overview}</p>}
            </div>
        </section>

        <nav class="season-mobile-rail" aria-label="Show seasons">
            {seasons.map((season, index) => <button
                key={season.Id}
                data-season-nav={season.Id}
                data-focusable="true"
                class={season.Id === activeSeasonId ? 'season-pill active' : 'season-pill'}
                aria-current={season.Id === activeSeasonId ? 'true' : undefined}
                onClick={() => clickSeason(season.Id)}
            >{season.IndexNumber === 0 ? 'Specials' : `Season ${season.IndexNumber ?? index + 1}`}</button>)}
        </nav>

        <div class="episode-explorer">
            <aside class="season-sidebar" aria-label="Show seasons">
                <p class="eyebrow">SEASONS</p>
                {seasons.map((season, index) => {
                    const episodes = episodesBySeason[season.Id] || [];
                    const watched = episodes.filter(episode => episode.UserData?.Played).length;
                    const episodeCount = season.ChildCount || episodes.length;
                    return <button
                        key={season.Id}
                        data-season-nav={season.Id}
                        data-focusable="true"
                        class={season.Id === activeSeasonId ? 'season-side-link active' : 'season-side-link'}
                        aria-current={season.Id === activeSeasonId ? 'true' : undefined}
                        onClick={() => clickSeason(season.Id)}
                    >
                        <Artwork api={api} item={season} className="season-thumb" />
                        <span class="season-side-text"><strong>{season.IndexNumber === 0 ? 'Specials' : `Season ${season.IndexNumber ?? index + 1}`}</strong><small>{episodeCount} episodes</small>{episodes.length > 0 && <span class="season-progress"><i style={{ width: `${watched / episodes.length * 100}%` }} /></span>}</span>
                    </button>;
                })}
            </aside>
            <div class="episode-feed">
                {seasons.map((season, index) => {
                    const episodes = episodesBySeason[season.Id];
                    const activeIndex = seasons.findIndex(item => item.Id === activeSeasonId);
                    const withinWindow = Math.abs(index - activeIndex) <= 1;
                    const spacerHeight = spacerHeights[season.Id] || Math.max(300, (season.ChildCount || 3) * 174 + 150);
                    if (!withinWindow && !episodes) {
                        return <div key={season.Id} class="season-spacer" data-season-section data-season-id={season.Id} ref={element => { seasonNodes.current[season.Id] = element; }} style={{ minHeight: `${spacerHeight}px` }} aria-label={`${season.Name}, ${season.ChildCount || 0} episodes`} />;
                    }
                    const watched = (episodes || []).filter(episode => episode.UserData?.Played).length;
                    const episodeCount = season.ChildCount || episodes?.length || 0;
                    return <section key={season.Id} class="season-section" data-season-section data-season-id={season.Id} ref={element => { seasonNodes.current[season.Id] = element; }}>
                        <header class="season-section-header">
                            <div class="season-heading-copy"><p class="eyebrow">{season.IndexNumber === 0 ? 'SPECIALS' : `SEASON ${season.IndexNumber ?? index + 1}`}</p><h2>{season.Name}</h2></div>
                            <div class="season-heading-meta">{season.PremiereDate && <span>{new Date(season.PremiereDate).getFullYear()}</span>}<span>{episodeCount} episodes</span>{episodes?.length ? <span>{watched} watched</span> : null}</div>
                        </header>
                        {loadingSeasons[season.Id] && !episodes && <HomeSectionLoading label="Loading episodes…" />}
                        {episodes && episodes.length > 0 && <div class="episode-list">{episodes.map(episode => <EpisodeCard key={episode.Id} api={api} episode={episode} seasonId={season.Id} captureBookmark={captureBookmark} onOpen={onSelectEpisode} onPlay={onPlayEpisode} />)}</div>}
                        {!loadingSeasons[season.Id] && episodes && episodes.length === 0 && <p class="season-empty">No episodes are available in this season.</p>}
                    </section>;
                })}
                {!seasons.length && (props.loading ? <HomeSectionLoading label="Loading seasons…" /> : <EmptyState title="No seasons found" text="This TV show does not have any seasons available." />)}
            </div>
        </div>
    </div>;
}

const EpisodeCard = memo(function EpisodeCard({ api, episode, seasonId, captureBookmark, onOpen, onPlay }: {
    api: JellyfinApi | null;
    episode: MediaItem;
    seasonId: string;
    captureBookmark: (seasonId: string, episodeId: string, control: EpisodeControl) => ShowBookmark;
    onOpen: (episode: MediaItem, bookmark: ShowBookmark) => void;
    onPlay: (episode: MediaItem, bookmark: ShowBookmark) => void;
}) {
    const progress = episode.UserData?.PlayedPercentage || 0;
    return <article data-episode-id={episode.Id} data-season-id={seasonId} class={episode.UserData?.Played ? 'episode-card played' : 'episode-card'}>
        <button class="episode-art-button" data-show-control="art" data-episode-id={episode.Id} data-season-id={seasonId} data-focusable="true" aria-label={`Play ${episode.Name}`} onClick={() => onPlay(episode, captureBookmark(seasonId, episode.Id, 'art'))}>
            <Artwork api={api} item={episode} className="episode-art" />
            {episode.RunTimeTicks && <span class="episode-runtime">{Math.round(episode.RunTimeTicks / 600000000)} min</span>}
            {episode.UserData?.Played && <span class="episode-watched" aria-label="Watched">✓</span>}
            {progress > 0 && progress < 100 && <span class="progress-track episode-progress"><span style={{ width: `${progress}%` }} /></span>}
        </button>
        <div class="episode-copy">
            <button class="episode-title" data-show-control="title" data-episode-id={episode.Id} data-season-id={seasonId} data-focusable="true" onClick={() => onOpen(episode, captureBookmark(seasonId, episode.Id, 'title'))}><span class="episode-number">{episode.IndexNumber !== undefined ? `E${String(episode.IndexNumber).padStart(2, '0')}` : 'EPISODE'}</span><span>{episode.Name}</span></button>
            <div class="episode-meta">{episode.PremiereDate && <span>{new Date(episode.PremiereDate).toLocaleDateString()}</span>}{episode.RunTimeTicks && <span>{Math.round(episode.RunTimeTicks / 600000000)} min</span>}</div>
            {episode.Overview && <p>{episode.Overview}</p>}
        </div>
        <button class="episode-play" data-show-control="play" data-episode-id={episode.Id} data-season-id={seasonId} data-focusable="true" aria-label={`Play ${episode.Name}`} onClick={() => onPlay(episode, captureBookmark(seasonId, episode.Id, 'play'))}>▶</button>
    </article>;
});

render(<App />, document.getElementById('app')!);
