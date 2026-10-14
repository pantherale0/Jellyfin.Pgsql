import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { VirtualFolder } from '../types';
import { ConfirmButton, Empty, StatusChip } from '../ui';
import {
    LibraryLoadTracker, buildLibraryOptionsPayload, canSaveLibraryDraft, cloneLibraryOptions, libraryFieldVisibility, moveEntry,
    readDisabledList, readLocalReaders, readMetadataSavers, readTypeFetchers,
    writeDisabledList, writeLocalReaders, writeMetadataSavers, writeTypeFetchers,
    type AvailableLibraryOptions, type DisabledListKind, type LibraryDraftStatus, type LibraryOptionInfo, type LibraryOptions, type PluginEntry, type TypeFetcherKind,
} from '../library-options';

type Culture = { DisplayName?: string; TwoLetterISOLanguageName?: string; ThreeLetterISOLanguageName?: string };
type Country = { DisplayName?: string; TwoLetterISORegionName?: string };

export interface LibraryIdentity { itemId: string; name: string; collectionType?: string }

function errorText(e: unknown, fallback: string): string {
    return e instanceof Error && e.message ? e.message : fallback;
}

function PluginOrderList({ title, entries, onChange, orderable = true, hint }: { title: string; entries: PluginEntry[]; onChange: (entries: PluginEntry[]) => void; orderable?: boolean; hint?: string }) {
    if (!entries.length) return null;
    return <fieldset class="ad-plugin-list">
        <legend>{title}</legend>
        {hint && <p class="ad-note">{hint}</p>}
        {entries.map((entry, index) => <div class="ad-plugin-row" key={entry.name}>
            <label><input type="checkbox" checked={entry.enabled} onChange={e => { const checked = e.currentTarget.checked; onChange(entries.map((row, i) => i === index ? { ...row, enabled: checked } : row)); }} /><span>{entry.name}</span></label>
            {orderable && <span class="ad-plugin-move">
                <button type="button" class="ad-btn" disabled={index === 0} aria-label={`Move ${entry.name} up in ${title}`} onClick={() => onChange(moveEntry(entries, index, -1))}>↑</button>
                <button type="button" class="ad-btn" disabled={index === entries.length - 1} aria-label={`Move ${entry.name} down in ${title}`} onClick={() => onChange(moveEntry(entries, index, 1))}>↓</button>
            </span>}
        </div>)}
    </fieldset>;
}

export function AdminLibraryEditor({ api, library, onClose, onChanged, onRenamed }: {
    api: AdminApi;
    library: LibraryIdentity;
    onClose: () => void;
    onChanged: () => void;
    onRenamed: (newName: string) => void;
}) {
    const tracker = useRef(new LibraryLoadTracker());
    const drawerRef = useRef<HTMLElement>(null);
    const [status, setStatus] = useState<LibraryDraftStatus>('loading');
    const [folder, setFolder] = useState<VirtualFolder | null>(null);
    const [draft, setDraft] = useState<LibraryOptions>({});
    const [draftId, setDraftId] = useState<string>();
    const [dirty, setDirty] = useState(false);
    const [available, setAvailable] = useState<AvailableLibraryOptions>({});
    const [cultures, setCultures] = useState<Culture[]>([]);
    const [countries, setCountries] = useState<Country[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [newName, setNewName] = useState(library.name);
    const [newPath, setNewPath] = useState('');
    const [languageFilter, setLanguageFilter] = useState('');

    const findFolder = async (): Promise<VirtualFolder | undefined> => (await api.getVirtualFolders()).find(row => row.ItemId === library.itemId);

    useEffect(() => {
        const token = tracker.current.begin(library.itemId);
        setStatus('loading'); setDraftId(undefined); setDirty(false); setError(''); setMessage('');
        Promise.all([
            findFolder(),
            api.getAvailableLibraryOptions(library.collectionType),
            api.getCultures().catch(() => []),
            api.getCountries().catch(() => []),
        ]).then(([row, options, cultureRows, countryRows]) => {
            if (!tracker.current.isCurrent(token, library.itemId)) return;
            if (!row) { setStatus('error'); setError('This library no longer exists. It may have been renamed or removed.'); return; }
            setFolder(row);
            setDraft(cloneLibraryOptions(row.LibraryOptions));
            setDraftId(library.itemId);
            setAvailable(options || {});
            setCultures(cultureRows);
            setCountries(countryRows);
            setStatus('ready');
        }).catch(e => {
            if (!tracker.current.isCurrent(token, library.itemId)) return;
            setStatus('error');
            setError(errorText(e, 'Library settings could not be loaded.'));
        });
        return () => tracker.current.cancel();
    }, [api, library.itemId]);

    useEffect(() => {
        const drawer = drawerRef.current;
        if (!drawer) return;
        const previous = document.activeElement as HTMLElement | null;
        drawer.querySelector<HTMLButtonElement>('button')?.focus();
        const keyboard = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(); }
            if (event.key === 'Tab') {
                const controls = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')).filter(el => el.getClientRects().length);
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        };
        drawer.addEventListener('keydown', keyboard);
        return () => { drawer.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
    }, []);

    const visible = libraryFieldVisibility(library.collectionType);
    const ready = status === 'ready' && draftId === library.itemId;
    const canSave = canSaveLibraryDraft(status, draftId, library.itemId, busy) && dirty;
    const update = (next: LibraryOptions) => { setDraft(next); setDirty(true); setMessage(''); };
    const set = (key: string, value: unknown) => update({ ...draft, [key]: value });
    const toggle = (key: string, label: string, help?: string) => <label class="ad-policy-row" key={key}>
        <span>{label}{help && <span class="ad-cell-sub">{help}</span>}</span>
        <input type="checkbox" checked={draft[key] === true} disabled={busy} onChange={e => set(key, e.currentTarget.checked)} />
    </label>;

    const runPathChange = async (change: () => Promise<void>, done: string) => {
        const token = tracker.current.begin(library.itemId);
        setBusy(true); setError(''); setMessage('');
        try {
            await change();
            const row = await findFolder();
            if (!tracker.current.isCurrent(token, library.itemId)) return;
            if (row) setFolder(row);
            setMessage(done);
            onChanged();
        } catch (e) {
            if (tracker.current.isCurrent(token, library.itemId)) setError(errorText(e, 'The folder change failed.'));
        } finally {
            if (tracker.current.isCurrent(token, library.itemId)) setBusy(false);
        }
    };

    const save = async () => {
        if (!canSaveLibraryDraft(status, draftId, library.itemId, busy)) return;
        const token = tracker.current.begin(library.itemId);
        setBusy(true); setError(''); setMessage('');
        try {
            const latest = await findFolder();
            if (!latest) throw new Error('This library no longer exists. It may have been renamed or removed.');
            await api.updateLibraryOptions(library.itemId, buildLibraryOptionsPayload(draft, latest.LibraryOptions));
            if (!tracker.current.isCurrent(token, library.itemId)) return;
            setDirty(false);
            setMessage('Library settings saved. Run a scan or metadata refresh to apply them to existing items.');
            onChanged();
        } catch (e) {
            if (tracker.current.isCurrent(token, library.itemId)) setError(errorText(e, 'Library settings could not be saved.'));
        } finally {
            if (tracker.current.isCurrent(token, library.itemId)) setBusy(false);
        }
    };

    const rename = async () => {
        const target = newName.trim();
        if (!target || target === library.name) return;
        setBusy(true); setError(''); setMessage('');
        try {
            await api.renameLibrary(library.name, target);
            tracker.current.cancel();
            onRenamed(target);
        } catch (e) {
            setError(errorText(e, 'The library could not be renamed. The name may already be in use.'));
            setBusy(false);
        }
    };

    const close = () => { if (!dirty || window.confirm('Discard unsaved library settings?')) onClose(); };

    const subtitleLanguages: string[] = draft.SubtitleDownloadLanguages || [];
    const languageOptions = useMemo(() => {
        const needle = languageFilter.trim().toLowerCase();
        return cultures
            .filter(c => c.ThreeLetterISOLanguageName)
            .filter(c => !needle || (c.DisplayName || '').toLowerCase().includes(needle) || subtitleLanguages.includes(c.ThreeLetterISOLanguageName!));
    }, [cultures, languageFilter, subtitleLanguages.join(',')]);

    const typeFetchers = (kind: TypeFetcherKind) => (available.TypeOptions || [])
        .filter(row => row.Type && (row[`${kind}Fetchers`] || []).length)
        .map(row => <PluginOrderList key={`${kind}-${row.Type}`} title={`${kind === 'Metadata' ? 'Metadata downloaders' : 'Image fetchers'} · ${row.Type}`}
            entries={readTypeFetchers(row, draft, kind)} onChange={entries => update(writeTypeFetchers(draft, row.Type!, kind, entries))} />);
    const disabledList = (kind: DisabledListKind, title: string, plugins: LibraryOptionInfo[] | undefined) =>
        <PluginOrderList title={title} entries={readDisabledList(plugins, draft, kind)} onChange={entries => update(writeDisabledList(draft, kind, entries))} />;

    const paths = folder?.LibraryOptions?.PathInfos?.map(p => p.Path || '').filter(Boolean) || folder?.Locations || [];

    return <div class="ad-drawer-backdrop" onClick={close}>
        <aside ref={drawerRef} class="ad-drawer ad-library-editor" role="dialog" aria-modal="true" aria-labelledby="admin-library-editor-title" aria-busy={status === 'loading' || busy} onClick={e => e.stopPropagation()}>
            <button class="ad-drawer-close" onClick={close} aria-label="Close library editor">×</button>
            <h2 id="admin-library-editor-title">{library.name}</h2>
            <StatusChip tone="muted">{library.collectionType || 'Mixed'}</StatusChip>
            {error && <p role="alert" class="ad-error">{error}</p>}
            {message && <p role="status" class="ad-note">{message}</p>}
            {status === 'loading' && <Empty muted>Loading library settings…</Empty>}
            {ready && <>
                <h3 class="ad-drawer-section-title">General</h3>
                <form class="ad-flex" onSubmit={e => { e.preventDefault(); void rename(); }}>
                    <label class="ad-field">Library name<input value={newName} disabled={busy} onInput={e => setNewName(e.currentTarget.value)} /></label>
                    <button class="ad-btn" type="submit" disabled={busy || dirty || !newName.trim() || newName.trim() === library.name}>Rename</button>
                </form>
                {dirty && newName.trim() !== library.name && <p class="ad-note">Save or discard settings changes before renaming.</p>}
                {toggle('Enabled', 'Library enabled', 'Disabled libraries are hidden and not scanned.')}

                <h3 class="ad-drawer-section-title">Folders</h3>
                {paths.length ? paths.map(path => <div class="ad-info" key={path}>
                    <span class="ad-path">{path}</span>
                    {paths.length > 1 && <ConfirmButton label="Remove folder" tone="danger" busy={busy} onConfirm={() => runPathChange(() => api.removeLibraryPath(library.name, path), 'Folder removed. Media files were not deleted.')} />}
                </div>) : <Empty muted>No folders configured</Empty>}
                {paths.length <= 1 && <p class="ad-note">A library needs at least one folder. Remove the library instead to clear it.</p>}
                <form class="ad-flex" onSubmit={e => { e.preventDefault(); const value = newPath.trim(); if (!value || paths.includes(value)) return; void runPathChange(() => api.addLibraryPath(library.name, value), 'Folder added. Scan the library to import its contents.').then(() => setNewPath('')); }}>
                    <label class="ad-field">Add server folder path<input value={newPath} disabled={busy} placeholder="/media/movies" onInput={e => setNewPath(e.currentTarget.value)} /></label>
                    <button class="ad-btn" type="submit" disabled={busy || !newPath.trim() || paths.includes(newPath.trim())}>Add folder</button>
                </form>

                <h3 class="ad-drawer-section-title">Metadata</h3>
                <label class="ad-field">Preferred metadata language<select value={draft.PreferredMetadataLanguage || ''} disabled={busy} onChange={e => set('PreferredMetadataLanguage', e.currentTarget.value || null)}>
                    <option value="">Server default</option>
                    {cultures.filter(c => c.TwoLetterISOLanguageName).map(c => <option key={c.TwoLetterISOLanguageName} value={c.TwoLetterISOLanguageName}>{c.DisplayName}</option>)}
                </select></label>
                <label class="ad-field">Country<select value={draft.MetadataCountryCode || ''} disabled={busy} onChange={e => set('MetadataCountryCode', e.currentTarget.value || null)}>
                    <option value="">Server default</option>
                    {countries.filter(c => c.TwoLetterISORegionName).map(c => <option key={c.TwoLetterISORegionName} value={c.TwoLetterISORegionName}>{c.DisplayName}</option>)}
                </select></label>
                <label class="ad-field">Automatically refresh internet metadata<select value={String(draft.AutomaticRefreshIntervalDays || 0)} disabled={busy} onChange={e => set('AutomaticRefreshIntervalDays', Number(e.currentTarget.value))}>
                    <option value="0">Never</option>{[30, 60, 90].map(days => <option key={days} value={String(days)}>Every {days} days</option>)}
                </select></label>
                {visible.seasonZero && <label class="ad-field">Display name for season zero<input value={draft.SeasonZeroDisplayName || ''} disabled={busy} onInput={e => set('SeasonZeroDisplayName', e.currentTarget.value)} /></label>}
                {typeFetchers('Metadata')}
                {typeFetchers('Image')}
                <PluginOrderList title="Local metadata readers" hint="Readers higher in the list take priority." entries={readLocalReaders(available.MetadataReaders, draft)} onChange={entries => update(writeLocalReaders(draft, entries))} />
                <PluginOrderList title="Metadata savers" orderable={false} entries={readMetadataSavers(available.MetadataSavers, draft)} onChange={entries => update(writeMetadataSavers(draft, entries))} />
                {toggle('SaveLocalMetadata', 'Save artwork into media folders', 'Stores images next to media files where possible.')}

                <h3 class="ad-drawer-section-title">Scanning</h3>
                {toggle('EnableRealtimeMonitor', 'Real-time monitoring', 'Detect file changes immediately on supported file systems.')}
                {visible.photos && toggle('EnablePhotos', 'Import photos')}
                {visible.embeddedTitles && toggle('EnableEmbeddedTitles', 'Prefer embedded titles over file names')}
                {visible.embeddedTitles && draft.EnableEmbeddedTitles === true && toggle('EnableEmbeddedExtrasTitles', 'Prefer embedded titles for extras')}
                {visible.embeddedEpisodeInfos && toggle('EnableEmbeddedEpisodeInfos', 'Prefer embedded episode information over file names')}
                {visible.seriesGrouping && toggle('EnableAutomaticSeriesGrouping', 'Merge series spread across multiple folders')}
                {visible.addToCollection && toggle('AutomaticallyAddToCollection', 'Automatically add movies to collections')}
                {visible.lufs && toggle('EnableLUFSScan', 'Enable audio normalization scan')}
                {visible.musicTags && <>
                    {toggle('PreferNonstandardArtistsTag', 'Prefer the non-standard artists tag')}
                    {toggle('UseCustomTagDelimiters', 'Use custom tag delimiters')}
                    {draft.UseCustomTagDelimiters === true && <>
                        <label class="ad-field">Delimiter characters<input value={(draft.CustomTagDelimiters || []).join('')} disabled={busy} onInput={e => set('CustomTagDelimiters', e.currentTarget.value.split(''))} /></label>
                        <label class="ad-field">Delimiter whitelist (one per line)<textarea rows={3} value={(draft.DelimiterWhitelist || []).join('\n')} disabled={busy} onInput={e => set('DelimiterWhitelist', e.currentTarget.value.split('\n').filter(item => item.trim()))} /></label>
                    </>}
                </>}
                {visible.chapters && <>
                    {toggle('EnableTrickplayImageExtraction', 'Extract trickplay images')}
                    {toggle('ExtractTrickplayImagesDuringLibraryScan', 'Extract trickplay images during library scan')}
                    {toggle('SaveTrickplayWithMedia', 'Save trickplay images next to media')}
                    {toggle('EnableChapterImageExtraction', 'Extract chapter images')}
                    {toggle('ExtractChapterImagesDuringLibraryScan', 'Extract chapter images during library scan')}
                </>}
                {disabledList('MediaSegment', 'Media segment providers', available.MediaSegmentProviders)}

                {visible.subtitles && <>
                    <h3 class="ad-drawer-section-title">Subtitles</h3>
                    {visible.embeddedSubtitles && <label class="ad-field">Embedded subtitles<select value={String(draft.AllowEmbeddedSubtitles ?? 'AllowAll')} disabled={busy} onChange={e => set('AllowEmbeddedSubtitles', e.currentTarget.value)}>
                        <option value="AllowAll">Allow all</option><option value="AllowText">Text only</option><option value="AllowImage">Image only</option><option value="AllowNone">None</option>
                    </select></label>}
                    <fieldset class="ad-plugin-list">
                        <legend>Download languages</legend>
                        <input class="ad-search" value={languageFilter} onInput={e => setLanguageFilter(e.currentTarget.value)} placeholder="Filter languages…" aria-label="Filter subtitle languages" />
                        <div class="ad-user-options">{languageOptions.map(c => <label key={c.ThreeLetterISOLanguageName}><input type="checkbox" checked={subtitleLanguages.includes(c.ThreeLetterISOLanguageName!)} disabled={busy} onChange={e => { const checked = e.currentTarget.checked; const code = c.ThreeLetterISOLanguageName!; set('SubtitleDownloadLanguages', checked ? [...subtitleLanguages.filter(v => v !== code), code] : subtitleLanguages.filter(v => v !== code)); }} /> {c.DisplayName}</label>)}</div>
                    </fieldset>
                    {disabledList('Subtitle', 'Subtitle downloaders', available.SubtitleFetchers)}
                    {toggle('SkipSubtitlesIfEmbeddedSubtitlesPresent', 'Skip if the video already has embedded subtitles')}
                    {toggle('SkipSubtitlesIfAudioTrackMatches', 'Skip if the default audio track matches the download language')}
                    {toggle('RequirePerfectSubtitleMatch', 'Only download subtitles that are a perfect match')}
                    {toggle('SaveSubtitlesWithMedia', 'Save subtitles into media folders')}
                </>}

                {visible.lyrics && (available.LyricFetchers || []).length > 0 && <>
                    <h3 class="ad-drawer-section-title">Lyrics</h3>
                    {disabledList('Lyric', 'Lyric downloaders', available.LyricFetchers)}
                    {toggle('SaveLyricsWithMedia', 'Save lyrics into media folders')}
                </>}

                <div class="ad-drawer-actions ad-library-editor-actions">
                    <button class="ad-btn" disabled={!canSave} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button>
                    <button class="ad-btn" disabled={busy || !dirty} onClick={() => { setDraft(cloneLibraryOptions(folder?.LibraryOptions)); setDirty(false); setMessage(''); }}>Discard changes</button>
                </div>
            </>}
        </aside>
    </div>;
}
