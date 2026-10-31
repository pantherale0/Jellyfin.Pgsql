import { useEffect, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import type { MediaItem } from './types';
import { userMessage } from './ui-errors';
import { MediaRow } from './detail-sections';
import { appendPage, hasMoreResults } from './catalog-model';
import { ENTITY_SEARCH_SECTIONS, FAVORITE_GROUPS, HOME_SECTIONS, latestLibraries, loadHomePreferences, moveSection, saveHomePreferences, type HomePreferences } from './discovery';
import { LiveThumb } from './live-guide';
import { t } from './i18n';

/** Favorites across every library, grouped by kind. */
const FAVORITES_PAGE_SIZE = 24;
const LIVE_TV_FAVORITES_ID = 'live-tv';
const FAVORITE_GROUP_COUNT = FAVORITE_GROUPS.length + 1;

type FavoriteRow = { id: string; title: string; items: MediaItem[]; total: number; loading?: boolean; error?: string };
type FavoriteFilter = 'all' | 'movies' | 'shows' | 'music' | 'live-tv' | 'more';
type RemovedFavorite = { item: MediaItem; groupId: string; index: number };
type FavoriteNotice = { kind: 'success' | 'error'; message: string; undo?: RemovedFavorite };

const FAVORITE_FILTERS: Array<{ id: FavoriteFilter; label: string }> = [
    { id: 'all', label: t('All') },
    { id: 'movies', label: t('Movies') },
    { id: 'shows', label: t('Shows') },
    { id: 'music', label: t('Music') },
    { id: 'live-tv', label: t('Live TV') },
    { id: 'more', label: t('More') }
];

const FAVORITE_FILTER_GROUPS: Record<Exclude<FavoriteFilter, 'all'>, readonly string[]> = {
    movies: [ 'movies' ],
    shows: [ 'shows', 'episodes' ],
    music: [ 'albums', 'songs', 'artists' ],
    'live-tv': [ LIVE_TV_FAVORITES_ID ],
    more: [ 'videos', 'collections', 'playlists', 'books', 'photos', 'people' ]
};

const FAVORITE_ROW_GROUPS = [ ...FAVORITE_GROUPS.map(({ id, title }) => ({ id, title })), { id: LIVE_TV_FAVORITES_ID, title: t('Live TV') } ];

async function loadFavoriteGroup(api: JellyfinApi, groupId: string, startIndex = 0): Promise<{ items: MediaItem[]; total: number }> {
    if (groupId === LIVE_TV_FAVORITES_ID) {
        const result = await api.getLiveChannels(startIndex, FAVORITES_PAGE_SIZE, 'favorites');
        const items = result.Items || [];
        return { items, total: result.TotalRecordCount ?? items.length };
    }
    const group = FAVORITE_GROUPS.find(entry => entry.id === groupId);
    if (!group) throw new Error('Unknown favorites group.');
    return api.getFavorites(group, FAVORITES_PAGE_SIZE, startIndex);
}

function matchesFavoriteFilter(filter: FavoriteFilter, groupId: string): boolean {
    return filter === 'all' || FAVORITE_FILTER_GROUPS[filter].includes(groupId);
}

export function FavoritesPage({ api, onSelect, onPlay, onBack, onBrowseChannels }: { api: JellyfinApi | null; onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void; onBack: () => void; onBrowseChannels: () => void }) {
    const [ rows, setRows ] = useState<FavoriteRow[] | null>(null);
    const [ failed, setFailed ] = useState(0);
    const [ attempt, setAttempt ] = useState(0);
    const [ activeFilter, setActiveFilter ] = useState<FavoriteFilter>('all');
    const [ favoriteBusy, setFavoriteBusy ] = useState(false);
    const [ favoriteNotice, setFavoriteNotice ] = useState<FavoriteNotice | null>(null);
    useEffect(() => {
        let active = true;
        setRows(null);
        setFailed(0);
        setFavoriteNotice(null);
        if (!api) return;
        let failures = 0;
        void Promise.all(FAVORITE_ROW_GROUPS.map(group => loadFavoriteGroup(api, group.id)
            .then(result => ({ id: group.id, title: group.title, ...result }))
            .catch(() => { failures += 1; return { id: group.id, title: group.title, items: [] as MediaItem[], total: 0 }; })))
            .then(next => { if (active) { setRows(next); setFailed(failures); } });
        return () => { active = false; };
    }, [ api, attempt ]);
    const updateRow = (id: string, change: (row: FavoriteRow) => FavoriteRow) => setRows(current => current && current.map(row => row.id === id ? change(row) : row));
    const showMore = (row: FavoriteRow) => {
        if (!api || row.loading) return;
        updateRow(row.id, current => ({ ...current, loading: true, error: '' }));
        void loadFavoriteGroup(api, row.id, row.items.length)
            .then(next => updateRow(row.id, current => ({ ...current, items: appendPage(current.items, next.items), total: next.items.length ? next.total : current.items.length, loading: false })))
            .catch(cause => updateRow(row.id, current => ({ ...current, loading: false, error: userMessage(cause) })));
    };
    const removeFavorite = (groupId: string, item: MediaItem) => {
        if (!api || favoriteBusy) return;
        const row = rows?.find(entry => entry.id === groupId);
        const index = row?.items.findIndex(entry => entry.Id === item.Id) ?? -1;
        if (index < 0) return;
        setFavoriteBusy(true);
        setFavoriteNotice({ kind: 'success', message: t('Removing {0} from favorites…', item.Name) });
        updateRow(groupId, current => ({ ...current, items: current.items.filter(entry => entry.Id !== item.Id), total: Math.max(0, current.total - 1) }));
        void api.setFavorite(item.Id, false)
            .then(() => setFavoriteNotice({ kind: 'success', message: t('Removed {0} from favorites.', item.Name), undo: { item, groupId, index } }))
            .catch(cause => {
                updateRow(groupId, current => {
                    if (current.items.some(entry => entry.Id === item.Id)) return current;
                    const items = [ ...current.items ];
                    items.splice(Math.min(index, items.length), 0, item);
                    return { ...current, items, total: current.total + 1 };
                });
                setFavoriteNotice({ kind: 'error', message: t('Could not remove favorite: {0}', userMessage(cause)) });
            })
            .finally(() => setFavoriteBusy(false));
    };
    const undoFavorite = () => {
        const removed = favoriteNotice?.undo;
        if (!api || !removed || favoriteBusy) return;
        setFavoriteBusy(true);
        setFavoriteNotice({ kind: 'success', message: t('Restoring {0} to favorites…', removed.item.Name) });
        void api.setFavorite(removed.item.Id, true)
            .then(() => {
                updateRow(removed.groupId, current => {
                    if (current.items.some(entry => entry.Id === removed.item.Id)) return current;
                    const items = [ ...current.items ];
                    items.splice(Math.min(removed.index, items.length), 0, removed.item);
                    return { ...current, items, total: current.total + 1 };
                });
                setFavoriteNotice({ kind: 'success', message: t('Added {0} to favorites.', removed.item.Name) });
            })
            .catch(cause => setFavoriteNotice({ kind: 'error', message: t('Could not restore favorite: {0}', userMessage(cause)), undo: removed }))
            .finally(() => setFavoriteBusy(false));
    };
    const availableRows = rows?.filter(row => row.items.length > 0) || [];
    const visibleRows = availableRows.filter(row => matchesFavoriteFilter(activeFilter, row.id));
    return <section class="catalog-page favorites-page">
        <div class="catalog-heading">
            <p class="eyebrow">{t('YOUR COLLECTION')}</p>
            <h1>{t('Favorites')}</h1>
            {availableRows.length > 0 && <p class="muted">{availableRows.map(row => `${row.total} ${row.title.toLowerCase()}`).join(' · ')}</p>}
        </div>
        {failed > 0 && <div class="home-section-error" role="alert"><p>{failed === FAVORITE_GROUP_COUNT ? t('Favorites could not load.') : t('Some favorite groups could not load.')}</p><button class="button secondary" data-focusable="true" type="button" onClick={() => setAttempt(value => value + 1)}>{t('Retry')}</button></div>}
        {!rows && <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />{t('Loading favorites…')}</div>}
        {rows && <div class="favorites-filters" role="group" aria-label={t('Favorite categories')}>
            {FAVORITE_FILTERS.map(filter => {
                const selected = activeFilter === filter.id;
                const select = () => setActiveFilter(filter.id);
                return <button class={selected ? 'active' : ''} data-focusable="true" type="button" aria-pressed={selected} key={filter.id} onClick={select}>{filter.label}</button>;
            })}
        </div>}
        {favoriteNotice && <div class={favoriteNotice.kind === 'error' ? 'favorites-notice error' : 'favorites-notice'} role={favoriteNotice.kind === 'error' ? 'alert' : 'status'}>
            <span>{favoriteNotice.message}</span>
            {favoriteNotice.undo && <button class="button secondary" data-focusable="true" type="button" disabled={favoriteBusy} onClick={undoFavorite}>{t('Undo')}</button>}
        </div>}
        {rows && !visibleRows.length && failed === 0 && <div class="empty-state"><span aria-hidden="true">☆</span>
            <h2>{activeFilter === 'live-tv' ? t('No favorite channels yet') : activeFilter === 'all' ? t('No favorites yet') : t('No favorites in this category yet')}</h2>
            <p>{activeFilter === 'live-tv' ? t('Favorite a channel in Live TV to keep it here.') : t('Use the star on a title, person, artist or channel to keep it here.')}</p>
            {activeFilter === 'live-tv' && <button class="button secondary" data-focusable="true" type="button" onClick={onBrowseChannels}>{t('Browse channels')}</button>}
        </div>}
        {visibleRows.map(row => {
            const title = row.total > row.items.length ? t('{0} ({1} of {2})', row.title, row.items.length, row.total) : row.title;
            const remove = (item: MediaItem) => removeFavorite(row.id, item);
            return <div key={row.id} class="favorites-group">
                {row.id === LIVE_TV_FAVORITES_ID
                    ? <FavoriteChannelsRow api={api} title={title} items={row.items} onPlay={onPlay} onRemoveFavorite={remove} busy={favoriteBusy} />
                    : <MediaRow api={api} title={title} items={row.items} onOpen={onSelect} onPlay={onPlay} onRemoveFavorite={remove} favoriteBusy={favoriteBusy} />}
                {hasMoreResults(row.items.length, row.total) && <div class="load-more">
                    {row.error && <p class="notice error" role="alert">{t('More {0} could not load: {1}', row.title.toLowerCase(), row.error)}</p>}
                    <button class="button secondary" data-focusable="true" type="button" disabled={row.loading} onClick={() => showMore(row)}>{row.error ? t('Retry') : t('Show more ({0} remaining)', (row.total - row.items.length).toLocaleString())}</button>
                </div>}
            </div>;
        })}
    </section>;
}

function FavoriteChannelsRow({ api, title, items, onPlay, onRemoveFavorite, busy }: { api: JellyfinApi | null; title: string; items: MediaItem[]; onPlay: (item: MediaItem) => void; onRemoveFavorite: (item: MediaItem) => void; busy: boolean }) {
    if (!items.length) return null;
    return <section class="favorites-live-section" aria-label={title}>
        <h2>{title}</h2>
        <ul class="favorites-live-channels">
            {items.map(channel => {
                const watchLabel = t('Watch {0}', channel.Name);
                const favoriteLabel = t('Remove {0} from favorites', channel.Name);
                const watch = () => onPlay(channel);
                const remove = () => onRemoveFavorite(channel);
                return <li class="favorites-live-channel" key={channel.Id}>
                    <button class="favorites-live-channel-main" data-focusable="true" type="button" aria-label={watchLabel} onClick={watch}>
                        <span class="live-number">{channel.ChannelNumber || '—'}</span>
                        <span class="live-logo">{api ? <LiveThumb api={api} item={channel} width={96} /> : <span class="live-logo-fallback" aria-hidden="true" />}</span>
                        <span class="favorites-live-channel-copy">
                            <strong>{channel.Name}</strong>
                            <span class="muted">{channel.CurrentProgram?.Name || t('No program data available')}</span>
                        </span>
                    </button>
                    <button class="live-star on favorites-live-channel-star" data-focusable="true" type="button" aria-pressed="true" aria-label={favoriteLabel} title={favoriteLabel} disabled={busy} onClick={remove}>★</button>
                </li>;
            })}
        </ul>
    </section>;
}

/** People, artists, genres and studios that match the search term, above the title results. */
export function EntitySearchRows({ api, term, onSelect }: { api: JellyfinApi | null; term: string; onSelect: (item: MediaItem) => void }) {
    const [ sections, setSections ] = useState<Array<{ id: string; title: string; items: MediaItem[] }>>([]);
    const query = term.trim();
    useEffect(() => {
        setSections([]);
        if (!api || query.length < 2) return;
        let active = true;
        const timer = window.setTimeout(() => {
            void Promise.all(ENTITY_SEARCH_SECTIONS.map(section => api.searchEntities(section, query).then(items => ({ id: section.id, title: section.title, items })).catch(() => ({ id: section.id, title: section.title, items: [] as MediaItem[] }))))
                .then(next => { if (active) setSections(next.filter(section => section.items.length > 0)); });
        }, 250);
        return () => { active = false; window.clearTimeout(timer); };
    }, [ api, query ]);
    if (!sections.length) return null;
    return <div class="entity-search-rows" aria-label={t('Matching people, artists, genres and studios')}>
        {sections.map(section => <MediaRow key={section.id} api={api} title={section.title} items={section.items} onOpen={onSelect} />)}
    </div>;
}

/** Order, visibility and Latest-library exclusions for the home feed. */
export function HomeSectionsEditor({ api, userId }: { api: JellyfinApi; userId: string }) {
    const [ preferences, setPreferences ] = useState<HomePreferences>(() => loadHomePreferences(userId));
    const [ libraries, setLibraries ] = useState<MediaItem[]>([]);
    useEffect(() => { setPreferences(loadHomePreferences(userId)); }, [ userId ]);
    useEffect(() => {
        let active = true;
        void api.getViews().then(views => { if (active) setLibraries(latestLibraries(views, [])); }).catch(() => undefined);
        return () => { active = false; };
    }, [ api ]);
    const update = (next: HomePreferences) => { setPreferences(next); saveHomePreferences(userId, next); };
    const label = (id: string) => HOME_SECTIONS.find(section => section.id === id)?.label || id;
    return <section class="profile-form home-sections-editor" aria-labelledby="home-sections-title">
        <h2 id="home-sections-title">{t('Home screen on this device')}</h2>
        <p>{t('Choose which rows appear on Home and in what order. Rows without content stay hidden.')}</p>
        <ol class="home-section-list">
            {preferences.order.map((id, index) => {
                const shown = !preferences.hidden.includes(id);
                return <li key={id} class={shown ? '' : 'hidden-section'}>
                    <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={shown} onChange={event => update({ ...preferences, hidden: (event.currentTarget as HTMLInputElement).checked ? preferences.hidden.filter(entry => entry !== id) : [ ...preferences.hidden, id ] })} /> {label(id)}</label>
                    <span class="home-section-move">
                        <button class="button secondary" data-focusable="true" type="button" aria-label={t('Move {0} up', label(id))} disabled={index === 0} onClick={() => update({ ...preferences, order: moveSection(preferences.order, id, -1) })}>↑</button>
                        <button class="button secondary" data-focusable="true" type="button" aria-label={t('Move {0} down', label(id))} disabled={index === preferences.order.length - 1} onClick={() => update({ ...preferences, order: moveSection(preferences.order, id, 1) })}>↓</button>
                    </span>
                </li>;
            })}
        </ol>
        {libraries.length > 0 && <fieldset class="home-latest-libraries">
            <legend>{t('Latest per library')}</legend>
            {libraries.map(library => <label key={library.Id} class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={!preferences.excludedLatest.includes(library.Id)} onChange={event => update({ ...preferences, excludedLatest: (event.currentTarget as HTMLInputElement).checked ? preferences.excludedLatest.filter(id => id !== library.Id) : [ ...preferences.excludedLatest, library.Id ] })} /> {library.Name}</label>)}
        </fieldset>}
    </section>;
}
