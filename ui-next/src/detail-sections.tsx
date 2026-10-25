import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PLAYLIST_PAGE_SIZE, PLAYLIST_QUEUE_LIMIT, type JellyfinApi } from './api';
import type { JellyfinUser, MediaItem } from './types';
import { useDialogFocus } from './dialog-focus';
import { userMessage } from './ui-errors';
import { ManageItemActions, currentLayout } from './metadata-editors';
import { metadataActions } from './metadata-model';
import { canManageCollections, childView, detailFacts, discGroups, extrasSections, itemActions, linkedMetadata, shareLink, withoutItem, wrapIndex } from './detail-model';
import { appendEntries, hasMoreResults, itemCapabilities, playedUserData } from './catalog-model';
import { audioQueueable, createQueue, playQueue, queueable } from './play-queue';
import { musicEngine } from './music-player';
import { hostDownload, hostSupports, openExternalUrl } from './native-host';
import { t } from './i18n';

const minutes = (ticks?: number) => ticks ? `${Math.max(1, Math.round(ticks / 600_000_000))} min` : '';
const clock = (ticks?: number) => {
    if (!ticks) return '';
    const total = Math.round(ticks / 10_000_000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function DetailFactsView({ item }: { item: MediaItem }) {
    const facts = detailFacts(item);
    const showLinks = hostSupports('externallinks') && facts.links.length > 0;
    return <>
        {facts.tagline && <p class="detail-tagline">{facts.tagline}</p>}
        {(facts.officialRating || facts.criticRating !== undefined || facts.tags.length > 0 || showLinks) && <div class="detail-badges">
            {facts.officialRating && <span class="detail-badge" aria-label={`Rated ${facts.officialRating}`}>{facts.officialRating}</span>}
            {facts.criticRating !== undefined && <span class="detail-badge" aria-label={`Critics ${facts.criticRating}%`}>{facts.criticRating >= 60 ? '🍅' : '🥀'} {facts.criticRating}%</span>}
            {facts.tags.map(tag => <span key={tag.label} class="detail-badge detail-media-tag" title={tag.title} aria-label={tag.title}>{tag.label}</span>)}
            {showLinks && facts.links.map(link => <a key={link.url} data-focusable="true" class="detail-badge detail-link" href={link.url} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); openExternalUrl(link.url); }}>{t(link.label)}</a>)}
        </div>}
    </>;
}

export function LinkedMetadataView({ api, item, onOpen }: { api: JellyfinApi | null; item: MediaItem; onOpen: (item: MediaItem) => void }) {
    const linked = linkedMetadata(item);
    const chips = (title: string, entries: MediaItem[], detail?: (entry: MediaItem) => string) => entries.length > 0 && <div class="detail-chip-group">
        <h3>{title}</h3>
        <div class="detail-chips">{entries.map(entry => <button key={`${title}-${entry.Id}`} data-focusable="true" class="detail-chip" type="button" onClick={() => onOpen(entry)}>{entry.Name}{detail && detail(entry) ? <small>{detail(entry)}</small> : null}</button>)}</div>
    </div>;
    if (!linked.cast.length && !linked.crew.length && !linked.genres.length && !linked.studios.length && !linked.tags.length && !linked.artists.length && !linked.albums.length) return null;
    return <section class="detail-linked" aria-label={t('Cast, crew and categories')}>
        {linked.cast.length > 0 && <div class="detail-chip-group">
            <h3>{t('Cast')}</h3>
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
            <button data-focusable="true" type="button" class="detail-card-open" onClick={() => (onPlay && itemCapabilities(entry).playable ? onPlay(entry) : onOpen(entry))} aria-label={onPlay && itemCapabilities(entry).playable ? t('Play {0}', entry.Name) : t('Open {0}', entry.Name)}>
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
        <MediaRow api={api} title={t('Part of collections')} items={collections.value} onOpen={onOpen} />
        <MediaRow api={api} title={t('More like this')} items={similar.value} onOpen={onOpen} />
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
    return <div ref={ref} class="photo-viewer" role="dialog" aria-modal="true" aria-label={t('Photo {0} of {1}', index + 1, photos.length)} onKeyDown={event => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    }}>
        <img class="photo-viewer-image" src={api.imageUrl(photo, 'Primary', 2400, 92)} alt={photo.Name} />
        <div class="photo-viewer-bar">
            <span>{photo.Name} · {index + 1} / {photos.length}</span>
            {photos.length > 1 && <>
                <button data-focusable="true" class="button secondary" type="button" onClick={() => step(-1)} aria-label={t('Previous photo')}>‹</button>
                <button data-focusable="true" class="button secondary" type="button" aria-pressed={playing} onClick={() => setPlaying(value => !value)}>{playing ? t('Pause slideshow') : t('Slideshow')}</button>
                <button data-focusable="true" class="button secondary" type="button" onClick={() => step(1)} aria-label={t('Next photo')}>›</button>
            </>}
            <button data-focusable="true" class="button secondary" type="button" onClick={onClose}>{t('Close')}</button>
        </div>
    </div>;
}

/** Album tracks, playlist entries, photo-album photos and collection members. */
export function DetailChildren({ api, item, user, onOpen, onPlay, onChanged }: { api: JellyfinApi | null; item: MediaItem; user: JellyfinUser; onOpen: (item: MediaItem) => void; onPlay: (item: MediaItem) => void; onChanged?: () => void }) {
    const kind = childView(item);
    if (kind === 'playlist') return <PlaylistEntries api={api} item={item} onOpen={onOpen} onPlay={onPlay} onChanged={onChanged} />;
    return <ChildList api={api} item={item} user={user} kind={kind} onOpen={onOpen} onPlay={onPlay} />;
}

function ChildList({ api, item, user, kind, onOpen, onPlay }: { api: JellyfinApi | null; item: MediaItem; user: JellyfinUser; kind: ReturnType<typeof childView>; onOpen: (item: MediaItem) => void; onPlay: (item: MediaItem) => void }) {
    const children = useLoaded(api && kind ? () => (kind === 'tracks' ? api.getAlbumTracks(item.Id) : api.getChildren(item.Id, kind === 'photos' ? 'SortName' : kind === 'members' ? 'ProductionYear,SortName' : undefined)) : null, [ api, item.Id, kind ], [] as MediaItem[]);
    const [ viewer, setViewer ] = useState<number | null>(null);
    const [ busy, setBusy ] = useState('');
    const [ error, setError ] = useState('');
    const manage = kind === 'members' && canManageCollections(user);
    if (!kind) return null;
    if (children.loading && !children.value.length) return <p class="muted" role="status">{t('Loading contents…')}</p>;
    if (children.error) return <p class="notice error" role="alert">{t('Contents could not load: {0}', children.error)}{' '}<button data-focusable="true" class="button secondary" type="button" onClick={children.reload}>{t('Retry')}</button></p>;
    if (!children.value.length) return <p class="muted">{kind === 'photos' ? t('This album has no photos.') : t('Nothing here yet.')}</p>;
    if (kind === 'tracks') return <section class="detail-tracks" aria-label={t('Tracks')}>
        {discGroups(children.value).map(group => <div key={group.disc ?? 'all'}>
            {group.disc !== null && <h3>{t('Disc {0}', group.disc)}</h3>}
            <ol class="track-list">{group.tracks.map(track => <li key={track.Id} class="track-item"><button data-focusable="true" type="button" class="track-row" aria-label={t('Play {0}', track.Name)} onClick={() => musicEngine.playTracks(children.value, children.value.indexOf(track))}>
                <span class="track-number">{track.IndexNumber ?? ''}</span>
                <span class="track-name">{track.Name}{track.ArtistItems?.length && track.ArtistItems.map(artist => artist.Name).join(', ') !== item.AlbumArtists?.map(artist => artist.Name).join(', ') ? <small>{track.ArtistItems.map(artist => artist.Name).join(', ')}</small> : null}</span>
                <span class="track-duration">{clock(track.RunTimeTicks)}</span>
            </button><button data-focusable="true" type="button" class="track-row-info" aria-label={t('Details for {0}', track.Name)} onClick={() => onOpen(track)}>ⓘ</button></li>)}</ol>
        </div>)}
    </section>;
    if (kind === 'photos') {
        const photos = children.value.filter(child => child.Type === 'Photo');
        const folders = children.value.filter(child => child.Type !== 'Photo');
        return <section class="detail-photos" aria-label={t('Photos')}>
            {photos.length > 0 && <button data-focusable="true" class="button primary" type="button" onClick={() => setViewer(0)}>{t('▶ Slideshow')}</button>}
            <div class="photo-grid">
                {folders.map(folder => <button key={folder.Id} data-focusable="true" class="photo-tile folder" type="button" onClick={() => onOpen(folder)}><span>{folder.Name}</span></button>)}
                {photos.map((photo, position) => <button key={photo.Id} data-focusable="true" class="photo-tile" type="button" aria-label={t('View {0}', photo.Name)} onClick={() => setViewer(position)}>{api && <img src={api.imageUrl(photo, 'Primary', 360)} alt="" loading="lazy" />}</button>)}
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
    const queued = children.value.filter(entry => queueable(entry) || audioQueueable(entry));
    const playFrom = (start: MediaItem | null, shuffle = false) => startListQueue(children.value, start, shuffle, onPlay);
    return <section class="detail-entries" aria-label={t('Collection members')}>
        {error && <p class="notice error" role="alert">{error}</p>}
        {queued.length > 1 && <div class="detail-queue-actions">
            <button data-focusable="true" class="button primary" type="button" onClick={() => playFrom(null)}>{t('▶ Play all')}</button>
            <button data-focusable="true" class="button secondary" type="button" onClick={() => playFrom(null, true)}>{t('⤮ Shuffle')}</button>
        </div>}
        <ol class="entry-list">{children.value.map((entry, position) => <li key={entry.PlaylistItemId || entry.Id} class="entry-row">
            <span class="track-number">{position + 1}</span>
            <button data-focusable="true" type="button" class="entry-open" onClick={() => onOpen(entry)}>
                {api && api.imageUrl(entry, 'Primary', 120) ? <img src={api.imageUrl(entry, 'Primary', 120)} alt="" loading="lazy" /> : <span class="entry-art" aria-hidden="true" />}
                <span><strong>{entry.SeriesName ? `${entry.SeriesName} · ${entry.Name}` : entry.Name}</strong><small>{[ entry.Type, entry.ProductionYear, minutes(entry.RunTimeTicks) ].filter(Boolean).join(' · ')}</small></span>
            </button>
            {itemCapabilities(entry).playable && <button data-focusable="true" class="button secondary" type="button" aria-label={t('Play {0}', entry.Name)} onClick={() => (queued.indexOf(entry) >= 0 && queued.length > 1 ? playFrom(entry) : onPlay(entry))}>▶</button>}
            {manage && <button data-focusable="true" class="button secondary" type="button" disabled={busy === entry.Id} onClick={() => void remove(entry)}>{t('Remove')}</button>}
        </li>)}</ol>
    </section>;
}

const entryKey = (entry: MediaItem) => entry.PlaylistItemId || entry.Id;

/** A list led by a track becomes a music queue of its tracks; otherwise its videos form the video queue. */
function startListQueue(list: MediaItem[], start: MediaItem | null, shuffle: boolean, onPlay: (item: MediaItem) => void): void {
    const lead = start || list.find(entry => queueable(entry) || audioQueueable(entry));
    if (lead && audioQueueable(lead)) {
        const tracks = list.filter(audioQueueable);
        musicEngine.playTracks(tracks, start ? tracks.findIndex(entry => entryKey(entry) === entryKey(start)) : 0, { shuffle });
        return;
    }
    const videos = list.filter(queueable);
    const started = createQueue(videos, start ? videos.findIndex(entry => entryKey(entry) === entryKey(start)) : shuffle ? -1 : 0, { shuffle });
    if (!started) return;
    playQueue.set(started.queue);
    onPlay(started.item);
}

/** Playlist entries, paged; owners and editors can remove, reorder and rename. */
function PlaylistEntries({ api, item, onOpen, onPlay, onChanged }: { api: JellyfinApi | null; item: MediaItem; onOpen: (item: MediaItem) => void; onPlay: (item: MediaItem) => void; onChanged?: () => void }) {
    const [ entries, setEntries ] = useState<MediaItem[]>([]);
    const [ total, setTotal ] = useState(0);
    const [ loading, setLoading ] = useState(true);
    const [ loadError, setLoadError ] = useState('');
    const [ moreError, setMoreError ] = useState('');
    const [ error, setError ] = useState('');
    const [ busy, setBusy ] = useState('');
    const [ attempt, setAttempt ] = useState(0);
    const [ canEdit, setCanEdit ] = useState(false);
    const [ renaming, setRenaming ] = useState<string | null>(null);
    useEffect(() => {
        setEntries([]);
        setTotal(0);
        setLoadError('');
        setMoreError('');
        if (!api) return;
        let active = true;
        setLoading(true);
        void api.getPlaylistEntries(item.Id).then(page => { if (active) { setEntries(page.items); setTotal(page.total); } })
            .catch(cause => { if (active) setLoadError(userMessage(cause)); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [ api, item.Id, attempt ]);
    useEffect(() => {
        setCanEdit(false);
        if (!api) return;
        let active = true;
        void api.canEditPlaylist(item.Id).then(allowed => { if (active) setCanEdit(allowed); });
        return () => { active = false; };
    }, [ api, item.Id ]);
    const run = async (key: string, work: () => Promise<void>) => {
        setBusy(key);
        setError('');
        try { await work(); } catch (cause) { setError(userMessage(cause)); } finally { setBusy(''); }
    };
    const loadMore = () => {
        if (!api) return;
        setMoreError('');
        void run('more', async () => {
            try {
                const page = await api.getPlaylistEntries(item.Id, entries.length);
                setEntries(current => appendEntries(current, page.items));
                setTotal(page.total);
            } catch (cause) {
                setMoreError(userMessage(cause));
            }
        });
    };
    /** Play all and Shuffle queue the whole playlist (up to PLAYLIST_QUEUE_LIMIT), not just the loaded page. */
    const playFrom = (start: MediaItem | null, shuffle = false) => void run('play', async () => {
        let all = entries;
        while (api && all.length < Math.min(total, PLAYLIST_QUEUE_LIMIT)) {
            const page = await api.getPlaylistEntries(item.Id, all.length, Math.min(PLAYLIST_PAGE_SIZE * 5, PLAYLIST_QUEUE_LIMIT - all.length));
            const next = appendEntries(all, page.items);
            if (next.length === all.length) break;
            all = next;
        }
        if (all !== entries) setEntries(all);
        startListQueue(all, start, shuffle, onPlay);
    });
    const remove = (entry: MediaItem) => api && entry.PlaylistItemId && void run(entry.PlaylistItemId, async () => {
        await api.removeFromPlaylist(item.Id, [ entry.PlaylistItemId! ]);
        setEntries(current => current.filter(candidate => candidate.PlaylistItemId !== entry.PlaylistItemId));
        setTotal(current => Math.max(0, current - 1));
    });
    const move = (position: number, delta: -1 | 1) => {
        const entry = entries[position];
        const target = position + delta;
        if (!api || !entry?.PlaylistItemId || target < 0 || target >= entries.length) return;
        void run(entry.PlaylistItemId, async () => {
            await api.movePlaylistEntry(item.Id, entry.PlaylistItemId!, target);
            setEntries(current => {
                const next = current.slice();
                const [ moved ] = next.splice(position, 1);
                next.splice(target, 0, moved);
                return next;
            });
        });
    };
    const rename = (name: string) => api && void run('rename', async () => {
        await api.renamePlaylist(item.Id, name);
        setRenaming(null);
        onChanged?.();
    });
    const header = canEdit && <div class="playlist-edit">
        {renaming === null
            ? <button data-focusable="true" class="button secondary" type="button" onClick={() => setRenaming(item.Name || '')}>{t('Rename playlist')}</button>
            : <form class="collection-new" onSubmit={event => { event.preventDefault(); const trimmed = renaming.trim(); if (!trimmed) { setError(t('Enter a playlist name.')); return; } rename(trimmed); }}>
                <label>{t('Playlist name')}<input data-focusable="true" value={renaming} maxLength={200} onInput={event => setRenaming((event.currentTarget as HTMLInputElement).value)} /></label>
                <button data-focusable="true" class="button secondary" type="submit" disabled={busy === 'rename'}>{t('Save')}</button>
                <button data-focusable="true" class="button secondary" type="button" onClick={() => setRenaming(null)}>{t('Cancel')}</button>
            </form>}
    </div>;
    if (loading && !entries.length) return <p class="muted" role="status">{t('Loading contents…')}</p>;
    if (loadError) return <p class="notice error" role="alert">{t('Contents could not load: {0}', loadError)}{' '}<button data-focusable="true" class="button secondary" type="button" onClick={() => setAttempt(value => value + 1)}>{t('Retry')}</button></p>;
    if (!entries.length) return <>{header}<p class="muted">{t('This playlist is empty.')}</p></>;
    const playable = entries.filter(entry => queueable(entry) || audioQueueable(entry)).length > 1 || total > entries.length;
    const remaining = total - entries.length;
    return <section class="detail-entries" aria-label={t('Playlist entries')}>
        {header}
        {error && <p class="notice error" role="alert">{error}</p>}
        {playable && <div class="detail-queue-actions">
            <button data-focusable="true" class="button primary" type="button" disabled={busy === 'play'} onClick={() => playFrom(null)}>{t('▶ Play all')}</button>
            <button data-focusable="true" class="button secondary" type="button" disabled={busy === 'play'} onClick={() => playFrom(null, true)}>{t('⤮ Shuffle')}</button>
        </div>}
        <ol class="entry-list">{entries.map((entry, position) => <li key={entry.PlaylistItemId || entry.Id} class="entry-row">
            <span class="track-number">{position + 1}</span>
            <button data-focusable="true" type="button" class="entry-open" onClick={() => onOpen(entry)}>
                {api && api.imageUrl(entry, 'Primary', 120) ? <img src={api.imageUrl(entry, 'Primary', 120)} alt="" loading="lazy" /> : <span class="entry-art" aria-hidden="true" />}
                <span><strong>{entry.SeriesName ? `${entry.SeriesName} · ${entry.Name}` : entry.Name}</strong><small>{[ entry.Type, entry.ProductionYear, minutes(entry.RunTimeTicks) ].filter(Boolean).join(' · ')}</small></span>
            </button>
            {itemCapabilities(entry).playable && <button data-focusable="true" class="button secondary" type="button" aria-label={t('Play {0}', entry.Name)} onClick={() => ((queueable(entry) || audioQueueable(entry)) && playable ? playFrom(entry) : onPlay(entry))}>▶</button>}
            {canEdit && entry.PlaylistItemId && <>
                <button data-focusable="true" class="button secondary" type="button" aria-label={t('Move {0} up', entry.Name)} disabled={position === 0 || busy !== ''} onClick={() => move(position, -1)}>↑</button>
                <button data-focusable="true" class="button secondary" type="button" aria-label={t('Move {0} down', entry.Name)} disabled={position === entries.length - 1 || busy !== ''} onClick={() => move(position, 1)}>↓</button>
                <button data-focusable="true" class="button secondary" type="button" aria-label={t('Remove {0} from playlist', entry.Name)} disabled={busy !== ''} onClick={() => remove(entry)}>{t('Remove')}</button>
            </>}
        </li>)}</ol>
        {hasMoreResults(entries.length, total) && <div class="load-more">
            {moreError && <p class="notice error" role="alert">{t('More entries could not load: {0}', moreError)}</p>}
            <button data-focusable="true" class="button secondary" type="button" disabled={busy === 'more'} onClick={loadMore}>{moreError ? t('Retry') : t('Load more ({0} remaining)', remaining.toLocaleString())}</button>
        </div>}
    </section>;
}

export function LyricsView({ api, item }: { api: JellyfinApi | null; item: MediaItem }) {
    const lyrics = useLoaded(api && item.Type === 'Audio' ? () => api.getLyrics(item.Id).catch(() => []) : null, [ api, item.Id ], [] as Array<{ Text?: string }>);
    if (!lyrics.value.length) return null;
    return <section class="detail-lyrics" aria-label={t('Lyrics')}><h2>{t('Lyrics')}</h2>{lyrics.value.map((line, index) => <p key={index}>{line.Text || '\u00a0'}</p>)}</section>;
}

/** The less-frequent item actions (download, share, collection, manage, delete) behind a "More" menu. */
export function ItemActionsBar({ api, item, user, serverId, onDeleted, onChanged }: { api: JellyfinApi | null; item: MediaItem; user: JellyfinUser; serverId: string; onDeleted: (item: MediaItem) => void; onChanged: () => void }) {
    const actions = itemActions(item, user);
    const [ menuOpen, setMenuOpen ] = useState(false);
    const [ message, setMessage ] = useState('');
    const [ error, setError ] = useState('');
    const [ confirmDelete, setConfirmDelete ] = useState(false);
    const [ picker, setPicker ] = useState(false);
    const [ playlistPicker, setPlaylistPicker ] = useState(false);
    const [ busy, setBusy ] = useState(false);
    const [ menuPosition, setMenuPosition ] = useState({ left: 0, top: 0 });
    const menu = useRef<HTMLDivElement>(null);
    const more = useRef<HTMLButtonElement>(null);
    const closeMenu = () => { setMenuOpen(false); setPicker(false); setPlaylistPicker(false); setConfirmDelete(false); };
    const openMenu = () => {
        const rect = more.current?.getBoundingClientRect();
        if (rect && !document.documentElement.classList.contains('tv-client') && window.innerWidth > 767) {
            setMenuPosition({ left: Math.max(12, Math.min(window.innerWidth - 272, rect.right - 260)), top: Math.min(window.innerHeight - 380, rect.bottom + 8) });
        }
        setMenuOpen(true);
    };
    useDialogFocus(menu, menuOpen, closeMenu, { initial: 'button', fallback: () => more.current });
    if (!api) return null;
    const manageable = metadataActions(item, user, currentLayout()).any;
    if (!actions.download && !actions.share && !actions.collection && !actions.playlist && !actions.remove && !manageable) return null;
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
        const url = shareLink(window.location.href, item);
        const nav = navigator as Navigator & { share?: (data: { title?: string; url?: string }) => Promise<void> };
        if (typeof nav.share === 'function') {
            await nav.share({ title: item.Name, url }).catch(() => undefined);
            return;
        }
        await navigator.clipboard.writeText(url);
        return t('Link copied. It opens this title for anyone signed in to this server.');
    });
    return <>
        <button ref={more} data-focusable="true" class="button secondary" type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => menuOpen ? closeMenu() : openMenu()}>{t('More')}</button>
        {menuOpen && <div class="detail-menu-shade" onClick={event => { if (event.target === event.currentTarget) closeMenu(); }}>
            <div ref={menu} style={!document.documentElement.classList.contains('tv-client') && window.innerWidth > 767 ? { left: `${menuPosition.left}px`, top: `${menuPosition.top}px` } : undefined} class="detail-action-menu" role="menu" aria-label={t('More actions for {0}', item.Name)}>
                <strong>{item.Name}</strong>
                {picker
                    ? <CollectionPicker api={api} itemIds={[ item.Id ]} onDone={text => { setPicker(false); setMessage(text); }} />
                    : playlistPicker
                        ? <PlaylistPicker api={api} itemIds={[ item.Id ]} onDone={text => { setPlaylistPicker(false); setMessage(text); }} />
                        : <>
                            {actions.download && hostSupports('filedownload') && <a role="menuitem" data-focusable="true" class="detail-menu-item" href={api.downloadUrl(item.Id)} download onClick={event => {
                                const filename = (item as MediaItem & { Path?: string }).Path?.replace(/^.*[\\/]/, '') || item.Name || item.Id;
                                if (hostDownload({ url: api.downloadUrl(item.Id), itemId: item.Id, serverId, title: item.Name || filename, filename })) {
                                    event.preventDefault();
                                    closeMenu();
                                    setMessage(t('Download started in the app.'));
                                }
                            }}>{t('⤓ Download')}</a>}
                            {actions.share && <button role="menuitem" data-focusable="true" class="detail-menu-item" type="button" disabled={busy} onClick={() => { closeMenu(); void share(); }}>{t('Share')}</button>}
                            {actions.collection && <button role="menuitem" data-focusable="true" class="detail-menu-item" type="button" onClick={() => { setPlaylistPicker(false); setPicker(true); }}>{t('Add to collection')}</button>}
                            {actions.playlist && <button role="menuitem" data-focusable="true" class="detail-menu-item" type="button" onClick={() => { setPicker(false); setPlaylistPicker(true); }}>{t('Add to playlist')}</button>}
                            <ManageItemActions api={api} item={item} user={user} onChanged={onChanged} menu />
                            {actions.remove && (confirmDelete
                                ? <><p class="notice error" role="alert">{t('This permanently deletes “{0}” and its files from the server for everyone.', item.Name)}</p><button role="menuitem" data-focusable="true" class="detail-menu-item danger" type="button" disabled={busy} onClick={() => void run(async () => { await api.deleteItem(item.Id); onDeleted(item); closeMenu(); })}>{t('Delete from server')}</button><button role="menuitem" data-focusable="true" class="detail-menu-item" type="button" onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button></>
                                : <button role="menuitem" data-focusable="true" class="detail-menu-item" type="button" onClick={() => setConfirmDelete(true)}>{t('Delete…')}</button>)}
                            <button role="menuitem" data-focusable="true" class="detail-menu-item" type="button" onClick={closeMenu}>{t('Close')}</button>
                        </>}
            </div>
        </div>}
        {message && <p class="notice success detail-action-notice" role="status">{message}</p>}
        {error && <p class="notice error detail-action-notice" role="alert">{error}</p>}
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
    return <section class="collection-picker" aria-label={t('Add to collection')}>
        {collections.loading && <p class="muted" role="status">{t('Loading collections…')}</p>}
        {collections.value.length > 0 && <div class="detail-chips">{collections.value.map(collection => <button key={collection.Id} data-focusable="true" class="detail-chip" type="button" disabled={busy} onClick={() => void act(async () => { await api.addToCollection(collection.Id, itemIds); return `Added ${what} to ${collection.Name}.`; })}>{collection.Name}</button>)}</div>}
        <form class="collection-new" onSubmit={event => { event.preventDefault(); const trimmed = name.trim(); if (!trimmed) { setError(t('Enter a collection name.')); return; } void act(async () => { await api.createCollection(trimmed, itemIds); return `Created ${trimmed} with ${what}.`; }); }}>
            <label>{t('New collection')}<input data-focusable="true" value={name} maxLength={200} onInput={event => setName((event.currentTarget as HTMLInputElement).value)} /></label>
            <button data-focusable="true" class="button secondary" type="submit" disabled={busy}>{t('Create')}</button>
        </form>
        {error && <p class="notice error" role="alert">{error}</p>}
    </section>;
}

/** Adds titles to an existing playlist or a new one; the server refuses playlists this user cannot edit. */
export function PlaylistPicker({ api, itemIds, onDone }: { api: JellyfinApi; itemIds: string[]; onDone: (message: string) => void }) {
    const what = itemIds.length === 1 ? 'this title' : `${itemIds.length} titles`;
    const playlists = useLoaded(() => api.getPlaylists(), [ api ], [] as MediaItem[]);
    const [ name, setName ] = useState('');
    const [ error, setError ] = useState('');
    const [ busy, setBusy ] = useState(false);
    const act = async (work: () => Promise<string>) => {
        setBusy(true);
        setError('');
        try { onDone(await work()); } catch (cause) { setError(userMessage(cause)); } finally { setBusy(false); }
    };
    return <section class="collection-picker" aria-label={t('Add to playlist')}>
        {playlists.loading && <p class="muted" role="status">{t('Loading playlists…')}</p>}
        {playlists.error && <p class="notice error" role="alert">{t('Playlists could not load: {0}', playlists.error)}</p>}
        {playlists.value.length > 0 && <div class="detail-chips">{playlists.value.map(playlist => <button key={playlist.Id} data-focusable="true" class="detail-chip" type="button" disabled={busy} onClick={() => void act(async () => { await api.addToPlaylist(playlist.Id, itemIds); return `Added ${what} to ${playlist.Name}.`; })}>{playlist.Name}</button>)}</div>}
        <form class="collection-new" onSubmit={event => { event.preventDefault(); const trimmed = name.trim(); if (!trimmed) { setError(t('Enter a playlist name.')); return; } void act(async () => { await api.createPlaylist(trimmed, itemIds); return `Created ${trimmed} with ${what}.`; }); }}>
            <label>{t('New playlist')}<input data-focusable="true" value={name} maxLength={200} onInput={event => setName((event.currentTarget as HTMLInputElement).value)} /></label>
            <button data-focusable="true" class="button secondary" type="submit" disabled={busy}>{t('Create')}</button>
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
        {can.canFavorite && <button data-focusable="true" class="button secondary" type="button" aria-pressed={Boolean(item.UserData?.IsFavorite)} disabled={busy} onClick={() => void toggle('favorite')}>{item.UserData?.IsFavorite ? t('♥ Favorite{0}', name) : t('♡ Favorite{0}', name)}</button>}
        {can.canMarkPlayed && <button data-focusable="true" class="button secondary" type="button" aria-pressed={Boolean(item.UserData?.Played)} disabled={busy} onClick={() => void toggle('played')}>{item.UserData?.Played ? t('✓ Watched{0}', name) : t('Mark{0} watched', name)}</button>}
        {error && <p class="notice error" role="alert">{t('Could not update: {0}', error)}</p>}
    </div>;
}
