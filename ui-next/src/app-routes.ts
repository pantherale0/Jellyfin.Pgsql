export type AppRoute =
    | { view: 'home' }
    | { view: 'favorites' }
    | { view: 'nowplaying' }
    | { view: 'library'; libraryId: string }
    | { view: 'search'; term: string }
    | { view: 'details'; itemId: string }
    | { view: 'show'; seriesId: string; season?: string }
    | { view: 'live'; tab: string }
    | { view: 'profile'; screen: string }
    | { view: 'player'; itemId: string };

export interface RouteInputs {
    view: string;
    libraryId?: string;
    search?: string;
    itemId?: string;
    seriesId?: string;
    season?: string;
    liveTab?: string;
    profileScreen?: string;
    playerItemId?: string;
}

/** The consumer route for the current view, or null for views that own their own URL (admin) or are incomplete. */
export function routeFor(input: RouteInputs): AppRoute | null {
    switch (input.view) {
    case 'home': return { view: 'home' };
    case 'favorites': return { view: 'favorites' };
    case 'nowplaying': return { view: 'nowplaying' };
    case 'library': return input.libraryId ? { view: 'library', libraryId: input.libraryId } : null;
    case 'search': return { view: 'search', term: input.search || '' };
    case 'details': return input.itemId ? { view: 'details', itemId: input.itemId } : null;
    case 'show': return input.seriesId ? { view: 'show', seriesId: input.seriesId, season: input.season } : null;
    case 'live': return { view: 'live', tab: input.liveTab || 'now' };
    case 'profile': return { view: 'profile', screen: input.profileScreen || 'playback' };
    case 'player': return input.playerItemId ? { view: 'player', itemId: input.playerItemId } : null;
    default: return null;
    }
}

/** Identity decides push vs replace: a new page pushes, a tab/season/term change within a page replaces. Episode changes inside the player replace too. */
export function routeIdentity(route: AppRoute): string {
    switch (route.view) {
    case 'library': return `library:${route.libraryId}`;
    case 'details': return `details:${route.itemId}`;
    case 'show': return `show:${route.seriesId}`;
    case 'player': return 'player';
    case 'profile': return `profile:${route.screen}`;
    default: return route.view;
    }
}

export function routeFromState(state: unknown): AppRoute | null {
    const route = (state as { uiNext?: unknown } | null)?.uiNext as Partial<AppRoute> | undefined;
    if (!route || typeof route !== 'object' || typeof route.view !== 'string') return null;
    const candidate = routeFor({
        view: route.view,
        libraryId: (route as { libraryId?: string }).libraryId,
        search: (route as { term?: string }).term,
        itemId: (route as { itemId?: string }).itemId,
        seriesId: (route as { seriesId?: string }).seriesId,
        season: (route as { season?: string }).season,
        liveTab: (route as { tab?: string }).tab,
        profileScreen: (route as { screen?: string }).screen,
        playerItemId: (route as { itemId?: string }).itemId
    });
    return candidate;
}

/**
 * The route to reopen after a reload: the one stored in this history entry, unless the URL carries
 * a deep link that already decides the view (admin hash, `?show=`, `?live=`, `?item=`). A stored player route
 * reopens the item's details instead of resuming playback; home needs no restore.
 */
export function initialRoute(state: unknown, hash: string, search: string): AppRoute | null {
    if (hash.startsWith('#admin/')) return null;
    const query = new URLSearchParams(search);
    if (query.has('show') || query.has('live') || query.has('item')) return null;
    const route = routeFromState(state);
    if (!route || route.view === 'home') return null;
    return route.view === 'player' ? { view: 'details', itemId: route.itemId } : route;
}

export type HistoryAction = 'none' | 'push' | 'replace';

/** How the browser history should follow an in-app route change. */
export function historyAction(current: AppRoute | null, next: AppRoute, restoring: boolean): HistoryAction {
    if (restoring || !current) return 'replace';
    if (routeIdentity(current) !== routeIdentity(next)) return 'push';
    return JSON.stringify(current) === JSON.stringify(next) ? 'none' : 'replace';
}

export function withRoute(state: unknown, route: AppRoute): Record<string, unknown> {
    const base = state && typeof state === 'object' ? state as Record<string, unknown> : {};
    return { ...base, uiNext: route };
}
