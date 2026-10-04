import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { LibraryInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, SearchInput, DataTable, ConfirmButton } from '../ui';

type Counts = { Movies: number; Series: number; Episodes: number };

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

    const load = useCallback(async () => {
        const rows = await api.getLibraries().catch(() => []);
        setLibraries(rows);
        const values = await Promise.all(rows.filter(l => l.ItemId).map(async l => [l.ItemId!, await api.getLibraryCounts(l.ItemId!).catch(() => null)] as const));
        setCounts(Object.fromEntries(values.filter((row): row is readonly [string, Counts] => row[1] !== null)));
    }, [api]);
    useEffect(() => { load(); }, [load]);

    const scanAll = async () => { setScanBusy(true); try { await api.scanAllLibraries(); setMessage('Scan requested.'); } catch (e) { setError(e instanceof Error ? e.message : 'Scan request failed.'); } finally { setScanBusy(false); } };
    const rows = libraries.map(l => ({ library: l, counts: l.ItemId ? counts[l.ItemId] : undefined }));
    const columns = [
        { key: 'Name', label: 'Library', value: (r: typeof rows[number]) => <><strong>{r.library.Name}</strong><div class="ad-cell-sub">{r.library.CollectionType || 'Mixed'}</div></>, searchValue: (r: typeof rows[number]) => `${r.library.Name || ''} ${r.library.CollectionType || ''}` },
        { key: 'Items', label: 'Items', value: (r: typeof rows[number]) => r.counts ? (r.counts.Movies + r.counts.Series + r.counts.Episodes).toLocaleString() : 'Count unavailable' },
        { key: 'Movies', label: 'Movies', value: (r: typeof rows[number]) => r.counts?.Movies.toLocaleString() || '—' },
        { key: 'Episodes', label: 'Episodes', value: (r: typeof rows[number]) => r.counts?.Episodes.toLocaleString() || '—' },
        { key: 'Path', label: 'Paths', value: (r: typeof rows[number]) => <span class="ad-path">{r.library.Options?.Path?.join(', ') || r.library.Path || 'Path unavailable'}</span>, searchValue: (r: typeof rows[number]) => r.library.Options?.Path?.join(' ') || r.library.Path || '' },
        { key: 'Status', label: 'Status', value: (r: typeof rows[number]) => r.library.RefreshStatus ? <StatusChip tone={r.library.RefreshStatus.toLowerCase().includes('error') ? 'red' : 'blue'}>{r.library.RefreshStatus}</StatusChip> : r.library.RefreshProgress != null ? <StatusChip tone="blue">Scanning {Math.round(r.library.RefreshProgress)}%</StatusChip> : <StatusChip tone="green">Idle</StatusChip> },
        { key: 'Actions', label: '', value: (r: typeof rows[number]) => <div class="ad-flex"><button class="ad-btn" disabled={!r.library.ItemId} onClick={async () => { try { await api.refreshLibrary(r.library.ItemId!); setMessage('Library refresh queued.'); } catch (e) { setError(e instanceof Error ? e.message : 'Refresh failed.'); } }}>Refresh metadata</button>{r.library.Name && <ConfirmButton label="Remove library" tone="danger" onConfirm={async () => { await api.removeLibrary(r.library.Name!); await load(); }} />}</div> },
    ];

    return <PageShell title="Libraries" subtitle="Inventory, health and scan control" actions={<><button class="ad-btn" onClick={() => setAdding(v => !v)}>Add library</button><button class="ad-btn" onClick={scanAll} disabled={scanBusy}>{scanBusy ? 'Scanning…' : 'Scan all libraries'}</button></>}>
        {error && <p role="alert" class="ad-error">{error}</p>}{message && <p role="status" class="ad-note">{message}</p>}
        {adding && <Card title="Add library"><form onSubmit={async e => {
            e.preventDefault(); if (!name.trim() || !path.trim()) return;
            try { await api.addLibrary(name.trim(), type, path.split('\n').map(p => p.trim()).filter(Boolean)); setAdding(false); setName(''); setPath(''); await load(); setMessage('Library added. Use Scan all libraries to populate it.'); }
            catch (err) { setError(err instanceof Error ? err.message : 'Could not add library.'); }
        }}><div class="ad-grid2"><label class="ad-field">Name<input required value={name} onInput={e => setName(e.currentTarget.value)} /></label><label class="ad-field">Type<select value={type} onChange={e => setType(e.currentTarget.value)}>{['movies','tvshows','music','books','homevideos'].map(t => <option key={t} value={t}>{t}</option>)}</select></label></div><label class="ad-field">Server folder paths (one per line)<textarea required rows={3} value={path} onInput={e => setPath(e.currentTarget.value)} /></label><p class="ad-note">Removing a library removes its Jellyfin configuration; this action does not delete media files.</p><button class="ad-btn" type="submit">Add library</button></form></Card>}
        {libraries.length === 0
            ? <Card title="Libraries"><Empty>No libraries are configured.</Empty><button class="ad-btn" onClick={() => setAdding(true)}>Add your first library</button></Card>
            : <Card title="Library inventory">
                <div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search libraries…" /><span class="ad-subtle">{libraries.length} libraries</span></div>
                <DataTable rows={rows} columns={columns} getKey={r => r.library.ItemId || r.library.Name || ''} empty="No libraries match search" query={search} sortKey={sort} sortAscending={ascending} onSort={key => { if (sort === key) setAscending(!ascending); else { setSort(key); setAscending(true); } }} />
            </Card>}
    </PageShell>;
}
