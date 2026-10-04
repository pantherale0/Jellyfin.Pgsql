import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';
import { PageShell, Card, StatusChip, SearchInput, FilterPills, Empty, DataTable, ConfirmButton } from '../ui';

export function AdminAllPlugins({ adminApi: api, onNavigate }: { adminApi: AdminApi; onNavigate: (section: string) => void }) {
    const [plugins, setPlugins] = useState<PluginInfo[]>([]);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('All');
    const [busy, setBusy] = useState('');

    const load = useCallback(() => { api.getPlugins().then(setPlugins).catch(() => undefined); }, [api]);
    useEffect(() => { load(); }, [load]);

    const toggle = async (p: PluginInfo, enable: boolean) => {
        setBusy(p.Id || p.Name || '');
        try {
            const version = String(p.Version);
            if (enable) await api.enablePlugin(p.Id!, version);
            else await api.disablePlugin(p.Id!, version);
            await load();
        } catch {
            // The plugin manager may need a restart to apply the change.
        }
        setBusy('');
    };

    const filtered = plugins.filter(p => {
        if (filter === 'Enabled' && p.Status !== 'Active') return false;
        if (filter === 'Disabled' && p.Status === 'Active') return false;
        if (search && !((p.Name || '') + ' ' + (p.Description || '')).toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const firstClass = (name?: string) => {
        const lower = (name || '').toLowerCase();
        return lower.includes('postgresql database') || lower.includes('seerr');
    };

    const columns = [
        { key: 'Name', label: 'Plugin', value: (p: PluginInfo) => <><strong>{p.Name}</strong><div class="ad-cell-sub">{p.Version || '—'}</div></>, searchValue: (p: PluginInfo) => `${p.Name || ''} ${p.Description || ''}` },
        { key: 'Description', label: 'Description', value: (p: PluginInfo) => p.Description || '—', searchValue: (p: PluginInfo) => p.Description || '' },
        { key: 'Status', label: 'Status', value: (p: PluginInfo) => <StatusChip tone={p.Status === 'Active' ? 'green' : p.Status === 'Malfunctioned' ? 'red' : 'muted'}>{p.Status || 'Unknown'}</StatusChip> },
        { key: 'Actions', label: '', value: (p: PluginInfo) => {
            const isBusy = busy === p.Id || busy === p.Name;
            const pageName = firstClass(p.Name) ? `plugin-${encodeURIComponent(firstClassPage(p.Name || ''))}` : `plugin-${encodeURIComponent(p.Name || '')}`;
            return <div class="ad-flex" style="gap:6px;flex-wrap:wrap">
                <button class="ad-btn" disabled={isBusy} onClick={() => onNavigate(pageName)}>Configure</button>
                {p.Status === 'Active'
                    ? <ConfirmButton label="Disable" tone="danger" busy={isBusy} onConfirm={() => toggle(p, false)} />
                    : <ConfirmButton label="Enable" busy={isBusy} onConfirm={() => toggle(p, true)} />}
            </div>;
        } },
    ];

    return <PageShell title="All plugins" subtitle="Enable, disable and configure installed plugins" actions={<button class="ad-btn" onClick={load}>Refresh</button>}>
        <Card title="Installed plugins">
            <div class="ad-toolbar">
                <SearchInput value={search} onInput={setSearch} placeholder="Search plugins…" />
                <FilterPills options={['All', 'Enabled', 'Disabled']} value={filter} onPick={setFilter} />
                <span class="ad-note">{plugins.length} plugin{plugins.length !== 1 ? 's' : ''}</span>
            </div>
            <DataTable rows={filtered} columns={columns} getKey={p => p.Id || p.Name || ''} query={search} empty="No plugins found" />
            <p class="ad-note">Enable/disable changes take effect after a server restart. Uninstalled plugins remain in the list until restart.</p>
        </Card>
    </PageShell>;
}

function firstClassPage(rawName: string): string {
    const name = rawName.toLowerCase();
    if (name.includes('postgresql database')) return 'PostgreSQL%20Database';
    if (name.includes('seerr')) return 'Seerr';
    if (name.includes('tmdb')) return 'TMDb';
    return encodeURIComponent(rawName);
}