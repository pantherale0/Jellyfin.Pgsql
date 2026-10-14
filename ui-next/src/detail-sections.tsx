import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import type { JellyfinUser, MediaItem } from './types';
import { useDialogFocus } from './dialog-focus';
import { userMessage } from './ui-errors';
import { canManageCollections, childView, detailFacts, discGroups, extrasSections, itemActions, linkedMetadata, shareLink, withoutItem, wrapIndex } from './detail-model';
import { itemCapabilities, playedUserData } from './catalog-model';
import { createQueue, playQueue, queueable } from './play-queue';

const minutes = (ticks?: number) => ticks ? `${Math.max(1, Math.round(ticks / 600_000_000))} min` : '';
const clock = (ticks?: number) => {
    if (!ticks) return '';
    const total = Math.round(ticks / 10_000_000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function DetailFactsView({ item }: { item: MediaItem }) {
    const facts = detailFacts(item);
    const technical = [ facts.video, facts.container, facts.bitrate, facts.size ].filter(Boolean);
    return <>
        {facts.tagline && <p class="detail-tagline">{facts.tagline}</p>}
        {(facts.officialRating || facts.criticRating !== undefined) && <div class="detail-badges">
            {facts.officialRating && <span class="detail-badge" aria-label={`Rated ${facts.officialRating}`}>{facts.officialRating}</span>}
            {facts.criticRating !== undefined && <span class="detail-badge" aria-label={`Critics ${facts.criticRating}%`}>{facts.criticRating >= 60 ? '🍅' : '🥀'} {facts.criticRating}%</span>}
        </div>}
        {(technical.length > 0 || facts.audio.length > 0 || facts.subtitles.length > 0) && <dl class="detail-tech">
            {technical.length > 0 && <><dt>Video</dt><dd>{technical.join(' · ')}</dd></>}
            {facts.audio.length > 0 && <><dt>Audio</dt><dd>{facts.audio.join(', ')}</dd></>}
            {facts.subtitles.length > 0 && <><dt>Subtitles</dt><dd>{facts.subtitles.join(', ')}</dd></>}
        </dl>}
        {facts.links.length > 0 && <p class="detail-links">{facts.links.map(link => <a key={link.url} data-focusable="true" href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>)}</p>}
    </>;
}

export function LinkedMetadataView({ api, item, onOpen }: { api: JellyfinApi | null; item: MediaItem; onOpen: (item: MediaItem) => void }) {
    const linked = linkedMetadata(item);
    const chips = (title: string, entries: MediaItem[], detail?: (entry: MediaItem) => string) => entries.length > 0 && <div class="detail-chip-group">
        <h3>{title}</h3>
        <div class="detail-chips">{entries.map(entry => <button key={`${title}-${entry.Id}`} data-focusable="true" class="detail-chip" type="button" onClick={() => onOpen(entry)}>{entry.Name}{detail && detail(entry) ? <small>{detail(entry)}</small> : null}</button>)}</div>
    </div>;
    if (!linked.cast.length && !linked.crew.length && !linked.genres.length && !linked.studios.length && !linked.tags.length && !linked.artists.length && !linked.albums.length) return null;
    return <section class="detail-linked" aria-label="Cast, crew and categories">
        {linked.cast.length > 0 && <div class="detail-chip-group">
            <h3>Cast</h3>
            <div class="detail-cast">{linked.cast.map(person => <button key={person.Id} data-focusable="true" class="detail-person" type="button" onClick={() => onOpen(person)}>
                {api && person.ImageTags?.Primary ? <img src={api.imageUrl(person, 'Primary', 160)} alt="" loading="lazy" /> : <span class="detail-person-initial" aria-hidden="true">{person.Name.slice(0, 1)}</span>}
                <strong>{person.Name}</strong>{person.Overview && <small>{person.Overview}</small>}
            </button>)}</div>
        </div>}
        {chips('Crew', linked.crew, entry => (entry as MediaItem & { role?: string }).role || '')}
        {chips('Artists', linked.artists)}
        {chips('Album', linked.albums)}
        {chips('Genres', linked.genres)}
        {chips('Studios', linked.studios)}
        {chips('Tags', linked.tags)}
    </section>;
}

function useLoaded<T>(load: (() => Promise<T>) | null, key: unknown[], initial: T): { value: T; loading: boolean; error: string; reload: () => void; set: (value: T) => void } {
    const [ value, setValue ] = useState<T>(initial);
    const [ loading, setLoading ] = useState(false);
    const [ error, setError ] = useState('');
    const [ attempt, setAttempt ] = useState(0);
    useEffect(() => {
        setValue(initial);
        setError('');
        if (!load) return;
        let active = true;
        setLoading(true);
        void load().then(next => { if (active) setValue(next); })
            .catch(cause => { if (active) setError(userMessage(cause)); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [ ...key, attempt ]);
    return { value, loading, error, reload: () => setAttempt(current => current + 1), set: setValue };
}

export function MediaRow({ api, title, items, onOpen, onPlay }: { api: JellyfinApi | null; title: string; items: MediaItem[]; onOpen: (item: MediaItem) => void; onPlay?: (item: MediaItem) => void }) {
    if (!items.length) return null;
    return <section class="detail-row" aria-label={title}>
        <h2>{title}</h2>
        <div class="detail-row-items">{items.map(entry => <div class="detail-card" key={entry.PlaylistItemId || entry.Id}>
            <button data-focusable="true" type="button" class="detail-card-open" onClick={() => (onPlay && itemCapabilities(entry).playable ? onPlay(entry) : onOpen(entry))} aria-label={onPlay && itemCapabilities(entry).playable ? `Play ${entry.Name}` : `Open ${entry.Name}`}>
                <span class="detail-card-art">{api && api.imageUrl(entry, 'Primary', 300) ? <img src={api.imageUrl(entry, 'Primary', 300)} alt="" loading="lazy" /> : <span aria-hidden="true">{entry.Name.slice(0, 1)}</span>}</span>
                <strong>{entry.Name}</strong>
                <small>{[ entry.ProductionYear, minutes(entry.RunTimeTicks) ].filter(Boolean).join(' · ')}</small>
            </button>
        </div>)}</div>
    </section>;
}

/** Similar titles and the collections this item belongs to. */
export function RelatedRows({ api, item, onOpen }: { api: JellyfinApi | null; item: MediaItem; onOpen: (item: MediaItem) => void }) {
    const similarTypes = [ 'Movie', 'Series', 'Trailer', 'MusicAlbum', 'MusicArtist', 'Audio', 'Program', 'Recording', 'Playlist' ];
    const similar = useLoaded(api && similarTypes.includes(item.Type || '') ? () => api.getSimilarItems(item.Id) : null, [ api, item.Id ], [] as MediaItem[]);
    const collections = useLoaded(api && [ 'Movie', 'Series', 'Video', 'MusicVideo', 'MusicAlbum', 'Book' ].includes(item.Type || '') ? () => api.getItemCollections(item.Id) : null, [ api, item.Id ], [] as MediaItem[]);
    return <>
        <MediaRow api={api} title="Part of collections" items={collections.value} onOpen={onOpen} />
        <MediaRow api={api} title="More like this" items={similar.value} onOpen={onOpen} />
    </>;
}

/** Trailers, special features and additional parts (multi-file videos). */
export function DetailExtras({ api, item, onOpen, onPlay }: { api: JellyfinApi | null; item: MediaItem; onOpen: (item: MediaItem) => void; onPlay: (item: MediaItem) => void }) {
    const wants = api && [ 'Movie', 'Series', 'Episode', 'Video', 'MusicVideo', 'Season' ].includes(item.Type || '');
    const extras = useLoaded(wants ? async () => {
        const [ trailers, features, parts ] = await Promise.all([
            item.LocalTrailerCount ? api.getLocalTrailers(item.Id).catch(() => []) : Promise.resolve([]),
            item.SpecialFeatureCount ? api.getSpecialFeatures(item.Id).catch(() => []) : Promise.resolve([]),
            (item.PartCount || 0) > 1 ? api.getAdditionalParts(item.Id).catch(() => []) : Promise.resolve([]),
        ]);
        return extrasSections(trailers, features, parts);
    } : null, [ api, item.Id, item.LocalTrailerCount, item.SpecialFeatureCount, item.PartCount ], [] as Array<{ title: string; items: MediaItem[] }>);
    return <>{extras.value.map(section => <MediaRow key={section.title} api={api} title={section.title} items={section.items} onOpen={onOpen} onPlay={onPlay} />)}</>;
}

export function PhotoViewer({ api, photos, start, onClose }: { api: JellyfinApi; photos: MediaItem[]; start: number; onClose: () => void }) {
    const [ index, setIndex ] = useState(start);
    const [ playing, setPlaying ] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useDialogFocus(ref, true, onClose, { initial: 'button' });
    useEffect(() => {
        if (!playing || photos.length < 2) return;
        const timer = window.setInterval(() => setIndex(current => wrapIndex(current, photos.length, 1)), 5000);
        return () => window.clearInterval(timer);
    }, [ playing, photos.length ]);
    const photo = photos[index];
    if (!photo) return null;
    const step = (direction: 1 | -1) => setIndex(current => wrapIndex(current, photos.length, direction));
    return <div ref={ref} class="photo-viewer" role="dialog" aria-modal="true" aria-label={`Photo ${index + 1} of ${photos.length}`} onKeyDown={event => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    }}>
        <img class="photo-viewer-image" src={api.imageUrl(photo, 'Primary', 2400, 92)} alt={photo.Name} />
        <div class="photo-viewer-bar">
            <span>{photo.Name} · {index + 1} / {photos.length}</span>
            {photos.length > 1 && <>
                <button data-focusable="true" class="button secondary" type="button" onClick={() => step(-1)} aria-label="Previous photo">‹</button>
                <button data-focusable="true" class="button secondary" type="button" aria-pressed={playing} onClick={() => setPlaying(value => !value)}>{playing ? 'Pause slideshow' : 'Slideshow'}</button>
                <button data-focusable="true" class="button secondary" type="button" onClick={() => step(1)} aria-label="Next photo">›</button>
            </>}
            <button data-focusable="true" class="button secondary" type="button" onClick={onClose}>Close</button>
        </div>
    </div>;
}

/** Album tracks, playlist entries, photo-album photos and collection members. */
export function DetailChildren({ api, item, user, onOpen, onPlay }: { api: JellyfinApi | null; item: MediaItem; user: JellyfinUser; onOpen: (item: MediaItem) => void; onPlay: (item: MediaItem) => void }) {
    const kind = childView(item);
    const children = useLoaded(api && kind ? () => (kind === 'playlist' ? api.getPlaylistEntries(item.Id) : api.getChildren(item.Id, kind === 'photos' ? 'SortName' : kind === 'members' ? 'ProductionYear,SortName' : undefined)) : null, [ api, item.Id, kind ], [] as MediaItem[]);
    const [ viewer, setViewer ] = useState<number | null>(null);
    const [ busy, setBusy ] = useState('');
    const [ error, setError ] = useState('');
    const manage = kind === 'members' && canManageCollections(user);
    if (!kind) return null;
    if (children.loading && !children.value.length) return <p class="muted" role="status">Loading contents…</p>;
    if (children.error) return <p class="notice error" role="alert">Contents could not load: {children.error} <button data-focusable="true" class="button secondary" type="button" onClick={children.reload}>Retry</button></p>;
    if (!children.value.length) return <p class="muted">{kind === 'playlist' ? 'This playlist is empty.' : kind === 'photos' ? 'This album has no photos.' : 'Nothing here yet.'}</p>;
    if (kind === 'tracks') return <section class="detail-tracks" aria-label="Tracks">
        {discGroups(children.value).map(group => <div key={group.disc ?? 'all'}>
            {group.disc !== null && <h3>Disc {group.disc}</h3>}
            <ol class="track-list">{group.tracks.map(track => <li key={track.Id}><button data-focusable="true" type="button" class="track-row" onClick={() => onOpen(track)}>
                <span class="track-number">{track.IndexNumber ?? ''}</span>
                <span class="track-name">{track.Name}{track.ArtistItems?.length && track.ArtistItems.map(artist => artist.Name).join(', ') !== item.AlbumArtists?.map(artist => artist.Name).join(', ') ? <small>{track.ArtistItems.map(artist => artist.Name).join(', ')}</small> : null}</span>
                <span class="track-duration">{clock(track.RunTimeTicks)}</span>
            </button></li>)}</ol>
        </div>)}
        <p class="muted">Audio playback is not available in UI Next yet; open a track for its details and lyrics.</p>
    </section>;
    if (kind === 'photos') {
        const photos = children.value.filter(child => child.Type === 'Photo');
        const folders = children.value.filter(child => child.Type !== 'Photo');
        return <section class="detail-photos" aria-label="Photos">
            {photos.length > 0 && <button data-focusable="true" class="button primary" type="button" onClick={() => setViewer(0)}>▶ Slideshow</button>}
            <div class="photo-grid">
                {folders.map(folder => <button key={folder.Id} data-focusable="true" class="photo-tile folder" type="button" onClick={() => onOpen(folder)}><span>{folder.Name}</span></button>)}
                {photos.map((photo, position) => <button key={photo.Id} data-focusable="true" class="photo-tile" type="button" aria-label={`View ${photo.Name}`} onClick={() => setViewer(position)}>{api && <img src={api.imageUrl(photo, 'Primary', 360)} alt="" loading="lazy" />}</button>)}
            </div>
            {viewer !== null && api && <PhotoViewer api={api} photos={photos} start={viewer} onClose={() => setViewer(null)} />}
        </section>;
    }
    const remove = async (member: MediaItem) => {
        if (!api) return;
        setBusy(member.Id);
        setError('');
        try {
            await api.removeFromCollection(item.Id, [ member.Id ]);
            children.set(withoutItem(children.value, member.Id));
        } catch (cause) {
            setError(userMessage(cause));
        } finally {
            setBusy('');
        }
    };
    const queued = children.value.filter(queueable);
    const playFrom = (start: MediaItem | null, shuffle = false) => {
        const started = createQueue(queued, start ? queued.indexOf(start) : shuffle ? -1 : 0, { shuffle });
        if (!started) return;
        playQueue.set(started.queue);
        onPlay(started.item);
    };
    return <section class="detail-entries" aria-label={kind === 'playlist' ? 'Playlist entries' : 'Collection members'}>
        {error && <p class="notice error" role="alert">{error}</p>}
        {queued.length > 1 && <div class="detail-queue-actions">
            <button data-focusable="true" class="button primary" type="button" onClick={() => playFrom(null)}>▶ Play all</button>
            <button data-focusable="true" class="button secondary" type="button" onClick={() => playFrom(null, true)}>⤮ Shuffle</button>
        </div>}
        <ol class="entry-list">{children.value.map((entry, position) => <li key={entry.PlaylistItemId || entry.Id} class="entry-row">
            <span class="track-number">{position + 1}</span>
            <button data-focusable="true" type="button" class="entry-open" onClick={() => onOpen(entry)}>
                {api && api.imageUrl(entry, 'Primary', 120) ? <img src={api.imageUrl(entry, 'Primary', 120)} alt="" loading="lazy" /> : <span class="entry-art" aria-hidden="true" />}
                <span><strong>{entry.SeriesName ? `${entry.SeriesName} · ${entry.Name}` : entry.Name}</strong><small>{[ entry.Type, entry.ProductionYear, minutes(entry.RunTimeTicks) ].filter(Boolean).join(' · ')}</small></span>
            </button>
            {itemCapabilities(entry).playable && <button data-focusable="true" class="button secondary" type="button" aria-label={`Play ${entry.Name}`} onClick={() => (queueable(entry) && queued.length > 1 ? playFrom(entry) : onPlay(entry))}>▶</button>}
            {manage && <button data-focusable="true" class="button secondary" type="button" disabled={busy === entry.Id} onClick={() => void remove(entry)}>Remove</button>}
        </li>)}</ol>
    </section>;
}

export function LyricsView({ api, item }: { api: JellyfinApi | null; item: MediaItem }) {
    const lyrics = useLoaded(api && item.Type === 'Audio' ? () => api.getLyrics(item.Id).catch(() => []) : null, [ api, item.Id ], [] as Array<{ Text?: string }>);
    if (!lyrics.value.length) return null;
    return <section class="detail-lyrics" aria-label="Lyrics"><h2>Lyrics</h2>{lyrics.value.map((line, index) => <p key={index}>{line.Text || '\u00a0'}</p>)}</section>;
}

/** Download, share, collection and delete actions, offered only when the server and policy allow them. */
export function ItemActionsBar({ api, item, user, serverId, onDeleted }: { api: JellyfinApi | null; item: MediaItem; user: JellyfinUser; serverId: string; onDeleted: (item: MediaItem) => void }) {
    const actions = itemActions(item, user);
    const [ message, setMessage ] = useState('');
    const [ error, setError ] = useState('');
    const [ confirmDelete, setConfirmDelete ] = useState(false);
    const [ picker, setPicker ] = useState(false);
    const [ busy, setBusy ] = useState(false);
    if (!api) return null;
    const run = async (work: () => Promise<string | void>) => {
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const done = await work();
            if (done) setMessage(done);
        } catch (cause) {
            setError(userMessage(cause));
        } finally {
            setBusy(false);
        }
    };
    const share = () => run(async () => {
        const url = shareLink(api.session.server, item, serverId);
        const nav = navigator as Navigator & { share?: (data: { title?: string; url?: string }) => Promise<void> };
        if (typeof nav.share === 'function') {
            await nav.share({ title: item.Name, url }).catch(() => undefined);
            return;
        }
        await navigator.clipboard.writeText(url);
        return 'Link copied. It opens this title for anyone signed in to this server.';
    });
    return <>
        <div class="detail-actions detail-actions-secondary">
            {actions.download && <a data-focusable="true" class="button secondary" href={api.downloadUrl(item.Id)} download>⤓ Download</a>}
            {actions.share && <button data-focusable="true" class="button secondary" type="button" disabled={busy} onClick={() => void share()}>Share</button>}
            {actions.collection && <button data-focusable="true" class="button secondary" type="button" aria-expanded={picker} onClick={() => setPicker(open => !open)}>Add to collection</button>}
            {actions.remove && (confirmDelete
                ? <><button data-focusable="true" class="button danger" type="button" disabled={busy} onClick={() => void run(async () => { await api.deleteItem(item.Id); onDeleted(item); })}>Delete from server</button><button data-focusable="true" class="button secondary" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button></>
                : <button data-focusable="true" class="button secondary" type="button" onClick={() => setConfirmDelete(true)}>Delete…</button>)}
        </div>
        {confirmDelete && <p class="notice error" role="alert">This permanently deletes “{item.Name}” and its files from the server for everyone.</p>}
        {picker && <CollectionPicker api={api} itemIds={[ item.Id ]} onDone={text => { setPicker(false); setMessage(text); }} />}
        {message && <p class="notice success" role="status">{message}</p>}
        {error && <p class="notice error" role="alert">{error}</p>}
    </>;
}

export function CollectionPicker({ api, itemIds, onDone }: { api: JellyfinApi; itemIds: string[]; onDone: (message: string) => void }) {
    const what = itemIds.length === 1 ? 'this title' : `${itemIds.length} titles`;
    const collections = useLoaded(() => api.getCollections(), [ api ], [] as MediaItem[]);
    const [ name, setName ] = useState('');
    const [ error, setError ] = useState('');
    const [ busy, setBusy ] = useState(false);
    const act = async (work: () => Promise<string>) => {
        setBusy(true);
        setError('');
        try { onDone(await work()); } catch (cause) { setError(userMessage(cause)); } finally { setBusy(false); }
    };
    return <section class="collection-picker" aria-label="Add to collection">
        {collections.loading && <p class="muted" role="status">Loading collections…</p>}
        {collections.value.length > 0 && <div class="detail-chips">{collections.value.map(collection => <button key={collection.Id} data-focusable="true" class="detail-chip" type="button" disabled={busy} onClick={() => void act(async () => { await api.addToCollection(collection.Id, itemIds); return `Added ${what} to ${collection.Name}.`; })}>{collection.Name}</button>)}</div>}
        <form class="collection-new" onSubmit={event => { event.preventDefault(); const trimmed = name.trim(); if (!trimmed) { setError('Enter a collection name.'); return; } void act(async () => { await api.createCollection(trimmed, itemIds); return `Created ${trimmed} with ${what}.`; }); }}>
            <label>New collection<input data-focusable="true" value={name} maxLength={200} onInput={event => setName((event.currentTarget as HTMLInputElement).value)} /></label>
            <button data-focusable="true" class="button secondary" type="submit" disabled={busy}>Create</button>
        </form>
        {error && <p class="notice error" role="alert">{error}</p>}
    </section>;
}

/** Favorite and watched toggles for any item the server tracks user data for (series and seasons included). */
export function UserDataActions({ api, item, label, onUserData }: { api: JellyfinApi | null; item: MediaItem; label?: string; onUserData: (item: MediaItem, userData: NonNullable<MediaItem['UserData']>) => void }) {
    const can = itemCapabilities(item);
    const [ busy, setBusy ] = useState(false);
    const [ error, setError ] = useState('');
    if (!api || (!can.canFavorite && !can.canMarkPlayed)) return null;
    const toggle = async (kind: 'favorite' | 'played') => {
        setBusy(true);
        setError('');
        try {
            if (kind === 'favorite') {
                const next = !item.UserData?.IsFavorite;
                onUserData(item, (await api.setFavorite(item.Id, next)) || { ...item.UserData, IsFavorite: next });
            } else {
                const played = !item.UserData?.Played;
                onUserData(item, playedUserData(item.UserData, played, await api.setPlayed(item.Id, played)));
            }
        } catch (cause) {
            setError(userMessage(cause));
        } finally {
            setBusy(false);
        }
    };
    const name = label ? ` ${label}` : '';
    return <div class="userdata-actions">
        {can.canFavorite && <button data-focusable="true" class="button secondary" type="button" aria-pressed={Boolean(item.UserData?.IsFavorite)} disabled={busy} onClick={() => void toggle('favorite')}>{item.UserData?.IsFavorite ? `♥ Favorite${name}` : `♡ Favorite${name}`}</button>}
        {can.canMarkPlayed && <button data-focusable="true" class="button secondary" type="button" aria-pressed={Boolean(item.UserData?.Played)} disabled={busy} onClick={() => void toggle('played')}>{item.UserData?.Played ? `✓ Watched${name}` : `Mark${name} watched`}</button>}
        {error && <p class="notice error" role="alert">Could not update: {error}</p>}
    </div>;
}
