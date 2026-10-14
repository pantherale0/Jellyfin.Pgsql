import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';
import { pluginSection } from '../admin-state';
import { PageShell, Card, StatusChip, SearchInput, FilterPills, Empty, DataTable, ConfirmButton } from '../ui';

export function AdminAllPlugins({ adminApi: api, onNavigate, configurablePluginIds }: { adminApi: AdminApi; onNavigate: (section: string) => void; configurablePluginIds: string[] }) {
    const [plugins, setPlugins] = useState<PluginInfo[]>([]);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('All');
    const [busy, setBusy] = useState('');

    const [loadError, setLoadError] = useState('');
    const [message, setMessage] = useState('');
    const load = useCallback(async () => { setLoadError(''); try { setPlugins(await api.getPlugins()); } catch (e) { setLoadError(e instanceof Error ? e.message : 'Plugin list failed.'); } }, [api]);
    useEffect(() => { void load(); }, [load]);

    const toggle = async (p: PluginInfo, enable: boolean) => {
        setBusy(p.Id || p.Name || ''); setMessage('');
        try {
            const version = String(p.Version);
            if (enable) await api.enablePlugin(p.Id!, version);
            else await api.disablePlugin(p.Id!, version);
            await load();
            setMessage(`${p.Name || 'Plugin'} ${enable ? 'enabled' : 'disabled'}. Restart the server for the change to take effect.`);
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : 'Plugin change failed.');
        }
        setBusy('');
    };

    const filtered = plugins.filter(p => {
        if (filter === 'Enabled' && p.Status !== 'Active') return false;
        if (filter === 'Disabled' && p.Status === 'Active') return false;
        if (search && !((p.Name || '') + ' ' + (p.Description || '')).toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const columns = [
        { key: 'Name', label: 'Plugin', value: (p: PluginInfo) => <><strong>{p.Name}</strong><div class="ad-cell-sub">{p.Version || '—'}</div></>, searchValue: (p: PluginInfo) => `${p.Name || ''} ${p.Description || ''}` },
        { key: 'Description', label: 'Description', value: (p: PluginInfo) => p.Description || '—', searchValue: (p: PluginInfo) => p.Description || '' },
        { key: 'Status', label: 'Status', value: (p: PluginInfo) => <StatusChip tone={p.Status === 'Active' ? 'green' : p.Status === 'Malfunctioned' ? 'red' : 'muted'}>{p.Status || 'Unknown'}</StatusChip> },
        { key: 'Actions', label: '', value: (p: PluginInfo) => {
            const isBusy = busy === p.Id || busy === p.Name;
            const configurable = Boolean(p.Id) && configurablePluginIds.includes(p.Id!);
            return <div class="ad-flex" style="gap:6px;flex-wrap:wrap">
                {configurable && <button class="ad-btn" disabled={isBusy} onClick={() => onNavigate(pluginSection(p.Id!))}>Configure</button>}
                {p.Status === 'Active'
                    ? <ConfirmButton label="Disable" tone="danger" busy={isBusy} onConfirm={() => toggle(p, false)} />
                    : <ConfirmButton label="Enable" busy={isBusy} onConfirm={() => toggle(p, true)} />}
            </div>;
        } },
    ];

    return <PageShell title="All plugins" subtitle="Enable, disable and configure installed plugins" actions={<button class="ad-btn" onClick={() => void load()}>Refresh</button>}>
        {loadError && <p role="alert" class="ad-error">{loadError}</p>}
        {message && <p role="status" class="ad-note">{message}</p>}
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