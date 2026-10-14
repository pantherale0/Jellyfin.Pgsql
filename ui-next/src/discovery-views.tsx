import { useEffect, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import type { MediaItem } from './types';
import { userMessage } from './ui-errors';
import { MediaRow } from './detail-sections';
import { ENTITY_SEARCH_SECTIONS, FAVORITE_GROUPS, HOME_SECTIONS, latestLibraries, loadHomePreferences, moveSection, saveHomePreferences, type HomePreferences } from './discovery';

/** Favorites across every library, grouped by kind. */
export function FavoritesPage({ api, onSelect, onPlay, onBack }: { api: JellyfinApi | null; onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void; onBack: () => void }) {
    const [ rows, setRows ] = useState<Array<{ id: string; title: string; items: MediaItem[]; total: number }> | null>(null);
    const [ failed, setFailed ] = useState(0);
    const [ attempt, setAttempt ] = useState(0);
    useEffect(() => {
        let active = true;
        setRows(null);
        setFailed(0);
        if (!api) return;
        let failures = 0;
        void Promise.all(FAVORITE_GROUPS.map(group => api.getFavorites(group).then(result => ({ id: group.id, title: group.title, ...result })).catch(() => { failures += 1; return { id: group.id, title: group.title, items: [] as MediaItem[], total: 0 }; })))
            .then(next => { if (active) { setRows(next.filter(row => row.items.length > 0)); setFailed(failures); } });
        return () => { active = false; };
    }, [ api, attempt ]);
    return <section class="catalog-page favorites-page">
        <div class="catalog-heading">
            <button class="back-link" data-focusable="true" type="button" onClick={onBack}>← <span>Home</span></button>
            <p class="eyebrow">YOUR COLLECTION</p>
            <h1>Favorites</h1>
            {rows && <p class="muted">{rows.length ? rows.map(row => `${row.total} ${row.title.toLowerCase()}`).join(' · ') : ''}</p>}
        </div>
        {failed > 0 && <div class="home-section-error" role="alert"><p>{failed === FAVORITE_GROUPS.length ? 'Favorites could not load.' : 'Some favorite groups could not load.'}</p><button class="button secondary" data-focusable="true" type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
        {!rows && <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />Loading favorites…</div>}
        {rows && !rows.length && failed < FAVORITE_GROUPS.length && <div class="empty-state"><span aria-hidden="true">☆</span><h2>No favorites yet</h2><p>Use the star on any title, person or artist to keep it here.</p></div>}
        {rows?.map(row => <MediaRow key={row.id} api={api} title={row.total > row.items.length ? `${row.title} (${row.items.length} of ${row.total})` : row.title} items={row.items} onOpen={onSelect} onPlay={onPlay} />)}
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
    return <div class="entity-search-rows" aria-label="Matching people, artists, genres and studios">
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
        <h2 id="home-sections-title">Home screen on this device</h2>
        <p>Choose which rows appear on Home and in what order. Rows without content stay hidden.</p>
        <ol class="home-section-list">
            {preferences.order.map((id, index) => {
                const shown = !preferences.hidden.includes(id);
                return <li key={id} class={shown ? '' : 'hidden-section'}>
                    <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={shown} onChange={event => update({ ...preferences, hidden: (event.currentTarget as HTMLInputElement).checked ? preferences.hidden.filter(entry => entry !== id) : [ ...preferences.hidden, id ] })} /> {label(id)}</label>
                    <span class="home-section-move">
                        <button class="button secondary" data-focusable="true" type="button" aria-label={`Move ${label(id)} up`} disabled={index === 0} onClick={() => update({ ...preferences, order: moveSection(preferences.order, id, -1) })}>↑</button>
                        <button class="button secondary" data-focusable="true" type="button" aria-label={`Move ${label(id)} down`} disabled={index === preferences.order.length - 1} onClick={() => update({ ...preferences, order: moveSection(preferences.order, id, 1) })}>↓</button>
                    </span>
                </li>;
            })}
        </ol>
        {libraries.length > 0 && <fieldset class="home-latest-libraries">
            <legend>Latest per library</legend>
            {libraries.map(library => <label key={library.Id} class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={!preferences.excludedLatest.includes(library.Id)} onChange={event => update({ ...preferences, excludedLatest: (event.currentTarget as HTMLInputElement).checked ? preferences.excludedLatest.filter(id => id !== library.Id) : [ ...preferences.excludedLatest, library.Id ] })} /> {library.Name}</label>)}
        </fieldset>}
    </section>;
}
