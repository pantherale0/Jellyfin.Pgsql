import { useEffect, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import type { MediaItem } from './types';
import { userMessage } from './ui-errors';
import { MediaRow } from './detail-sections';
import { appendPage, hasMoreResults } from './catalog-model';
import { ENTITY_SEARCH_SECTIONS, FAVORITE_GROUPS, HOME_SECTIONS, latestLibraries, loadHomePreferences, moveSection, saveHomePreferences, type HomePreferences } from './discovery';
import { t } from './i18n';

/** Favorites across every library, grouped by kind. */
const FAVORITES_PAGE_SIZE = 24;

type FavoriteRow = { id: string; title: string; items: MediaItem[]; total: number; loading?: boolean; error?: string };

export function FavoritesPage({ api, onSelect, onPlay, onBack }: { api: JellyfinApi | null; onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void; onBack: () => void }) {
    const [ rows, setRows ] = useState<FavoriteRow[] | null>(null);
    const [ failed, setFailed ] = useState(0);
    const [ attempt, setAttempt ] = useState(0);
    useEffect(() => {
        let active = true;
        setRows(null);
        setFailed(0);
        if (!api) return;
        let failures = 0;
        void Promise.all(FAVORITE_GROUPS.map(group => api.getFavorites(group, FAVORITES_PAGE_SIZE).then(result => ({ id: group.id, title: group.title, ...result })).catch(() => { failures += 1; return { id: group.id, title: group.title, items: [] as MediaItem[], total: 0 }; })))
            .then(next => { if (active) { setRows(next.filter(row => row.items.length > 0)); setFailed(failures); } });
        return () => { active = false; };
    }, [ api, attempt ]);
    const updateRow = (id: string, change: (row: FavoriteRow) => FavoriteRow) => setRows(current => current && current.map(row => row.id === id ? change(row) : row));
    const showMore = (row: FavoriteRow) => {
        const group = FAVORITE_GROUPS.find(entry => entry.id === row.id);
        if (!api || !group || row.loading) return;
        updateRow(row.id, current => ({ ...current, loading: true, error: '' }));
        void api.getFavorites(group, FAVORITES_PAGE_SIZE, row.items.length)
            .then(next => updateRow(row.id, current => ({ ...current, items: appendPage(current.items, next.items), total: next.items.length ? next.total : current.items.length, loading: false })))
            .catch(cause => updateRow(row.id, current => ({ ...current, loading: false, error: userMessage(cause) })));
    };
    return <section class="catalog-page favorites-page">
        <div class="catalog-heading">
            <button class="back-link" data-focusable="true" type="button" onClick={onBack}><span class="dir-arrow" aria-hidden="true">←</span> <span>{t('Home')}</span></button>
            <p class="eyebrow">{t('YOUR COLLECTION')}</p>
            <h1>{t('Favorites')}</h1>
            {rows && <p class="muted">{rows.length ? rows.map(row => `${row.total} ${row.title.toLowerCase()}`).join(' · ') : ''}</p>}
        </div>
        {failed > 0 && <div class="home-section-error" role="alert"><p>{failed === FAVORITE_GROUPS.length ? t('Favorites could not load.') : t('Some favorite groups could not load.')}</p><button class="button secondary" data-focusable="true" type="button" onClick={() => setAttempt(value => value + 1)}>{t('Retry')}</button></div>}
        {!rows && <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />{t('Loading favorites…')}</div>}
        {rows && !rows.length && failed < FAVORITE_GROUPS.length && <div class="empty-state"><span aria-hidden="true">☆</span><h2>{t('No favorites yet')}</h2><p>{t('Use the star on any title, person or artist to keep it here.')}</p></div>}
        {rows?.map(row => <div key={row.id} class="favorites-group">
            <MediaRow api={api} title={row.total > row.items.length ? t('{0} ({1} of {2})', row.title, row.items.length, row.total) : row.title} items={row.items} onOpen={onSelect} onPlay={onPlay} />
            {hasMoreResults(row.items.length, row.total) && <div class="load-more">
                {row.error && <p class="notice error" role="alert">{t('More {0} could not load: {1}', row.title.toLowerCase(), row.error)}</p>}
                <button class="button secondary" data-focusable="true" type="button" disabled={row.loading} onClick={() => showMore(row)}>{row.error ? t('Retry') : t('Show more ({0} remaining)', (row.total - row.items.length).toLocaleString())}</button>
            </div>}
        </div>)}
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
