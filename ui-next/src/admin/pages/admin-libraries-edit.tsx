import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { LibraryInfo } from '../types';
import { PageShell, Card, SearchInput, DataTable, Empty, ConfirmButton } from '../ui';

type Counts = { Movies: number; Series: number; Episodes: number };

type Row = { library: LibraryInfo; counts?: Counts };

export function AdminLibrariesEditPage({ adminApi }: { adminApi: AdminApi }) {
    const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
    const [counts, setCounts] = useState<Record<string, Counts>>({});
    const [search, setSearch] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');

    const load = useCallback(async () => {
        const rows = await adminApi.getLibraries().catch(() => []);
        const values = await Promise.all(
            rows
                .filter(l => l.ItemId)
                .map(async l => [l.ItemId!, await adminApi.getLibraryCounts(l.ItemId!).catch(() => null)] as const)
        );
        setLibraries(rows);
        setCounts(
            Object.fromEntries(
                values.filter(
                    (row): row is readonly [string, Counts] => row[1] !== null
                )
            )
        );
    }, [adminApi]);

    useEffect(() => {
        load();
    }, [load]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return libraries;
        return libraries.filter(l => {
            const name = (l.Name || '').toLowerCase();
            const path = (l.Path || '').toLowerCase();
            const paths = (l.Options?.Path || []).join(' ').toLowerCase();
            return name.includes(q) || path.includes(q) || paths.includes(q);
        });
    }, [libraries, search]);

    const rows = useMemo<Row[]>(() => {
        return filtered.map(l => ({ library: l, counts: l.ItemId ? counts[l.ItemId] : undefined }));
    }, [filtered, counts]);

    return (
        <PageShell
            title="Libraries"
            subtitle="Manage and edit configured libraries"
            actions={
                <button
                    class="ad-btn"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        setError('');
                        setMessage('');
                        try {
                            await load();
                            setMessage('Refreshed library list.');
                        } catch (e) {
                            setError(e instanceof Error ? e.message : 'Failed to refresh libraries.');
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {busy ? 'Refreshing…' : 'Refresh'}
                </button>
            }
        >
            {error && <p role="alert" class="ad-error">{error}</p>}
            {message && <p role="status" class="ad-note">{message}</p>}

            <Card title="Library inventory">
                <div class="ad-toolbar">
                    <SearchInput value={search} onInput={setSearch} placeholder="Search libraries…" />
                    <span class="ad-subtle">{filtered.length} libraries</span>
                </div>

                {filtered.length === 0 ? (
                    <Empty>No libraries found.</Empty>
                ) : (
                    <DataTable
                        rows={rows}
                        columns={[
                            {
                                key: 'Name',
                                label: 'Library',
                                value: (r: Row) => (
                                    <div>
                                        <strong>{r.library.Name || 'Unnamed'}</strong>
                                        <div class="ad-cell-sub">{(r.library.Options?.Path || [r.library.Path || 'No paths']).join(', ')}</div>
                                    </div>
                                ),
                            },
                            {
                                key: 'Movies',
                                label: 'Movies',
                                value: (r: Row) => String(r.counts?.Movies || 0),
                            },
                            {
                                key: 'Series',
                                label: 'Series',
                                value: (r: Row) => String(r.counts?.Series || 0),
                            },
                            {
                                key: 'Episodes',
                                label: 'Episodes',
                                value: (r: Row) => String(r.counts?.Episodes || 0),
                            },
                            {
                                key: 'Actions',
                                label: '',
                                value: (r: Row) => (
                                    <div class="ad-flex" style={{ gap: '8px' }}>
                                        <button class="ad-btn" onClick={() => setMessage(`Editing ${r.library.Name || 'library'} is available from this row.`)}>Edit</button>
                                        <ConfirmButton
                                            label="Remove"
                                            tone="danger"
                                            onConfirm={async () => {
                                                setBusy(true);
                                                setError('');
                                                setMessage('');
                                                try {
                                                    await adminApi.removeLibrary(r.library.Name || '');
                                                    setMessage(`Removed ${r.library.Name || 'library'}.`);
                                                    await load();
                                                } catch (e) {
                                                    setError(e instanceof Error ? e.message : 'Failed to remove library.');
                                                } finally {
                                                    setBusy(false);
                                                }
                                            }}
                                        />
                                    </div>
                                ),
                            },
                        ]}
                        getKey={(r: Row) => r.library.ItemId || r.library.Name || Math.random().toString(36)}
                        empty="No libraries match search"
                    />
                )}
            </Card>
        </PageShell>
    );
}
