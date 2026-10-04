import { h, render } from 'preact';
import { memo, lazy, Suspense } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { JellyfinApi, peekCachedImage, releaseCachedImage, retainCachedImage } from './api';
import { LiveTvPage } from './live-tv';
import { LibraryPage } from './library';
import { Player } from './player';
import { ProfileScreen, type ProfileScreenName } from './profile';
import { buildHomeFeedBlocks, HomeFeed } from './home-feed';
import { clearRememberedToken, getRememberedUsers, rememberUser, type RememberedUser } from './remembered-users';
import type { PlaybackChoice } from './player-model';
import type { LiveTab, MediaItem, RecommendationGroup, Session } from './types';
import './style.css';

const AdminDashboard = lazy(() => import('./admin/admin-dashboard').then(module => ({ default: module.AdminDashboard })));

const SESSION_KEY = 'jellyfin-ui-next-session';
const SAVED_SERVER_KEY = 'jellyfin-ui-next-server';
const SIGNED_OUT_KEY = 'jellyfin-ui-next-signed-out';
const configuredServer = import.meta.env.VITE_JELLYFIN_SERVER_URL?.trim() || '';

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
    let nearest: HTMLElement | null = null;
    let nearestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (entry.element === current) continue;
        const dx = entry.left + entry.width / 2 - cx;
        const dy = entry.top + entry.height / 2 - cy;
        const primary = direction[0] ? dx * direction[0] : dy * direction[1];
        const cross = direction[0] ? Math.abs(dy) : Math.abs(dx);
        if (primary > 4) {
            const score = primary + cross * 2;
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
    const [ search, setSearch ] = useState('');
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
    const episodeRequests = useRef<Record<string, boolean>>({});
    const episodesBySeasonRef = useRef<Record<string, MediaItem[]>>({});
    const activeSeasonIdRef = useRef('');
    const programmaticScroll = useRef(false);
    const programmaticScrollTimer = useRef<number>();
    const urlUpdateTimer = useRef<number>();
    const showInUrl = useRef(false);
    const openItemRef = useRef<(item: MediaItem) => void>(() => undefined);
    const playRef = useRef<(item: MediaItem) => void>(() => undefined);
    const playerOrigin = useRef<'live' | null>(null);
    const restoredLive = useRef(false);
    const selectItem = useCallback((item: MediaItem) => { void openItemRef.current(item); }, []);
    const playItem = useCallback((item: MediaItem) => { void playRef.current(item); }, []);
    episodesBySeasonRef.current = episodesBySeason;
    activeSeasonIdRef.current = activeSeasonId;
    const api = useMemo(() => session ? new JellyfinApi(session) : null, [ session ]);
    const tvClient = isTvClient();

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

    useEffect(() => {
        if (!profileMenuOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setProfileMenuOpen(false);
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [ profileMenuOpen ]);

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
        setProfileMenuOpen(false);
        setUsername(usernameHint);
        setPassword('');
        clearSignedInState(true);
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

    const forgetShow = () => {
        clearShowQuery();
        setTvSeries(null);
        setShowSeasons([]);
        setActiveSeasonId('');
        setEpisodesBySeason({});
        setLoadingSeasons({});
        setSeasonSpacerHeights({});
    };

    const goHome = () => {
        forgetShow();
        clearLiveQuery();
        setView('home');
    };

    const openLive = (next: LiveTab = 'now', library?: MediaItem | null) => {
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
        if (library.CollectionType?.toLowerCase() === 'livetv') {
            openLive('now', library);
            return;
        }
        clearLiveQuery();
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
            const seasons = (response.Items || []).slice().sort((a, b) => (a.IndexNumber ?? -1) - (b.IndexNumber ?? -1));
            setShowSeasons(seasons);
            if (!seasons.length) return;
            const seasonRequest = requestedSeason || queryParameter('season');
            const requested = seasons.find(season => seasonRequest === season.Id || seasonRequest === String(season.IndexNumber));
            const firstUnplayed = seasons.find(season => (season.UserData?.UnplayedItemCount || 0) > 0);
            const initialSeason = requested || seasons.find(season => season.IndexNumber === 1) || firstUnplayed || seasons[0];
            setActiveSeasonId(initialSeason.Id);
            await loadSeasonWindow(series.Id, seasons, initialSeason.Id);
            if (seasonRequest) window.requestAnimationFrame(() => scrollToSeason(initialSeason.Id, 'auto'));
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setLoading(false);
        }
    };

    const loadSeasonEpisodes = useCallback(async (seriesId: string, seasonId: string) => {
        if (!api || episodesBySeasonRef.current[seasonId] || episodeRequests.current[seasonId]) return;
        episodeRequests.current[seasonId] = true;
        setLoadingSeasons(current => ({ ...current, [seasonId]: true }));
        try {
            const episodes = await api.getAllSeasonEpisodes(seriesId, seasonId);
            setEpisodesBySeason(current => ({ ...current, [seasonId]: episodes }));
        } catch (e) {
            setError(messageOf(e));
        } finally {
            delete episodeRequests.current[seasonId];
            setLoadingSeasons(current => ({ ...current, [seasonId]: false }));
        }
    }, [ api ]);

    const loadSeasonWindow = useCallback(async (seriesId: string, seasons: MediaItem[], seasonId: string) => {
        const index = seasons.findIndex(season => season.Id === seasonId);
        const nearby = seasons.slice(Math.max(0, index - 1), index + 2);
        await Promise.all(nearby.map(season => loadSeasonEpisodes(seriesId, season.Id)));
    }, [ loadSeasonEpisodes ]);

    const scrollToSeason = useCallback((seasonId: string, behavior: ScrollBehavior = 'smooth') => {
        const section = seasonNodes.current[seasonId];
        if (!section) return;
        programmaticScroll.current = true;
        if (programmaticScrollTimer.current) window.clearTimeout(programmaticScrollTimer.current);
        setActiveSeasonId(seasonId);
        const season = showSeasons.find(item => item.Id === seasonId);
        if (season && tvSeries) rememberShowQuery(tvSeries.Id, season.IndexNumber !== undefined ? String(season.IndexNumber) : season.Id);
        try {
            section.scrollIntoView({ behavior, block: 'start' });
        } catch (_error) {
            section.scrollIntoView();
        }
        programmaticScrollTimer.current = window.setTimeout(() => { programmaticScroll.current = false; }, behavior === 'smooth' ? 1000 : 100);
    }, [ showSeasons, tvSeries ]);

    const scrollToSeasonAndLoad = async (seasonId: string) => {
        if (!tvSeries) return;
        const loading = loadSeasonWindow(tvSeries.Id, showSeasons, seasonId);
        await window.requestAnimationFrame(() => undefined);
        scrollToSeason(seasonId);
        void loading;
    };

    const loadedSeasonKey = showSeasons.map(season => episodesBySeason[season.Id] ? season.Id : '').join('|');

    useEffect(() => {
        if (!tvSeries || !showSeasons.length) return;
        const seasons = showSeasons;
        const series = tvSeries;
        const observer = new IntersectionObserver(entries => {
            if (programmaticScroll.current) return;
            const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
            const seasonId = visible?.target.getAttribute('data-season-id');
            if (!seasonId || seasonId === activeSeasonIdRef.current) return;
            const currentIndex = seasons.findIndex(season => season.Id === seasonId);
            if (currentIndex >= 0) {
                if (currentIndex > 0) void loadSeasonEpisodes(series.Id, seasons[currentIndex - 1].Id);
                void loadSeasonEpisodes(series.Id, seasonId);
                if (currentIndex < seasons.length - 1) void loadSeasonEpisodes(series.Id, seasons[currentIndex + 1].Id);
            }
            setActiveSeasonId(seasonId);
            const keep = new Set(seasons.slice(Math.max(0, currentIndex - 1), currentIndex + 2).map(season => season.Id));
            const outgoingHeights: Record<string, number> = {};
            const loaded = episodesBySeasonRef.current;
            seasons.forEach(season => {
                const section = seasonNodes.current[season.Id];
                if (!keep.has(season.Id) && section && loaded[season.Id]) {
                    const height = Math.ceil(section.getBoundingClientRect().height);
                    if (height > 0) outgoingHeights[season.Id] = height;
                }
            });
            if (Object.keys(outgoingHeights).length) setSeasonSpacerHeights(current => mergeMeasuredHeights(current, outgoingHeights));
            setEpisodesBySeason(current => {
                const ids = Object.keys(current);
                if (ids.length === keep.size && ids.every(id => keep.has(id))) return current;
                const next = { ...current };
                ids.forEach(id => { if (!keep.has(id)) delete next[id]; });
                return next;
            });
            if (urlUpdateTimer.current) window.clearTimeout(urlUpdateTimer.current);
            urlUpdateTimer.current = window.setTimeout(() => {
                urlUpdateTimer.current = undefined;
                const season = seasons.find(item => item.Id === seasonId);
                if (!season || !showInUrl.current) return;
                rememberShowQuery(series.Id, season.IndexNumber !== undefined ? String(season.IndexNumber) : season.Id);
            }, 200);
        }, { root: null, rootMargin: '-20% 0px -70% 0px', threshold: 0 });

        seasons.forEach(season => {
            const node = seasonNodes.current[season.Id];
            if (node) observer.observe(node);
        });
        return () => {
            observer.disconnect();
            if (urlUpdateTimer.current) {
                window.clearTimeout(urlUpdateTimer.current);
                urlUpdateTimer.current = undefined;
            }
        };
    }, [ tvSeries, showSeasons, loadSeasonEpisodes, loadedSeasonKey ]);

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

    const openItem = async (item: MediaItem) => {
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
        if (tvSeries && item.Type === 'Episode') {
            const currentSeason = showSeasons.find(season => season.Id === activeSeasonId);
            rememberShowQuery(tvSeries.Id, currentSeason ? (currentSeason.IndexNumber !== undefined ? String(currentSeason.IndexNumber) : currentSeason.Id) : undefined);
        }
        setSelected(item);
        setView('details');
        try {
            const full = await api.getItem(item.Id);
            setSelected(full);
        } catch (_error) { /* The list item remains usable if details are unavailable. */ }
    };

    const runSearch = async () => {
        if (!api || !search.trim()) return;
        forgetShow();
        clearLiveQuery();
        setView('search');
        setLoading(true);
        setError('');
        try {
            const response = await api.getItems('', 0, search.trim());
            setItems(response.Items || []);
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setLoading(false);
        }
    };

    const play = async (item: MediaItem, origin?: 'live') => {
        if (!api) return;
        setLoading(true);
        setError('');
        playerOrigin.current = null;
        try {
            let playbackItem = item;
            if ((item.Type === 'Episode' || item.SeriesId) && !item.SeriesName) {
                try { playbackItem = { ...item, ...(await api.getItem(item.Id)) }; } catch (_error) { playbackItem = item; }
            }
            const result = await api.play(playbackItem);
            setPlayerItem(playbackItem);
            setPlayback(result);
            setPlayerUrl(result.url);
            playerOrigin.current = origin || null;
            setView('player');
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setLoading(false);
        }
    };
    openItemRef.current = openItem;
    playRef.current = play;

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) && (event.key === 'Backspace' || event.key === 'Delete')) return;
            if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Back' || event.key === 'BrowserBack' || event.key === 'GoBack' || event.keyCode === 461 || event.keyCode === 10009) {
                if (isMobileNavOpen) {
                    event.preventDefault();
                    closeMobileNav();
                    return;
                }
                if (view === 'player') return;
                if (view === 'details') {
                    if (tvSeries) setView('show');
                    else {
                        clearShowQuery();
                        setView(activeLibrary ? 'library' : 'home');
                    }
                } else if (view === 'show') {
                    void navigateLibraryUp();
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
            if (!isTvClient() || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            if (view === 'home' && recommendations.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                const target = event.target as HTMLElement;
                if (target.closest('.recommendation-hero')) {
                    stepRecommendation(event.key === 'ArrowLeft' ? -1 : 1);
                    event.preventDefault();
                    return;
                }
            }
            if (view === 'show' && tvSeries && event.target instanceof HTMLElement) {
                const seasonNav = event.target.closest<HTMLElement>('[data-season-nav]');
                const inSidebar = Boolean(seasonNav?.closest('.season-sidebar'));
                const inRail = Boolean(seasonNav?.closest('.season-mobile-rail'));
                const movingSeason = (inSidebar && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))
                    || (inRail && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'));
                if (seasonNav && movingSeason) {
                    const index = showSeasons.findIndex(season => season.Id === seasonNav.getAttribute('data-season-nav'));
                    const next = index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1);
                    if (index >= 0 && next >= 0 && next < showSeasons.length) {
                        void scrollToSeasonAndLoad(showSeasons[next].Id);
                        event.preventDefault();
                        return;
                    }
                }
            }
            const directions: Record<string, [number, number]> = {
                ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
            };
            const direction = directions[event.key];
            if (!direction) return;
            const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (!current) {
                focusEntries()[0]?.element.focus();
                event.preventDefault();
                return;
            }
            const scopes = [ '.episode-list', '.virtualized-poster-grid', '.library-toolbar', '.alpha-scrubber', '.library-grid-items', '.media-row', '.season-sidebar', '.season-mobile-rail', '.primary-nav', '.mobile-library-drawer', '.recommendation-controls', '.episode-feed', '.live-tabs' ];
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
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [ view, selected, activeLibrary, isMobileNavOpen, closeMobileNav, recommendations.length, stepRecommendation, tvSeries, showSeasons ]);

    if (!session) {
        if (!localLogin && (ssoEnabled === null || quickConnectEnabled === null)) {
            return <main class="login-page"><section class="login-card"><div class="brand-mark">J</div><p class="eyebrow">SECURE SIGN-IN</p><h1>Checking sign-in…</h1><p class="muted">Connecting to your Jellyfin server.</p></section></main>;
        }
        if (!localLogin && quickConnectSelected && quickConnectEnabled) {
            return <main class="login-page">
                <section class="login-card" aria-labelledby="login-title">
                    <div class="brand-mark">J</div><p class="eyebrow">QUICK CONNECT</p><h1 id="login-title">Connect your device.</h1>
                    <p class="muted">On a signed-in Jellyfin device, open Quick Connect and enter this code.</p>
                    {quickConnectCode ? <div class="quick-connect-code" aria-live="polite">{quickConnectCode}</div> : <p class="quick-connect-wait">{quickConnectBusy ? 'Requesting a code…' : 'Waiting for Quick Connect…'}</p>}
                    {quickConnectError && <p class="notice error" role="alert">{quickConnectError}</p>}
                    <p class="security-note">This code expires automatically. Approve it only on a device you trust.</p>
                    {!tvClient && <button data-focusable="true" class="local-login-toggle" type="button" onClick={showSignInOptions}>Back to sign-in options</button>}
                    {tvClient && <button data-focusable="true" class="local-login-toggle" type="button" onClick={useLocalLogin}>Use username and password</button>}
                </section>
            </main>;
        }
        return <main class="login-page">
            <section class="login-card" aria-labelledby="login-title">
                <div class="brand-mark">J</div>
                <p class="eyebrow">YOUR MEDIA, YOUR WAY</p>
                <h1 id="login-title">Welcome back.</h1>
                <p class="muted">Connect to your Jellyfin server to continue.</p>
                {localLogin && ssoEnabled && <p class="notice storage-warning" role="status">Local sign-in bypass is active for this page.</p>}
                {ssoCheckFailed && <p class="notice error" role="status">Could not check whether SSO is enabled on this server. For a different-origin backend, allow this UI’s origin in Jellyfin CORS settings, then reload.</p>}
                {error && <p class="notice error" role="alert">{error}</p>}
                {!localLogin && !quickConnectSelected && <>
                    {!tvClient && ssoEnabled && <button data-focusable="true" class="button secondary full" type="button" onClick={() => void JellyfinApi.beginSso(server)}>Continue with SSO</button>}
                    <button data-focusable="true" class="button primary full" type="button" onClick={useQuickConnect}>Continue with Quick Access</button>
                    {!quickConnectEnabled && <p class="security-note">Quick Connect is not enabled on this Jellyfin server.</p>}
                    <button data-focusable="true" class="local-login-toggle" type="button" onClick={useLocalLogin}>Use username and password</button>
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
        setPlayerUrl('');
        setPlayerItem(null);
        setPlayback(null);
        if (playerOrigin.current === 'live') {
            playerOrigin.current = null;
            setView('live');
            return;
        }
        if (selected) setView('details');
        else if (tvSeries) setView('show');
        else goHome();
    };

    if (view === 'admin') {
        const backToMedia = () => { window.history.replaceState(null, '', window.location.pathname + window.location.search); setView('home'); };
        if (!adminAccessChecked || !isAdministrator || !api) return <main class="admin-workspace"><section class="ad-page" role="status"><h1>{adminAccessChecked ? 'Administrator access required' : 'Checking administrator access…'}</h1><button class="ad-btn" onClick={backToMedia}>Back to media</button></section></main>;
        return <Suspense fallback={<main class="admin-workspace"><p class="ad-page" role="status">Loading admin workspace…</p></main>}><AdminDashboard key={session.user.Id} api={api} session={session} onBack={backToMedia} /></Suspense>;
    }

    return <>
    <div class="app-shell" aria-hidden={view === 'player'}>
        <header class="topbar">
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
            <form class="search-box" onSubmit={e => { e.preventDefault(); void runSearch(); }} role="search">
                <span aria-hidden="true">⌕</span><input data-focusable="true" value={search} onInput={e => setSearch((e.target as HTMLInputElement).value)} placeholder="Search your library" aria-label="Search your library" />
            </form>
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
                            <button data-focusable="true" role="menuitem" type="button" onClick={() => { setProfileMenuOpen(false); window.location.assign(`${session.server}/web/index.html#!/dashboard`); }}>Classic dashboard</button>
                            <button data-focusable="true" role="menuitem" type="button" onClick={() => { setProfileMenuOpen(false); window.location.assign(`${session.server}/web/index.html#!/metadata`); }}>Metadata manager</button>
                        </>}
                    </>}
                    <div class="profile-menu-divider" />
                    <button data-focusable="true" role="menuitem" type="button" onClick={() => openProfileScreen('accounts')}>Switch user</button>
                    <div class="profile-menu-divider" />
                    <button data-focusable="true" role="menuitem" class="sign-out-menu-item" type="button" onClick={logout}>Sign out</button>
                </div>}
            </div>
        </header>

        {isMobileNavOpen && <div class="mobile-nav-layer">
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
                    ? <section class="recommendation-hero" aria-label="Recommended for you">
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
                onBack={() => void navigateLibraryUp()}
                onSelectSeason={scrollToSeasonAndLoad}
                onSelectEpisode={selectItem}
                 onPlayEpisode={playItem}
             />}
            {view === 'library' && activeLibrary && <LibraryPage key={activeLibrary.Id} api={api} library={activeLibrary} onBack={() => void navigateLibraryUp()} onSelect={selectItem} onPlay={playItem} />}
            {view === 'search' && <section class="catalog-page"><div class="catalog-heading"><button class="back-link" data-focusable="true" onClick={goHome}>← <span>Home</span></button><p class="eyebrow">SEARCH RESULTS</p><h1>Results for “{search}”</h1><p class="muted">{items.length} titles</p></div>{items.length ? <VirtualizedMediaGrid items={items} api={api} onSelect={selectItem} /> : !loading && <EmptyState title="No matches found" text="Try another search or choose a different library." />}</section>}
            {view === 'live' && api && <LiveTvPage api={api} userId={session.user.Id} tab={liveTab} onTab={next => { setLiveTab(next); rememberLiveQuery(next); }} onPlay={item => void play(item, 'live')} />}
            {view === 'details' && selected && <DetailPage api={api} item={selected} onBack={() => { if (tvSeries) setView('show'); else { clearShowQuery(); setView(activeLibrary ? 'library' : 'home'); } }} onPlay={() => void play(selected)} />}
        </main>
    </div>
    {view === 'player' && playerUrl && <Player url={playerUrl} item={playerItem} playback={playback} api={api} tvClient={tvClient} onBack={leavePlayer} onPlayItem={next => void play(next)} onPlaybackReported={itemId => void applyReportedPlayback(itemId)} onError={() => setError('Playback could not start in this browser. Try another quality or playback method.')} />}
    {view !== 'player' && profileScreen === 'quickconnect' && session && api && <ProfileScreen screen="quickconnect" api={api} session={session} isAdministrator={isAdministrator} onBack={() => setProfileScreen('playback')} />}
    </>;
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

const MediaCard = memo(function MediaCard({ api, item, onSelect, eager = false }: { api: JellyfinApi | null; item: MediaItem; onSelect: (item: MediaItem) => void; eager?: boolean }) {
    return <button data-focusable="true" class="media-card" onClick={() => onSelect(item)} aria-label={`View ${item.Name}`}><Artwork eager={eager} api={api} item={item} /><span class="media-name">{item.Name}</span>{item.ProductionYear && <span class="media-year">{item.ProductionYear}</span>}{item.UserData?.PlayedPercentage !== undefined && item.UserData.PlayedPercentage > 0 && <span class="progress-track"><span style={{ width: `${Math.min(100, item.UserData.PlayedPercentage)}%` }} /></span>}</button>;
});

function VirtualizedMediaGrid({ items, api, onSelect, hasMore = false, onNearEnd }: { items: MediaItem[]; api: JellyfinApi | null; onSelect: (item: MediaItem) => void; hasMore?: boolean; onNearEnd?: () => void }) {
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
        {items.slice(startIndex, endIndex).map(item => <div class="virtual-grid-cell" key={item.Id}><MediaCard eager api={api} item={item} onSelect={onSelect} /></div>)}
        {afterHeight > 0 && <div class="virtual-grid-spacer" aria-hidden="true" style={{ height: `${afterHeight}px`, gridColumn: '1 / -1' }} />}
        {hasMore && <div ref={sentinelRef} class="virtual-grid-sentinel" style={{ height: '1px', gridColumn: '1 / -1' }} aria-hidden="true" />}
    </div>;
}

function DetailPage({ api, item, onBack, onPlay }: { api: JellyfinApi | null; item: MediaItem; onBack: () => void; onPlay: () => void }) {
    return <section class="detail-page"><Artwork eager api={api} item={item} backdrop className="detail-backdrop" /><div class="detail-gradient" /><div class="detail-content"><button data-focusable="true" class="back-link" onClick={onBack}>← <span>Back</span></button><p class="eyebrow">{item.Type || 'FEATURED'}</p><h1>{item.Name}</h1><div class="metadata">{item.ProductionYear && <span>{item.ProductionYear}</span>}{item.CommunityRating && <span>★ {item.CommunityRating.toFixed(1)}</span>}{item.RunTimeTicks && <span>{Math.round(item.RunTimeTicks / 600000000)} min</span>}</div><p class="overview">{item.Overview || 'A story waiting to be discovered.'}</p><div class="detail-actions"><button data-focusable="true" class="button primary" onClick={onPlay}>▶ <span>Play</span></button><button data-focusable="true" class="button secondary" onClick={onBack}>Back to library</button></div></div></section>;
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
    onSelectSeason: (seasonId: string) => void;
    onSelectEpisode: (episode: MediaItem) => void;
    onPlayEpisode: (episode: MediaItem) => void;
}

function ShowDetailView({
    api,
    series,
    seasons,
    activeSeasonId,
    episodesBySeason,
    loadingSeasons,
    spacerHeights,
    seasonNodes,
    onBack,
    onSelectSeason,
    onSelectEpisode,
    onPlayEpisode
}: ShowDetailViewProps) {
    const totalEpisodes = seasons.reduce((sum, season) => sum + (season.ChildCount || 0), 0);

    return <div class="show-detail-view">
        <section class="show-backdrop">
            <Artwork eager api={api} item={series} backdrop className="show-backdrop-art" />
            <div class="show-backdrop-shade" />
            <div class="show-header-copy">
                <button class="back-link" data-focusable="true" onClick={onBack}>← <span>Back to library</span></button>
                <p class="eyebrow">TV SERIES</p>
                <h1>{series.Name}</h1>
                <div class="show-metadata">
                    {series.ProductionYear && <span>{series.ProductionYear}{series.EndDate && `–${new Date(series.EndDate).getFullYear()}`}</span>}
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
                onClick={() => onSelectSeason(season.Id)}
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
                        onClick={() => onSelectSeason(season.Id)}
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
                        {episodes && episodes.length > 0 && <div class="episode-list">{episodes.map(episode => <EpisodeCard key={episode.Id} api={api} episode={episode} onOpen={onSelectEpisode} onPlay={onPlayEpisode} />)}</div>}
                        {!loadingSeasons[season.Id] && episodes && episodes.length === 0 && <p class="season-empty">No episodes are available in this season.</p>}
                    </section>;
                })}
                {!seasons.length && <EmptyState title="No seasons found" text="This TV show does not have any seasons available." />}
            </div>
        </div>
    </div>;
}

const EpisodeCard = memo(function EpisodeCard({ api, episode, onOpen, onPlay }: { api: JellyfinApi | null; episode: MediaItem; onOpen: (episode: MediaItem) => void; onPlay: (episode: MediaItem) => void }) {
    const progress = episode.UserData?.PlayedPercentage || 0;
    return <article class={episode.UserData?.Played ? 'episode-card played' : 'episode-card'}>
        <button class="episode-art-button" data-focusable="true" aria-label={`Play ${episode.Name}`} onClick={() => onPlay(episode)}>
            <Artwork api={api} item={episode} className="episode-art" />
            {episode.RunTimeTicks && <span class="episode-runtime">{Math.round(episode.RunTimeTicks / 600000000)} min</span>}
            {episode.UserData?.Played && <span class="episode-watched" aria-label="Watched">✓</span>}
            {progress > 0 && progress < 100 && <span class="progress-track episode-progress"><span style={{ width: `${progress}%` }} /></span>}
        </button>
        <div class="episode-copy">
            <button class="episode-title" data-focusable="true" onClick={() => onOpen(episode)}><span class="episode-number">{episode.IndexNumber !== undefined ? `E${String(episode.IndexNumber).padStart(2, '0')}` : 'EPISODE'}</span><span>{episode.Name}</span></button>
            <div class="episode-meta">{episode.PremiereDate && <span>{new Date(episode.PremiereDate).toLocaleDateString()}</span>}{episode.RunTimeTicks && <span>{Math.round(episode.RunTimeTicks / 600000000)} min</span>}</div>
            {episode.Overview && <p>{episode.Overview}</p>}
        </div>
        <button class="episode-play" data-focusable="true" aria-label={`Play ${episode.Name}`} onClick={() => onPlay(episode)}>▶</button>
    </article>;
});

render(<App />, document.getElementById('app')!);
