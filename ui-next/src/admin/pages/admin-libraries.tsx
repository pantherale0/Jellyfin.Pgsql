import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { LibraryInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, SearchInput, DataTable, ConfirmButton } from '../ui';
import { AdminLibraryEditor, type LibraryIdentity } from './admin-library-editor';
import { isLibraryScanning, libraryStatusLabel, scanPollDelay } from '../admin-state';

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
        catch (e) { setLoadError(e instanceof Error ? e.message : 'Libraries could not be loaded.'); return [] as LibraryInfo[]; }
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
        setMessage(`Library renamed to ${newName}.`);
    };
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        const delay = scanPollDelay(isLibraryScanning(libraries), scanRequestedAt.current, Date.now());
        if (delay === null) return;
        const timer = window.setTimeout(() => { if (!document.hidden) void load(); else setLibraries(rows => [...rows]); }, delay);
        return () => window.clearTimeout(timer);
    }, [libraries, load]);

    const scanAll = async () => { setScanBusy(true); try { await api.scanAllLibraries(); scanRequestedAt.current = Date.now(); setMessage('Scan requested.'); void load(); } catch (e) { setError(e instanceof Error ? e.message : 'Scan request failed.'); } finally { setScanBusy(false); } };
    const rows = libraries.map(l => ({ library: l, counts: l.ItemId ? counts[l.ItemId] : undefined }));
    const columns = [
        { key: 'Name', label: 'Library', value: (r: typeof rows[number]) => <><strong>{r.library.Name}</strong><div class="ad-cell-sub">{r.library.CollectionType || 'Mixed'}</div></>, searchValue: (r: typeof rows[number]) => `${r.library.Name || ''} ${r.library.CollectionType || ''}` },
        { key: 'Items', label: 'Items', value: (r: typeof rows[number]) => r.counts ? (r.counts.Movies + r.counts.Series + r.counts.Episodes + r.counts.Audio + r.counts.Books + r.counts.Videos).toLocaleString() : 'Count unavailable' },
        { key: 'Movies', label: 'Movies', value: (r: typeof rows[number]) => r.counts?.Movies.toLocaleString() || '—' },
        { key: 'Episodes', label: 'Episodes', value: (r: typeof rows[number]) => r.counts?.Episodes.toLocaleString() || '—' },
        { key: 'Audio', label: 'Audio', value: (r: typeof rows[number]) => r.counts && r.counts.Audio > 0 ? r.counts.Audio.toLocaleString() : '—' },
        { key: 'Books', label: 'Books', value: (r: typeof rows[number]) => r.counts && r.counts.Books > 0 ? r.counts.Books.toLocaleString() : '—' },
        { key: 'Path', label: 'Paths', value: (r: typeof rows[number]) => <span class="ad-path">{r.library.Options?.Path?.join(', ') || r.library.Path || 'Path unavailable'}</span>, searchValue: (r: typeof rows[number]) => r.library.Options?.Path?.join(' ') || r.library.Path || '' },
        { key: 'Status', label: 'Status', value: (r: typeof rows[number]) => { const status = libraryStatusLabel(r.library); return <StatusChip tone={status.tone}>{status.text}</StatusChip>; } },
        { key: 'Actions', label: '', value: (r: typeof rows[number]) => <div class="ad-flex"><button class="ad-btn" disabled={!r.library.ItemId || !r.library.Name} aria-label={`Edit ${r.library.Name || 'library'}`} onClick={() => setEditing({ itemId: r.library.ItemId!, name: r.library.Name!, collectionType: r.library.CollectionType })}>Edit</button><button class="ad-btn" disabled={!r.library.ItemId} onClick={async () => { try { await api.refreshLibrary(r.library.ItemId!, refreshMode, refreshMode); scanRequestedAt.current = Date.now(); setMessage('Library refresh queued.'); void load(); } catch (e) { setError(e instanceof Error ? e.message : 'Refresh failed.'); } }}>Refresh metadata</button>{r.library.Name && <ConfirmButton label="Remove library" tone="danger" onConfirm={async () => { await api.removeLibrary(r.library.Name!); await load(); }} />}</div> },
    ];

    return <PageShell title="Libraries" subtitle="Inventory, health and scan control" actions={<><label class="ad-field">Refresh mode<select value={refreshMode} onChange={e => setRefreshMode(e.currentTarget.value as 'Default' | 'FullRefresh')}><option value="Default">Missing metadata</option><option value="FullRefresh">Full refresh</option></select></label><button class="ad-btn" onClick={() => setAdding(v => !v)}>Add library</button><button class="ad-btn" onClick={scanAll} disabled={scanBusy}>{scanBusy ? 'Scanning…' : 'Scan all libraries'}</button></>}>
        {loadError && <p role="alert" class="ad-error">{loadError}</p>}
        {error && <p role="alert" class="ad-error">{error}</p>}{message && <p role="status" class="ad-note">{message}</p>}
        {adding && <Card title="Add library"><form onSubmit={async e => {
            e.preventDefault(); if (!name.trim() || !path.trim()) return;
            try { await api.addLibrary(name.trim(), type, path.split('\n').map(p => p.trim()).filter(Boolean)); setAdding(false); setName(''); setPath(''); await load(); setMessage('Library added. Use Scan all libraries to populate it.'); }
            catch (err) { setError(err instanceof Error ? err.message : 'Could not add library.'); }
        }}><div class="ad-grid2"><label class="ad-field">Name<input required value={name} onInput={e => setName(e.currentTarget.value)} /></label><label class="ad-field">Type<select value={type} onChange={e => setType(e.currentTarget.value)}>{['movies','tvshows','music','books','homevideos','musicvideos','mixed'].map(t => <option key={t} value={t}>{t}</option>)}</select></label></div><label class="ad-field">Server folder paths (one per line)<textarea required rows={3} value={path} onInput={e => setPath(e.currentTarget.value)} /></label><p class="ad-note">Removing a library removes its Jellyfin configuration; this action does not delete media files.</p><button class="ad-btn" type="submit">Add library</button></form></Card>}
        {libraries.length === 0
            ? <Card title="Libraries"><Empty>No libraries are configured.</Empty><button class="ad-btn" onClick={() => setAdding(true)}>Add your first library</button></Card>
            : <Card title="Library inventory">
                <div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search libraries…" /><span class="ad-subtle">{libraries.length} libraries</span></div>
                <DataTable rows={rows} columns={columns} getKey={r => r.library.ItemId || r.library.Name || ''} empty="No libraries match search" query={search} sortKey={sort} sortAscending={ascending} onSort={key => { if (sort === key) setAscending(!ascending); else { setSort(key); setAscending(true); } }} />
            </Card>}
        {editing && <AdminLibraryEditor key={editing.itemId} api={api} library={editing} onClose={() => setEditing(null)} onChanged={() => void load()} onRenamed={name => void onRenamed(name)} />}
    </PageShell>;
}
