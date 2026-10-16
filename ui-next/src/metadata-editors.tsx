import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import type { Culture } from './api-contracts';
import { useDialogFocus } from './dialog-focus';
import {
    deleteImage, deleteLyrics, deleteSubtitle, downloadLyrics, downloadRemoteImage, downloadSubtitle, getEditorInfo, getFullItem, getImages, getLyrics,
    getRemoteImages, itemImageUrl, moveImage, readFileAsBase64, readFileAsText, refreshItem, remoteSearch, applyRemoteSearch, searchLyrics, searchSubtitles,
    setContentType, updateItem, uploadImage, uploadLyrics, uploadSubtitle,
} from './metadata-api';
import {
    changedMetadata, DISPLAY_ORDERS, editorFields, fileExtension, identifyQuery, identifyType, imageTypesFor, LOCKABLE_FIELDS, metadataActions, metadataDraft,
    metadataErrorMessage, PERSON_TYPES, refreshOptions, SERIES_STATUSES, validateDraft, validateImageFile, validateLyricFile, validateSubtitleFile, VIDEO_3D_FORMATS,
    WEEK_DAYS, type ImageInfo, type LyricLine, type MetadataDraft, type MetadataEditorInfo, type MetadataFieldKey, type RefreshMode, type RemoteImage,
    type RemoteLyric, type RemoteSearchResult, type RemoteSubtitle,
} from './metadata-model';
import type { JellyfinUser, MediaItem } from './types';
import { hostSupports, openExternalUrl } from './native-host';
import { t } from './i18n';

export type MetadataTab = 'edit' | 'images' | 'identify' | 'refresh' | 'subtitles' | 'lyrics';

const TAB_LABELS: Record<MetadataTab, string> = { edit: t('Edit metadata'), images: 'Images', identify: 'Identify', refresh: t('Refresh metadata'), subtitles: 'Subtitles', lyrics: 'Lyrics' };
const TAB_ORDER: MetadataTab[] = [ 'edit', 'images', 'identify', 'refresh', 'subtitles', 'lyrics' ];

/** Returns a factory for checks that fail once the dependency (the account's API) changes or the component unmounts. */
function useGuard(dependency: unknown): () => () => boolean {
    const epoch = useRef(0);
    useEffect(() => () => { epoch.current += 1; }, [dependency]);
    return () => {
        const at = epoch.current;
        return () => at === epoch.current;
    };
}

export function currentLayout(): string {
    return typeof document !== 'undefined' && document.documentElement.classList.contains('tv-client') ? 'tv' : 'desktop';
}

export function ManageItemActions({ api, item, user, onChanged, buttonClass = 'button secondary', layout, compact, menu }: {
    api: JellyfinApi | null; item: MediaItem; user: JellyfinUser | null; onChanged: () => void; buttonClass?: string; layout?: string; compact?: boolean; menu?: boolean;
}) {
    const [open, setOpen] = useState<MetadataTab | null>(null);
    useEffect(() => () => setOpen(null), [api, item.Id]);
    const actions = metadataActions(item, user, layout || currentLayout());
    if (!api || !actions.any) return null;
    const tabs = TAB_ORDER.filter(tab => actions[tab]);
    return <>
        {menu
            ? tabs.map(tab => <button key={tab} role="menuitem" data-focusable="true" type="button" class="detail-menu-item" onClick={() => setOpen(tab)}>{TAB_LABELS[tab]}</button>)
            : compact
                ? <button type="button" class={buttonClass} aria-label={t('Manage {0}', item.Name)} onClick={() => setOpen(tabs[0])}>{t('Manage')}</button>
                : <div class="md-actions" role="group" aria-label={t('Manage {0}', item.Name)}>
                    {tabs.map(tab => <button key={tab} data-focusable="true" type="button" class={buttonClass} onClick={() => setOpen(tab)}>{TAB_LABELS[tab]}</button>)}
                </div>}
        {open && <MetadataSheet api={api} item={item} user={user} tabs={tabs} initial={open} onClose={() => setOpen(null)} onChanged={onChanged} />}
    </>;
}

export function MetadataSheet({ api, item, user, tabs, initial, onClose, onChanged }: {
    api: JellyfinApi; item: MediaItem; user: JellyfinUser | null; tabs: MetadataTab[]; initial: MetadataTab; onClose: () => void; onChanged: () => void;
}) {
    const sheet = useRef<HTMLElement>(null);
    const [tab, setTab] = useState<MetadataTab>(initial);
    const [visited, setVisited] = useState<MetadataTab[]>([ initial ]);
    const [dirty, setDirty] = useState(false);
    const [confirmClose, setConfirmClose] = useState(false);
    const requestClose = () => { if (dirty) setConfirmClose(true); else onClose(); };
    useDialogFocus(sheet, true, requestClose, { initial: '.md-tab.on' });
    const pick = (next: MetadataTab) => { setTab(next); setVisited(current => current.includes(next) ? current : [ ...current, next ]); };
    const titleId = `md-sheet-title-${item.Id}`;
    return createPortal(<div class="md-backdrop" onClick={event => { if (event.target === event.currentTarget) requestClose(); }}>
        <aside ref={sheet} class="md-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <header class="md-head">
                <div><p class="md-eyebrow">{item.Type || t('Item')}</p><h2 id={titleId}>{item.Name}</h2></div>
                <button type="button" class="md-btn md-close" onClick={requestClose}>{t('Close')}</button>
            </header>
            {confirmClose && <div class="md-confirm" role="alert">
                <span>{t('You have unsaved metadata changes.')}</span>
                <button type="button" class="md-btn danger" onClick={onClose}>{t('Discard changes')}</button>
                <button type="button" class="md-btn" onClick={() => setConfirmClose(false)}>{t('Keep editing')}</button>
            </div>}
            {tabs.length > 1 && <div class="md-tabs" role="tablist">{tabs.map(entry =>
                <button key={entry} type="button" role="tab" aria-selected={tab === entry} class={`md-tab${tab === entry ? ' on' : ''}`} onClick={() => pick(entry)}>{TAB_LABELS[entry]}</button>)}</div>}
            <div class="md-body">
                {visited.includes('edit') && <div hidden={tab !== 'edit'}><EditMetadataPanel api={api} item={item} onDirty={setDirty} onSaved={onChanged} /></div>}
                {visited.includes('images') && <div hidden={tab !== 'images'}><ImagesPanel api={api} item={item} onChanged={onChanged} /></div>}
                {visited.includes('identify') && <div hidden={tab !== 'identify'}><IdentifyPanel api={api} item={item} onChanged={onChanged} /></div>}
                {visited.includes('refresh') && <div hidden={tab !== 'refresh'}><RefreshPanel api={api} item={item} onChanged={onChanged} /></div>}
                {visited.includes('subtitles') && <div hidden={tab !== 'subtitles'}><SubtitlesPanel api={api} item={item} user={user} onChanged={onChanged} /></div>}
                {visited.includes('lyrics') && <div hidden={tab !== 'lyrics'}><LyricsPanel api={api} item={item} onChanged={onChanged} /></div>}
            </div>
        </aside>
    </div>, document.body);
}

function ConfirmAction({ label, confirmLabel, onConfirm, danger, disabled }: { label: string; confirmLabel?: string; onConfirm: () => void | Promise<void>; danger?: boolean; disabled?: boolean }) {
    const [armed, setArmed] = useState(false);
    if (!armed) return <button type="button" class={`md-btn${danger ? ' danger' : ''}`} disabled={disabled} onClick={() => setArmed(true)}>{t(label)}</button>;
    return <span class="md-inline-confirm">
        <button type="button" aria-label={t('Confirm {0}', label)} class={`md-btn ${danger ? 'danger fill' : 'primary'}`} disabled={disabled} onClick={() => { setArmed(false); void onConfirm(); }}>{confirmLabel || t('Confirm')}</button>
        <button type="button" class="md-btn" onClick={() => setArmed(false)}>{t('Cancel')}</button>
    </span>;
}

function Status({ error, message }: { error: string; message: string }) {
    return <>
        {error && <p class="md-error" role="alert">{error}</p>}
        {message && !error && <p class="md-note" role="status">{message}</p>}
    </>;
}

/* ---------- Edit metadata ---------- */

function ChipList({ label, values, onChange, disabled }: { label: string; values: string[]; onChange: (values: string[]) => void; disabled?: boolean }) {
    const [entry, setEntry] = useState('');
    const add = () => {
        const value = entry.trim();
        if (!value) return;
        if (!values.some(existing => existing.toLowerCase() === value.toLowerCase())) onChange([ ...values, value ]);
        setEntry('');
    };
    return <fieldset class="md-field md-chips">
        <legend>{t(label)}</legend>
        <div class="md-chip-row">{values.map(value => <span key={value} class="md-chip">{value}<button type="button" aria-label={t('Remove {0} from {1}', value, label)} disabled={disabled} onClick={() => onChange(values.filter(existing => existing !== value))}>×</button></span>)}</div>
        <div class="md-inline">
            <input aria-label={t('Add to {0}', label)} value={entry} maxLength={300} disabled={disabled} onInput={event => setEntry(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
            <button type="button" class="md-btn" disabled={disabled || !entry.trim()} onClick={add}>{t('Add')}</button>
        </div>
    </fieldset>;
}

function EditMetadataPanel({ api, item, onDirty, onSaved }: { api: JellyfinApi; item: MediaItem; onDirty: (dirty: boolean) => void; onSaved: () => void }) {
    const guard = useGuard(api);
    const [full, setFull] = useState<MediaItem | null>(null);
    const [info, setInfo] = useState<MetadataEditorInfo | null>(null);
    const [original, setOriginal] = useState<MetadataDraft | null>(null);
    const [draft, setDraft] = useState<MetadataDraft | null>(null);
    const [contentType, setContentTypeDraft] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);

    const load = async () => {
        const live = guard();
        setError('');
        try {
            const [ next, editor ] = await Promise.all([ getFullItem(api, item.Id), getEditorInfo(api, item.Id) ]);
            if (!live()) return;
            const initial = metadataDraft(next);
            setFull(next); setInfo(editor); setOriginal(initial); setDraft(initial); setContentTypeDraft(editor.ContentType || '');
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('Loading metadata')));
        }
    };
    useEffect(() => { void load(); }, [api, item.Id]);

    const changes = useMemo(() => original && draft ? changedMetadata(original, draft) : {}, [original, draft]);
    const contentTypeChanged = Boolean(info && contentType !== (info.ContentType || ''));
    const dirty = Object.keys(changes).length > 0 || contentTypeChanged;
    useEffect(() => { onDirty(dirty); }, [dirty]);
    useEffect(() => () => onDirty(false), []);

    if (!draft || !full || !info) return error ? <Status error={error} message="" /> : <p class="md-note" role="status">{t('Loading metadata…')}</p>;
    const fields = editorFields(full);
    const has = (key: MetadataFieldKey) => fields.has(key);
    const set = <K extends keyof MetadataDraft>(key: K, value: MetadataDraft[K]) => { setDraft(current => current ? { ...current, [key]: value } : current); setMessage(''); };
    const text = (key: keyof MetadataDraft, label: string, props: Record<string, unknown> = {}) => has(key as MetadataFieldKey) && <label class="md-field">{label}
        <input value={draft[key] as string} disabled={busy} maxLength={300} onInput={event => set(key, event.currentTarget.value as never)} {...props} /></label>;
    const select = (key: keyof MetadataDraft, label: string, options: Array<[string, string]>) => {
        if (!has(key as MetadataFieldKey)) return null;
        const value = draft[key] as string;
        const all = value && !options.some(([ option ]) => option === value) ? [ [ value, value ] as [string, string], ...options ] : options;
        return <label class="md-field">{t(label)}<select value={value} disabled={busy} onChange={event => set(key, event.currentTarget.value as never)}>{all.map(([ option, name ]) => <option key={option} value={option}>{t(name)}</option>)}</select></label>;
    };
    const ratings: Array<[string, string]> = [ [ '', 'None' ], ...info.ParentalRatingOptions.map(option => [ option.Name, option.Name ] as [string, string]) ];
    const languages: Array<[string, string]> = [ [ '', 'Default' ], ...info.Cultures.map(culture => [ culture.TwoLetterISOLanguageName || culture.ThreeLetterISOLanguageName, culture.DisplayName ] as [string, string]) ];
    const countries: Array<[string, string]> = [ [ '', 'Default' ], ...info.Countries.map(country => [ country.TwoLetterISORegionName, country.Name ] as [string, string]) ];
    const providerKeys = Array.from(new Set([ ...info.ExternalIdInfos.map(entry => entry.Key), ...Object.keys(draft.ProviderIds) ]));

    const save = async () => {
        const problem = validateDraft(draft);
        if (problem) { setError(problem); return; }
        const live = guard();
        setBusy(true); setError(''); setMessage('');
        try {
            if (Object.keys(changes).length) await updateItem(api, item.Id, changes);
            if (contentTypeChanged) await setContentType(api, item.Id, contentType);
            if (!live()) return;
            setMessage(t('Metadata saved.'));
            await load();
            onSaved();
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('Saving metadata')));
        } finally {
            if (live()) setBusy(false);
        }
    };

    return <form class="md-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        {full.Path && <p class="md-note md-path">{full.Path}</p>}
        <div class="md-grid">
            {text('Name', 'Title', { required: true })}
            {text('OriginalTitle', t('Original title'))}
            {text('ForcedSortName', t('Sort title'))}
            {text('IndexNumber', item.Type === 'Season' ? t('Season number') : item.Type === 'Audio' ? t('Track number') : 'Number', { inputMode: 'numeric' })}
            {text('ParentIndexNumber', item.Type === 'Audio' ? t('Disc number') : t('Season number'), { inputMode: 'numeric' })}
            {text('AirsBeforeSeasonNumber', t('Airs before season'), { inputMode: 'numeric' })}
            {text('AirsAfterSeasonNumber', t('Airs after season'), { inputMode: 'numeric' })}
            {text('AirsBeforeEpisodeNumber', t('Airs before episode'), { inputMode: 'numeric' })}
            {text('Album', 'Album')}
            {text('CommunityRating', t('Community rating (0–10)'), { inputMode: 'decimal' })}
            {text('CriticRating', t('Critic rating (0–100)'), { inputMode: 'decimal' })}
            {select('OfficialRating', t('Parental rating'), ratings)}
            {select('CustomRating', t('Custom rating'), ratings)}
            {text('PremiereDate', item.Type === 'Person' ? t('Birth date') : t('Release date'), { type: 'date' })}
            {text('EndDate', item.Type === 'Person' ? t('Death date') : t('End date'), { type: 'date' })}
            {text('DateCreated', t('Date added'), { type: 'date' })}
            {text('ProductionYear', 'Year', { inputMode: 'numeric' })}
            {select('Status', 'Status', [ [ '', 'Unknown' ], ...SERIES_STATUSES.map(status => [ status, status ] as [string, string]) ])}
            {text('AirTime', t('Air time'))}
            {select('DisplayOrder', t('Display order'), DISPLAY_ORDERS[item.Type || ''] || [])}
            {select('Video3DFormat', '3D format', VIDEO_3D_FORMATS)}
            {text('AspectRatio', t('Aspect ratio'))}
            {select('PreferredMetadataLanguage', t('Metadata language'), languages)}
            {select('PreferredMetadataCountryCode', t('Metadata country'), countries)}
            {info.ContentTypeOptions.length > 0 && full.IsFolder && <label class="md-field">{t('Content type')}<select value={contentType} disabled={busy} onChange={event => { setContentTypeDraft(event.currentTarget.value); setMessage(''); }}>
                {info.ContentTypeOptions.map(option => <option key={option.Value} value={option.Value}>{option.Name}</option>)}</select></label>}
        </div>
        {has('Overview') && <label class="md-field">{t('Overview')}<textarea rows={5} value={draft.Overview} disabled={busy} maxLength={20000} onInput={event => set('Overview', event.currentTarget.value)} /></label>}
        {has('AirDays') && <fieldset class="md-field"><legend>{t('Air days')}</legend><div class="md-checks">{WEEK_DAYS.map(day =>
            <label key={day}><input type="checkbox" checked={draft.AirDays.includes(day)} disabled={busy} onChange={event => set('AirDays', event.currentTarget.checked ? [ ...draft.AirDays, day ] : draft.AirDays.filter(entry => entry !== day))} />{day}</label>)}</div></fieldset>}
        {has('Genres') && <ChipList label={t('Genres')} values={draft.Genres} disabled={busy} onChange={values => set('Genres', values)} />}
        {has('Tags') && <ChipList label={t('Tags')} values={draft.Tags} disabled={busy} onChange={values => set('Tags', values)} />}
        {has('Studios') && <ChipList label={t('Studios')} values={draft.Studios} disabled={busy} onChange={values => set('Studios', values)} />}
        {has('AlbumArtists') && <ChipList label={t('Album artists')} values={draft.AlbumArtists} disabled={busy} onChange={values => set('AlbumArtists', values)} />}
        {has('Artists') && <ChipList label={t('Artists')} values={draft.Artists} disabled={busy} onChange={values => set('Artists', values)} />}
        {has('People') && <fieldset class="md-field md-people"><legend>{t('Cast & crew')}</legend>
            {draft.People.length === 0 && <p class="md-note">{t('No people.')}</p>}
            {draft.People.map((person, index) => <div key={index} class="md-person">
                <input aria-label={t('Person {0} name', index + 1)} value={person.Name} disabled={busy} maxLength={300} onInput={event => set('People', draft.People.map((entry, at) => at === index ? { ...entry, Name: event.currentTarget.value } : entry))} />
                <select aria-label={t('Person {0} type', index + 1)} value={person.Type} disabled={busy} onChange={event => set('People', draft.People.map((entry, at) => at === index ? { ...entry, Type: event.currentTarget.value } : entry))}>
                    {(PERSON_TYPES.includes(person.Type) ? PERSON_TYPES : [ person.Type, ...PERSON_TYPES ]).map(type => <option key={type} value={type}>{t(type)}</option>)}</select>
                <input aria-label={t('Person {0} role', index + 1)} placeholder={t('Role')} value={person.Role} disabled={busy} maxLength={300} onInput={event => set('People', draft.People.map((entry, at) => at === index ? { ...entry, Role: event.currentTarget.value } : entry))} />
                <button type="button" class="md-btn" aria-label={`Remove ${person.Name || t('person')}`} disabled={busy} onClick={() => set('People', draft.People.filter((_, at) => at !== index))}>{t('Remove')}</button>
            </div>)}
            <button type="button" class="md-btn" disabled={busy || draft.People.length >= 500} onClick={() => set('People', [ ...draft.People, { Name: '', Type: 'Actor', Role: '' } ])}>{t('Add person')}</button>
        </fieldset>}
        {has('ProviderIds') && providerKeys.length > 0 && <fieldset class="md-field"><legend>{t('External IDs')}</legend><div class="md-grid">{providerKeys.map(key => {
            const meta = info.ExternalIdInfos.find(entry => entry.Key === key);
            const value = draft.ProviderIds[key] || '';
            const link = meta?.UrlFormatString && value ? meta.UrlFormatString.replace('{0}', encodeURIComponent(value)) : '';
            return <label key={key} class="md-field">{meta ? `${meta.Name}${meta.Type ? ` (${meta.Type})` : ''}` : key}
                <span class="md-inline"><input value={value} disabled={busy} maxLength={200} onInput={event => set('ProviderIds', { ...draft.ProviderIds, [key]: event.currentTarget.value })} />
                    {link && hostSupports('externallinks') && <a class="md-btn" href={link} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); openExternalUrl(link); }}>{t('Open')}</a>}</span></label>;
        })}</div></fieldset>}
        {has('LockData') && <label class="md-check"><input type="checkbox" checked={draft.LockData} disabled={busy} onChange={event => set('LockData', event.currentTarget.checked)} />{t('Lock this item to prevent future metadata changes')}</label>}
        {has('LockedFields') && !draft.LockData && <fieldset class="md-field"><legend>{t('Locked fields')}</legend><div class="md-checks">{LOCKABLE_FIELDS.map(([ id, label ]) =>
            <label key={id}><input type="checkbox" checked={draft.LockedFields.includes(id)} disabled={busy} onChange={event => set('LockedFields', event.currentTarget.checked ? [ ...draft.LockedFields, id ] : draft.LockedFields.filter(field => field !== id))} />{t(label)}</label>)}</div></fieldset>}
        <Status error={error} message={message} />
        <div class="md-inline md-footer">
            <button type="submit" class="md-btn primary" disabled={busy || !dirty}>{busy ? t('Saving…') : t('Save metadata')}</button>
            <button type="button" class="md-btn" disabled={busy || !dirty} onClick={() => { setDraft(original); setContentTypeDraft(info.ContentType || ''); setError(''); }}>{t('Discard')}</button>
        </div>
    </form>;
}

/* ---------- Images ---------- */

function ImagesPanel({ api, item, onChanged }: { api: JellyfinApi; item: MediaItem; onChanged: () => void }) {
    const guard = useGuard(api);
    const types = imageTypesFor(item);
    const [images, setImages] = useState<ImageInfo[] | null>(null);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [uploadType, setUploadType] = useState(types[0]);
    const fileInput = useRef<HTMLInputElement>(null);
    const [remoteType, setRemoteType] = useState(types[0]);
    const [provider, setProvider] = useState('');
    const [allLanguages, setAllLanguages] = useState(false);
    const [remote, setRemote] = useState<{ images: RemoteImage[]; total: number; providers: string[] } | null>(null);

    const load = async () => {
        const live = guard();
        try {
            const next = await getImages(api, item.Id);
            if (live()) setImages(next);
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('Loading images')));
        }
    };
    useEffect(() => { void load(); }, [api, item.Id]);

    const run = async (work: () => Promise<void>, done: string, action: string) => {
        const live = guard();
        setBusy(true); setError(''); setMessage('');
        try {
            await work();
            if (!live()) return;
            setMessage(done);
            await load();
            onChanged();
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, action));
        } finally {
            if (live()) setBusy(false);
        }
    };

    const upload = async () => {
        const file = fileInput.current?.files?.[0];
        if (!file) { setError(t('Choose an image file first.')); return; }
        const problem = validateImageFile(file);
        if (problem) { setError(problem); setMessage(''); return; }
        await run(async () => uploadImage(api, item.Id, uploadType, file.type, await readFileAsBase64(file)), t('{0} image uploaded.', uploadType), t('Uploading the image'));
        if (fileInput.current) fileInput.current.value = '';
    };

    const searchRemote = async (startIndex: number) => {
        const live = guard();
        setBusy(true); setError(''); setMessage('');
        try {
            const result = await getRemoteImages(api, item.Id, { type: remoteType, startIndex, limit: 30, providerName: provider || undefined, includeAllLanguages: allLanguages });
            if (!live()) return;
            setRemote(current => ({ images: startIndex && current ? [ ...current.images, ...result.Images ] : result.Images, total: result.TotalRecordCount, providers: result.Providers.length ? result.Providers : current?.providers || [] }));
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('Searching online images')));
        } finally {
            if (live()) setBusy(false);
        }
    };

    return <div class="md-panel">
        <Status error={error} message={message} />
        {images === null && !error && <p class="md-note" role="status">{t('Loading images…')}</p>}
        {images && types.map(type => {
            const ofType = images.filter(image => image.ImageType === type).sort((a, b) => a.ImageIndex - b.ImageIndex);
            return <section key={type} class="md-image-group">
                <h3>{type}</h3>
                {ofType.length === 0 ? <p class="md-note">{t('None')}</p> : <div class="md-image-row">{ofType.map((image, position) => <figure key={`${type}-${image.ImageIndex}`} class="md-image">
                    <img src={itemImageUrl(api, item.Id, image)} alt={t('{0} image {1}', type, position + 1)} loading="lazy" />
                    <figcaption>{image.Width && image.Height ? `${image.Width}×${image.Height}` : t('Unknown size')}</figcaption>
                    <div class="md-inline">
                        {type === 'Backdrop' && position > 0 && <button type="button" class="md-btn" disabled={busy} aria-label={t('Move backdrop {0} earlier', position + 1)} onClick={() => void run(() => moveImage(api, item.Id, type, image.ImageIndex, image.ImageIndex - 1), t('Backdrop moved.'), t('Moving the image'))}><span class="dir-arrow" aria-hidden="true">←</span></button>}
                        {type === 'Backdrop' && position < ofType.length - 1 && <button type="button" class="md-btn" disabled={busy} aria-label={t('Move backdrop {0} later', position + 1)} onClick={() => void run(() => moveImage(api, item.Id, type, image.ImageIndex, image.ImageIndex + 1), t('Backdrop moved.'), t('Moving the image'))}><span class="dir-arrow" aria-hidden="true">→</span></button>}
                        <ConfirmAction label={t('Delete')} danger disabled={busy} onConfirm={() => run(() => deleteImage(api, item.Id, type, image.ImageIndex), t('{0} image deleted.', type), t('Deleting the image'))} />
                    </div>
                </figure>)}</div>}
            </section>;
        })}
        {hostSupports('fileinput') && <section class="md-image-group">
            <h3>{t('Upload')}</h3>
            <div class="md-inline md-wrap">
                <label class="md-field">{t('Image type')}<select value={uploadType} disabled={busy} onChange={event => setUploadType(event.currentTarget.value)}>{types.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
                <label class="md-field">{t('File')}<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy} onChange={() => { setError(''); setMessage(''); }} /></label>
                <button type="button" class="md-btn primary" disabled={busy} onClick={() => void upload()}>{t('Upload')}</button>
            </div>
            <p class="md-note">{t('JPEG, PNG, WebP or GIF, up to 15 MB. Uploading replaces the current image of that type (backdrops are added).')}</p>
        </section>}
        <section class="md-image-group">
            <h3>{t('Search online')}</h3>
            <div class="md-inline md-wrap">
                <label class="md-field">{t('Image type')}<select value={remoteType} disabled={busy} onChange={event => { setRemoteType(event.currentTarget.value); setRemote(null); }}>{types.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
                <label class="md-field">{t('Provider')}<select value={provider} disabled={busy} onChange={event => { setProvider(event.currentTarget.value); setRemote(null); }}><option value="">{t('All providers')}</option>{(remote?.providers || []).map(name => <option key={name} value={name}>{name}</option>)}</select></label>
                <label class="md-check"><input type="checkbox" checked={allLanguages} disabled={busy} onChange={event => { setAllLanguages(event.currentTarget.checked); setRemote(null); }} />{t('All languages')}</label>
                <button type="button" class="md-btn" disabled={busy} onClick={() => void searchRemote(0)}>{t('Search')}</button>
            </div>
            {remote && (remote.images.length === 0 ? <p class="md-note">{t('No online images found.')}</p> : <>
                <div class="md-remote-grid">{remote.images.map(image => <figure key={image.Url} class="md-image">
                    <img src={image.ThumbnailUrl || image.Url} alt="" loading="lazy" referrerpolicy="no-referrer" />
                    <figcaption>{[ image.ProviderName, image.Width && image.Height ? `${image.Width}×${image.Height}` : '', image.Language, image.CommunityRating ? `★ ${image.CommunityRating.toFixed(1)}` : '' ].filter(Boolean).join(' · ')}</figcaption>
                    <button type="button" class="md-btn" disabled={busy} onClick={() => void run(() => downloadRemoteImage(api, item.Id, remoteType, image.Url), `${remoteType} image set from ${image.ProviderName}.`, t('Downloading the image'))}>{t('Use this image')}</button>
                </figure>)}</div>
                {remote.images.length < remote.total && <button type="button" class="md-btn" disabled={busy} onClick={() => void searchRemote(remote.images.length)}>{t('More images')}</button>}
            </>)}
            <p class="md-note">{t('Online thumbnails load directly from the image provider.')}</p>
        </section>
    </div>;
}

/* ---------- Identify ---------- */

function IdentifyPanel({ api, item, onChanged }: { api: JellyfinApi; item: MediaItem; onChanged: () => void }) {
    const guard = useGuard(api);
    const type = identifyType(item);
    const [info, setInfo] = useState<MetadataEditorInfo | null>(null);
    const [name, setName] = useState(item.Name || '');
    const [year, setYear] = useState(item.ProductionYear ? String(item.ProductionYear) : '');
    const [ids, setIds] = useState<Record<string, string>>({});
    const [results, setResults] = useState<RemoteSearchResult[] | null>(null);
    const [chosen, setChosen] = useState<RemoteSearchResult | null>(null);
    const [replaceImages, setReplaceImages] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');

    useEffect(() => {
        const live = guard();
        Promise.all([ getEditorInfo(api, item.Id), getFullItem(api, item.Id) ]).then(([ editor, full ]) => {
            if (!live()) return;
            setInfo(editor);
            setIds({ ...(full.ProviderIds || {}) });
        }).catch(cause => { if (live()) setError(metadataErrorMessage(cause, t('Loading identify options'))); });
    }, [api, item.Id]);

    if (!type) return <p class="md-note">{t('This kind of item cannot be identified.')}</p>;
    const search = async () => {
        if (!name.trim() && !Object.values(ids).some(value => value.trim())) { setError(t('Enter a name or an external ID.')); return; }
        const live = guard();
        setBusy(true); setError(''); setMessage(''); setChosen(null);
        try {
            const next = await remoteSearch(api, type, identifyQuery(item, { name, year, providerIds: ids }));
            if (live()) setResults(next);
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('The search')));
        } finally {
            if (live()) setBusy(false);
        }
    };
    const apply = async (result: RemoteSearchResult) => {
        const live = guard();
        setBusy(true); setError('');
        try {
            await applyRemoteSearch(api, item.Id, result, replaceImages);
            if (!live()) return;
            setMessage(t('Identified as “{0}”. Metadata is refreshing on the server.', result.Name));
            setChosen(null); setResults(null);
            onChanged();
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('Applying the match')));
        } finally {
            if (live()) setBusy(false);
        }
    };
    const idInfos = (info?.ExternalIdInfos || []).filter(entry => !entry.Type || entry.Type === type || [ 'Movie', 'Series', 'BoxSet', 'Person', 'Album', 'AlbumArtist', 'Artist', 'Book', 'Track' ].includes(entry.Type));
    return <div class="md-panel">
        <form class="md-form" onSubmit={event => { event.preventDefault(); void search(); }}>
            <div class="md-grid">
                <label class="md-field">{t('Name')}<input value={name} disabled={busy} maxLength={300} onInput={event => setName(event.currentTarget.value)} /></label>
                {type !== 'Person' && <label class="md-field">{t('Year')}<input value={year} inputMode="numeric" maxLength={4} disabled={busy} onInput={event => setYear(event.currentTarget.value)} /></label>}
                {idInfos.map(entry => <label key={entry.Key} class="md-field">{entry.Name}<input value={ids[entry.Key] || ''} disabled={busy} maxLength={200} onInput={event => setIds({ ...ids, [entry.Key]: event.currentTarget.value })} /></label>)}
            </div>
            <button type="submit" class="md-btn primary" disabled={busy}>{busy && !chosen ? t('Searching…') : t('Search')}</button>
        </form>
        <Status error={error} message={message} />
        {results && (results.length === 0 ? <p class="md-note">{t('No matches found. Try a different name or year.')}</p> : <ul class="md-results">{results.map((result, index) => <li key={`${result.SearchProviderName}-${index}`} class={chosen === result ? 'on' : ''}>
            {result.ImageUrl ? <img src={result.ImageUrl} alt="" loading="lazy" referrerpolicy="no-referrer" /> : <span class="md-result-placeholder" aria-hidden="true" />}
            <div>
                <strong>{result.Name}</strong>{result.ProductionYear ? ` (${result.ProductionYear})` : ''}
                <p class="md-note">{result.SearchProviderName || t('Unknown provider')}</p>
                {result.Overview && <p class="md-overview">{result.Overview.slice(0, 280)}{result.Overview.length > 280 ? '…' : ''}</p>}
                {chosen === result
                    ? <div class="md-confirm">
                        <label class="md-check"><input type="checkbox" checked={replaceImages} disabled={busy} onChange={event => setReplaceImages(event.currentTarget.checked)} />{t('Replace existing images')}</label>
                        <button type="button" class="md-btn primary" disabled={busy} onClick={() => void apply(result)}>{busy ? t('Applying…') : t('Apply this match')}</button>
                        <button type="button" class="md-btn" disabled={busy} onClick={() => setChosen(null)}>{t('Cancel')}</button>
                    </div>
                    : <button type="button" class="md-btn" disabled={busy} onClick={() => setChosen(result)}>{t('Choose')}</button>}
            </div>
        </li>)}</ul>)}
    </div>;
}

/* ---------- Refresh ---------- */

function RefreshPanel({ api, item, onChanged }: { api: JellyfinApi; item: MediaItem; onChanged: () => void }) {
    const guard = useGuard(api);
    const [mode, setMode] = useState<RefreshMode>('missing');
    const [replaceImages, setReplaceImages] = useState(false);
    const [trickplay, setTrickplay] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const video = item.MediaType === 'Video';
    const start = async () => {
        const live = guard();
        setBusy(true); setError(''); setMessage('');
        try {
            await refreshItem(api, item.Id, refreshOptions(mode, replaceImages, video && trickplay));
            if (!live()) return;
            setMessage(t('Refresh started. Changes appear once the server finishes.'));
            onChanged();
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('The refresh')));
        } finally {
            if (live()) setBusy(false);
        }
    };
    const option = (value: RefreshMode, label: string, note: string) => <label class="md-radio"><input type="radio" name="md-refresh-mode" value={value} checked={mode === value} disabled={busy} onChange={() => setMode(value)} /><span><strong>{t(label)}</strong><span class="md-note">{note}</span></span></label>;
    return <div class="md-panel">
        <fieldset class="md-field"><legend>{t('Refresh mode')}</legend>
            {option('scan', t('Scan for new and updated files'), t('Looks for file changes without contacting metadata providers.'))}
            {option('missing', t('Search for missing metadata'), t('Fills in empty fields and missing images.'))}
            {option('all', t('Replace all metadata'), t('Overwrites existing metadata with provider data, except locked fields.'))}
        </fieldset>
        <label class="md-check"><input type="checkbox" checked={replaceImages} disabled={busy || mode === 'scan'} onChange={event => setReplaceImages(event.currentTarget.checked)} />{t('Replace existing images')}</label>
        {video && <label class="md-check"><input type="checkbox" checked={trickplay} disabled={busy} onChange={event => setTrickplay(event.currentTarget.checked)} />{t('Regenerate trickplay images')}</label>}
        <Status error={error} message={message} />
        <button type="button" class="md-btn primary" disabled={busy} onClick={() => void start()}>{busy ? t('Starting…') : t('Start refresh')}</button>
    </div>;
}

/* ---------- Subtitles ---------- */

function SubtitlesPanel({ api, item, user, onChanged }: { api: JellyfinApi; item: MediaItem; user: JellyfinUser | null; onChanged: () => void }) {
    const guard = useGuard(api);
    const admin = user?.Policy?.IsAdministrator === true;
    const [streams, setStreams] = useState<NonNullable<MediaItem['MediaStreams']> | null>(null);
    const [cultures, setCultures] = useState<Culture[]>([]);
    const [language, setLanguage] = useState(() => (user?.Configuration?.SubtitleLanguagePreference || 'eng').slice(0, 3));
    const [perfect, setPerfect] = useState(false);
    const [results, setResults] = useState<RemoteSubtitle[] | null>(null);
    const [uploadLanguage, setUploadLanguage] = useState(language);
    const [forced, setForced] = useState(false);
    const [hearingImpaired, setHearingImpaired] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');

    const load = async () => {
        const live = guard();
        try {
            const full = await getFullItem(api, item.Id);
            if (live()) setStreams((full.MediaStreams || full.MediaSources?.[0]?.MediaStreams || []).filter(stream => stream.Type === 'Subtitle'));
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('Loading subtitles')));
        }
    };
    useEffect(() => {
        void load();
        const live = guard();
        api.getCultures().then(next => { if (live()) setCultures(next); }).catch(() => undefined);
    }, [api, item.Id]);

    const run = async (work: () => Promise<void>, done: string, action: string) => {
        const live = guard();
        setBusy(true); setError(''); setMessage('');
        try {
            await work();
            if (!live()) return;
            setMessage(done);
            await load();
            onChanged();
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, action));
        } finally {
            if (live()) setBusy(false);
        }
    };
    const search = async () => {
        const live = guard();
        setBusy(true); setError(''); setMessage('');
        try {
            const next = await searchSubtitles(api, item.Id, language, perfect);
            if (live()) setResults(next);
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('The subtitle search')));
        } finally {
            if (live()) setBusy(false);
        }
    };
    const upload = async () => {
        const file = fileInput.current?.files?.[0];
        if (!file) { setError(t('Choose a subtitle file first.')); return; }
        const problem = validateSubtitleFile(file);
        if (problem) { setError(problem); setMessage(''); return; }
        await run(async () => uploadSubtitle(api, item.Id, { Language: uploadLanguage, Format: fileExtension(file.name), IsForced: forced, IsHearingImpaired: hearingImpaired, Data: await readFileAsBase64(file) }), t('Subtitle uploaded.'), t('Uploading the subtitle'));
        if (fileInput.current) fileInput.current.value = '';
    };
    const languageOptions = cultures.length ? cultures.map(culture => <option key={culture.ThreeLetterISOLanguageName} value={culture.ThreeLetterISOLanguageName}>{culture.DisplayName}</option>) : <option value={language}>{language}</option>;

    return <div class="md-panel">
        <Status error={error} message={message} />
        <section class="md-image-group"><h3>{t('Current subtitles')}</h3>
            {streams === null ? <p class="md-note" role="status">{t('Loading…')}</p> : streams.length === 0 ? <p class="md-note">{t('This item has no subtitles.')}</p> : <ul class="md-list">{streams.map(stream => <li key={stream.Index}>
                <span>{stream.DisplayTitle || stream.Title || stream.Language || t('Subtitle')}{stream.Codec ? ` · ${stream.Codec}` : ''}{stream.IsExternal ? t(' · External') : t(' · Embedded')}{stream.IsForced ? t(' · Forced') : ''}</span>
                {admin && stream.IsExternal && typeof stream.Index === 'number' && <ConfirmAction label={t('Delete')} danger disabled={busy} onConfirm={() => run(() => deleteSubtitle(api, item.Id, stream.Index!), t('Subtitle deleted.'), t('Deleting the subtitle'))} />}
            </li>)}</ul>}
        </section>
        <section class="md-image-group"><h3>{t('Search online')}</h3>
            <div class="md-inline md-wrap">
                <label class="md-field">{t('Language')}<select value={language} disabled={busy} onChange={event => { setLanguage(event.currentTarget.value); setResults(null); }}>{languageOptions}</select></label>
                <label class="md-check"><input type="checkbox" checked={perfect} disabled={busy} onChange={event => setPerfect(event.currentTarget.checked)} />{t('Only perfect matches')}</label>
                <button type="button" class="md-btn" disabled={busy} onClick={() => void search()}>{t('Search')}</button>
            </div>
            {results && (results.length === 0 ? <p class="md-note">{t('No subtitles found.')}</p> : <ul class="md-list">{results.map(result => <li key={result.Id}>
                <span><strong>{result.Name}</strong><span class="md-note">{[ result.ProviderName, result.Format, result.CommunityRating ? `★ ${result.CommunityRating.toFixed(1)}` : '', result.DownloadCount ? `${result.DownloadCount} downloads` : '', result.IsHashMatch ? 'Exact file match' : '', result.Forced ? 'Forced' : '', result.HearingImpaired ? 'Hearing impaired' : '' ].filter(Boolean).join(' · ')}</span></span>
                <ConfirmAction label={t('Download')} confirmLabel={t('Download subtitle')} disabled={busy} onConfirm={() => run(() => downloadSubtitle(api, item.Id, result.Id), `Downloaded “${result.Name}”.`, t('Downloading the subtitle'))} />
            </li>)}</ul>)}
        </section>
        {hostSupports('fileinput') && <section class="md-image-group"><h3>{t('Upload')}</h3>
            <div class="md-inline md-wrap">
                <label class="md-field">{t('Language')}<select value={uploadLanguage} disabled={busy} onChange={event => setUploadLanguage(event.currentTarget.value)}>{languageOptions}</select></label>
                <label class="md-check"><input type="checkbox" checked={forced} disabled={busy} onChange={event => setForced(event.currentTarget.checked)} />{t('Forced')}</label>
                <label class="md-check"><input type="checkbox" checked={hearingImpaired} disabled={busy} onChange={event => setHearingImpaired(event.currentTarget.checked)} />{t('Hearing impaired')}</label>
                <label class="md-field">{t('File')}<input ref={fileInput} type="file" accept=".srt,.ass,.ssa,.vtt,.sub" disabled={busy} onChange={() => { setError(''); setMessage(''); }} /></label>
                <button type="button" class="md-btn primary" disabled={busy} onClick={() => void upload()}>{t('Upload')}</button>
            </div>
            <p class="md-note">{t('SRT, ASS, SSA, VTT or SUB, up to 2 MB.')}</p>
        </section>}
    </div>;
}

/* ---------- Lyrics ---------- */

function LyricsPanel({ api, item, onChanged }: { api: JellyfinApi; item: MediaItem; onChanged: () => void }) {
    const guard = useGuard(api);
    const [lines, setLines] = useState<LyricLine[] | null>(null);
    const [results, setResults] = useState<RemoteLyric[] | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');

    const load = async () => {
        const live = guard();
        try {
            const next = await getLyrics(api, item.Id).catch(() => [] as LyricLine[]);
            if (live()) setLines(next);
        } catch {
            if (live()) setLines([]);
        }
    };
    useEffect(() => { void load(); }, [api, item.Id]);

    const run = async (work: () => Promise<unknown>, done: string, action: string) => {
        const live = guard();
        setBusy(true); setError(''); setMessage('');
        try {
            await work();
            if (!live()) return;
            setMessage(done);
            await load();
            onChanged();
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, action));
        } finally {
            if (live()) setBusy(false);
        }
    };
    const search = async () => {
        const live = guard();
        setBusy(true); setError(''); setMessage('');
        try {
            const next = await searchLyrics(api, item.Id);
            if (live()) setResults(next);
        } catch (cause) {
            if (live()) setError(metadataErrorMessage(cause, t('The lyrics search')));
        } finally {
            if (live()) setBusy(false);
        }
    };
    const upload = async () => {
        const file = fileInput.current?.files?.[0];
        if (!file) { setError(t('Choose a lyrics file first.')); return; }
        const problem = validateLyricFile(file);
        if (problem) { setError(problem); setMessage(''); return; }
        await run(async () => uploadLyrics(api, item.Id, file.name, await readFileAsText(file)), t('Lyrics uploaded.'), t('Uploading the lyrics'));
        if (fileInput.current) fileInput.current.value = '';
    };

    return <div class="md-panel">
        <Status error={error} message={message} />
        <section class="md-image-group"><h3>{t('Current lyrics')}</h3>
            {lines === null ? <p class="md-note" role="status">{t('Loading…')}</p> : lines.length === 0 ? <p class="md-note">{t('This track has no lyrics.')}</p> : <>
                <pre class="md-lyrics">{lines.slice(0, 12).map(line => line.Text).join('\n')}{lines.length > 12 ? t('\n… {0} more lines', lines.length - 12) : ''}</pre>
                <ConfirmAction label={t('Delete lyrics')} danger disabled={busy} onConfirm={() => run(() => deleteLyrics(api, item.Id), t('Lyrics deleted.'), t('Deleting the lyrics'))} />
            </>}
        </section>
        <section class="md-image-group"><h3>{t('Search online')}</h3>
            <button type="button" class="md-btn" disabled={busy} onClick={() => void search()}>{t('Search')}</button>
            {results && (results.length === 0 ? <p class="md-note">{t('No lyrics found.')}</p> : <ul class="md-list">{results.map(result => <li key={result.Id}>
                <span><strong>{[ result.Title, result.Artist ].filter(Boolean).join(' — ') || t('Lyrics')}</strong><span class="md-note">{result.ProviderName}{result.Lines.some(line => line.Start !== undefined) ? t(' · Synced') : ''}</span>
                    <pre class="md-lyrics small">{result.Lines.slice(0, 4).map(line => line.Text).join('\n')}</pre></span>
                <ConfirmAction label={t('Download')} confirmLabel={t('Use these lyrics')} disabled={busy} onConfirm={() => run(() => downloadLyrics(api, item.Id, result.Id), t('Lyrics downloaded.'), t('Downloading the lyrics'))} />
            </li>)}</ul>)}
        </section>
        {hostSupports('fileinput') && <section class="md-image-group"><h3>{t('Upload')}</h3>
            <div class="md-inline md-wrap">
                <label class="md-field">{t('File')}<input ref={fileInput} type="file" accept=".lrc,.txt" disabled={busy} onChange={() => { setError(''); setMessage(''); }} /></label>
                <button type="button" class="md-btn primary" disabled={busy} onClick={() => void upload()}>{t('Upload')}</button>
            </div>
            <p class="md-note">{t('LRC or TXT, up to 512 KB. Uploading replaces the current lyrics.')}</p>
        </section>}
    </div>;
}
