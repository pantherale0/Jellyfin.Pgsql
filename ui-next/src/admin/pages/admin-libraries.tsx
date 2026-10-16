import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { LibraryInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, SearchInput, DataTable, ConfirmButton } from '../ui';
import { AdminLibraryEditor, type LibraryIdentity } from './admin-library-editor';
import { isLibraryScanning, libraryStatusLabel, scanPollDelay } from '../admin-state';
import { t } from '../../i18n';

type Counts = { Movies: number; Series: number; Episodes: number; Audio: number; Books: number; Videos: number };

export function AdminLibraries({ adminApi: api }: { adminApi: AdminApi }) {
    const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
    const [counts, setCounts] = useState<Record<string, Counts>>({});
    const [search, setSearch] = useState('');
    const [scanBusy, setScanBusy] = useState(false);
    const [sort, setSort] = useState('Name');
    const [ascending, setAscending] = useState(true);
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState('');
    const [path, setPath] = useState('');
    const [type, setType] = useState('movies');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [refreshMode, setRefreshMode] = useState<'Default' | 'FullRefresh'>('Default');

    const [editing, setEditing] = useState<LibraryIdentity | null>(null);

    const [loadError, setLoadError] = useState('');
    const scanRequestedAt = useRef(0);
    const load = useCallback(async () => {
        let rows: LibraryInfo[];
        try { rows = await api.getLibraries(); setLoadError(''); }
        catch (e) { setLoadError(e instanceof Error ? e.message : t('Libraries could not be loaded.')); return [] as LibraryInfo[]; }
        setLibraries(rows);
        const values = await Promise.all(rows.filter(l => l.ItemId).map(async l => [l.ItemId!, await api.getLibraryCounts(l.ItemId!).catch(() => null)] as const));
        setCounts(Object.fromEntries(values.filter((row): row is readonly [string, Counts] => row[1] !== null)));
        return rows;
    }, [api]);
    const onRenamed = async (newName: string) => {
        setEditing(null);
        const rows = await load();
        const renamed = rows.find(l => l.Name === newName);
        if (renamed?.ItemId) setEditing({ itemId: renamed.ItemId, name: renamed.Name!, collectionType: renamed.CollectionType });
        setMessage(t('Library renamed to {0}.', newName));
    };
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        const delay = scanPollDelay(isLibraryScanning(libraries), scanRequestedAt.current, Date.now());
        if (delay === null) return;
        const timer = window.setTimeout(() => { if (!document.hidden) void load(); else setLibraries(rows => [...rows]); }, delay);
        return () => window.clearTimeout(timer);
    }, [libraries, load]);

    const scanAll = async () => { setScanBusy(true); try { await api.scanAllLibraries(); scanRequestedAt.current = Date.now(); setMessage(t('Scan requested.')); void load(); } catch (e) { setError(e instanceof Error ? e.message : t('Scan request failed.')); } finally { setScanBusy(false); } };
    const rows = libraries.map(l => ({ library: l, counts: l.ItemId ? counts[l.ItemId] : undefined }));
    const columns = [
        { key: 'Name', label: t('Library'), value: (r: typeof rows[number]) => <><strong>{r.library.Name}</strong><div class="ad-cell-sub">{r.library.CollectionType || t('Mixed')}</div></>, searchValue: (r: typeof rows[number]) => `${r.library.Name || ''} ${r.library.CollectionType || ''}` },
        { key: 'Items', label: t('Items'), value: (r: typeof rows[number]) => r.counts ? (r.counts.Movies + r.counts.Series + r.counts.Episodes + r.counts.Audio + r.counts.Books + r.counts.Videos).toLocaleString() : 'Count unavailable' },
        { key: 'Movies', label: t('Movies'), value: (r: typeof rows[number]) => r.counts?.Movies.toLocaleString() || '—' },
        { key: 'Episodes', label: t('Episodes'), value: (r: typeof rows[number]) => r.counts?.Episodes.toLocaleString() || '—' },
        { key: 'Audio', label: t('Audio'), value: (r: typeof rows[number]) => r.counts && r.counts.Audio > 0 ? r.counts.Audio.toLocaleString() : '—' },
        { key: 'Books', label: t('Books'), value: (r: typeof rows[number]) => r.counts && r.counts.Books > 0 ? r.counts.Books.toLocaleString() : '—' },
        { key: 'Path', label: t('Paths'), value: (r: typeof rows[number]) => <span class="ad-path">{r.library.Options?.Path?.join(', ') || r.library.Path || t('Path unavailable')}</span>, searchValue: (r: typeof rows[number]) => r.library.Options?.Path?.join(' ') || r.library.Path || '' },
        { key: 'Status', label: t('Status'), value: (r: typeof rows[number]) => { const status = libraryStatusLabel(r.library); return <StatusChip tone={status.tone}>{t(status.text)}</StatusChip>; } },
        { key: 'Actions', label: '', value: (r: typeof rows[number]) => <div class="ad-flex"><button class="ad-btn" disabled={!r.library.ItemId || !r.library.Name} aria-label={`Edit ${r.library.Name || t('library')}`} onClick={() => setEditing({ itemId: r.library.ItemId!, name: r.library.Name!, collectionType: r.library.CollectionType })}>{t('Edit')}</button><button class="ad-btn" disabled={!r.library.ItemId} onClick={async () => { try { await api.refreshLibrary(r.library.ItemId!, refreshMode, refreshMode); scanRequestedAt.current = Date.now(); setMessage(t('Library refresh queued.')); void load(); } catch (e) { setError(e instanceof Error ? e.message : t('Refresh failed.')); } }}>{t('Refresh metadata')}</button>{r.library.Name && <ConfirmButton label={t('Remove library')} tone="danger" onConfirm={async () => { await api.removeLibrary(r.library.Name!); await load(); }} />}</div> },
    ];

    return <PageShell title={t('Libraries')} subtitle={t('Inventory, health and scan control')} actions={<><label class="ad-field">{t('Refresh mode')}<select value={refreshMode} onChange={e => setRefreshMode(e.currentTarget.value as 'Default' | 'FullRefresh')}><option value="Default">{t('Missing metadata')}</option><option value="FullRefresh">{t('Full refresh')}</option></select></label><button class="ad-btn" onClick={() => setAdding(v => !v)}>{t('Add library')}</button><button class="ad-btn" onClick={scanAll} disabled={scanBusy}>{scanBusy ? t('Scanning…') : t('Scan all libraries')}</button></>}>
        {loadError && <p role="alert" class="ad-error">{loadError}</p>}
        {error && <p role="alert" class="ad-error">{error}</p>}{message && <p role="status" class="ad-note">{message}</p>}
        {adding && <Card title={t('Add library')}><form onSubmit={async e => {
            e.preventDefault(); if (!name.trim() || !path.trim()) return;
            try { await api.addLibrary(name.trim(), type, path.split('\n').map(p => p.trim()).filter(Boolean)); setAdding(false); setName(''); setPath(''); await load(); setMessage(t('Library added. Use Scan all libraries to populate it.')); }
            catch (err) { setError(err instanceof Error ? err.message : t('Could not add library.')); }
        }}><div class="ad-grid2"><label class="ad-field">{t('Name')}<input required value={name} onInput={e => setName(e.currentTarget.value)} /></label><label class="ad-field">{t('Type')}<select value={type} onChange={e => setType(e.currentTarget.value)}>{['movies','tvshows','music','books','homevideos','musicvideos','mixed'].map(type => <option key={type} value={type}>{type}</option>)}</select></label></div><label class="ad-field">{t('Server folder paths (one per line)')}<textarea required rows={3} value={path} onInput={e => setPath(e.currentTarget.value)} /></label><p class="ad-note">{t('Removing a library removes its Jellyfin configuration; this action does not delete media files.')}</p><button class="ad-btn" type="submit">{t('Add library')}</button></form></Card>}
        {libraries.length === 0
            ? <Card title={t('Libraries')}><Empty>{t('No libraries are configured.')}</Empty><button class="ad-btn" onClick={() => setAdding(true)}>{t('Add your first library')}</button></Card>
            : <Card title={t('Library inventory')}>
                <div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder={t('Search libraries…')} /><span class="ad-subtle">{t('{0} libraries', libraries.length)}</span></div>
                <DataTable rows={rows} columns={columns} getKey={r => r.library.ItemId || r.library.Name || ''} empty={t('No libraries match search')} query={search} sortKey={sort} sortAscending={ascending} onSort={key => { if (sort === key) setAscending(!ascending); else { setSort(key); setAscending(true); } }} />
            </Card>}
        {editing && <AdminLibraryEditor key={editing.itemId} api={api} library={editing} onClose={() => setEditing(null)} onChanged={() => void load()} onRenamed={name => void onRenamed(name)} />}
    </PageShell>;
}
