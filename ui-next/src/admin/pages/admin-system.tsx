import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { SystemInfo, PluginInfo, ApiKey, ScheduledTask, SystemStorage, PgsqlStatsSnapshot, DeviceInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, Tabs, InfoRow, ConfirmButton, timeAgo, DataTable, SearchInput } from '../ui';

export function AdminSystem({ adminApi: api }: { adminApi: AdminApi }) {
    const [tab, setTab] = useState('General');
    const [sys, setSys] = useState<SystemInfo | null>(null);
    const [plugins, setPlugins] = useState<PluginInfo[]>([]);
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [tasks, setTasks] = useState<ScheduledTask[]>([]);
    const [storage, setStorage] = useState<SystemStorage | null>(null);
    const [stats, setStats] = useState<PgsqlStatsSnapshot | null>(null);
    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [newKeyName, setNewKeyName] = useState('');
    const [keyMessage, setKeyMessage] = useState('');
    const [search, setSearch] = useState('');
    const [editingName, setEditingName] = useState(false);
    const [name, setName] = useState('');
    const [network, setNetwork] = useState<Record<string, any> | null>(null);
    const [savedNetwork, setSavedNetwork] = useState<Record<string, any> | null>(null);
    const [message, setMessage] = useState('');
    const [backups, setBackups] = useState<Array<{ Path: string; ServerVersion: string; DateCreated: string }> | null>(null);

    const load = useCallback(() => {
        api.getSystemInfo().then(setSys).catch(() => undefined);
        api.getPlugins().then(setPlugins).catch(() => undefined);
        api.getApiKeys().then(setKeys).catch(() => undefined);
        api.getScheduledTasks().then(setTasks).catch(() => undefined);
        api.getSystemStorage().then(setStorage).catch(() => undefined);
        api.getPgsqlStats().then(setStats).catch(() => undefined);
        api.getDevices().then(r => setDevices(r.Items || [])).catch(() => undefined);
    }, [api]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => { api.getNetworkConfig().then(c => { setNetwork(c); setSavedNetwork(c); }).catch(() => undefined); }, [api]);
    useEffect(() => { if (tab === 'Backups') void api.getBackups().then(setBackups); }, [api, tab]);
    const uptime = sys?.RunTimeTicks ? Math.floor(sys.RunTimeTicks / 600000000 / 60) : 0;

    const taskColumns = [
        { key: 'Name', label: 'Task', value: (t: ScheduledTask) => t.Name || '—', searchValue: (t: ScheduledTask) => t.Name || '' },
        { key: 'State', label: 'State', value: (t: ScheduledTask) => t.State || '—' },
        { key: 'Last', label: 'Last run', value: (t: ScheduledTask) => t.LastExecutionResult?.EndTimeUtc ? timeAgo(t.LastExecutionResult.EndTimeUtc) : 'Not run' },
        { key: 'Result', label: 'Result', value: (t: ScheduledTask) => t.LastExecutionResult?.Status || '—' },
        { key: 'Action', label: '', value: (t: ScheduledTask) => t.State === 'Running' ? <ConfirmButton label="Stop" tone="danger" onConfirm={() => api.stopTask(t.Id)} /> : <button class="ad-btn" onClick={() => api.startTask(t.Id)}>Run now</button> },
    ];

    const pluginColumns = [
        { key: 'Name', label: 'Plugin', value: (p: PluginInfo) => p.Name || '—', searchValue: (p: PluginInfo) => p.Name || '' },
        { key: 'Version', label: 'Version', value: (p: PluginInfo) => p.Version || '—' },
        { key: 'Status', label: 'Status', value: (p: PluginInfo) => <StatusChip tone={p.Status === 'Active' ? 'green' : p.Status === 'Malfunctioned' ? 'red' : 'muted'}>{p.Status || 'Not reported'}</StatusChip> },
    ];

    const keyColumns = [
        { key: 'App', label: 'Application', value: (k: ApiKey) => k.AppName || '—' },
        { key: 'Token', label: 'Token', value: (k: ApiKey) => k.AccessToken ? `${k.AccessToken.slice(0, 8)}…` : '—' },
        { key: 'Action', label: '', value: (k: ApiKey) => k.AccessToken ? <ConfirmButton label="Revoke" tone="danger" onConfirm={async () => { await api.revokeKey(k.AccessToken!); await load(); }} /> : null },
    ];

    const createKey = async () => {
        if (!newKeyName.trim()) return;
        await api.createApiKey(newKeyName.trim());
        setNewKeyName(''); setKeyMessage('Key created. Reload the list to show it.');
        await load();
    };

    return <PageShell title="System" subtitle="Configuration, maintenance and operational tools" actions={<button class="ad-btn" onClick={load}>Refresh</button>}>
        <Tabs tabs={['General', 'Network & keys', 'Devices', 'Scheduled tasks', 'Plugins', 'Backups', 'Storage', 'Fork status', 'Danger zone']} value={tab} onPick={setTab} />
        {tab === 'General' && <div class="ad-grid2">
            <Card title="Server"><InfoRow k="Name" v={sys?.ServerName || 'Unavailable'} /><InfoRow k="Version" v={sys?.Version || 'Unavailable'} />{uptime > 0 && <InfoRow k="Uptime" v={`${Math.floor(uptime / 24)}d ${uptime % 24}h`} />}{(sys?.OperatingSystemDisplayName || sys?.OperatingSystem) && <InfoRow k="Operating system" v={sys.OperatingSystemDisplayName || sys.OperatingSystem} />}
                {editingName ? <><label class="ad-field">Server name<input value={name} onInput={e => setName(e.currentTarget.value)} /></label><ConfirmButton label="Save server name" onConfirm={async () => { if (!name.trim()) throw new Error('Server name is required.'); await api.saveServerName(name.trim()); setSys(await api.getSystemInfo()); setEditingName(false); }} /></> : <button class="ad-btn" onClick={() => { setName(sys?.ServerName || ''); setEditingName(true); }}>Edit server name</button>}
            </Card>
            <Card title="Maintenance"><div class="ad-flex"><ConfirmButton label="Restart server" onConfirm={() => api.restartServer()} /><ConfirmButton label="Shut down" tone="danger" onConfirm={() => api.shutdownServer()} /></div></Card>
        </div>}
        {tab === 'Network & keys' && <>
            {network && <Card title="Network">
                <div class="ad-grid2">{['InternalHttpPort', 'InternalHttpsPort', 'PublicHttpPort', 'PublicHttpsPort'].map(key => <label key={key} class="ad-field">{key.replace(/([A-Z])/g, ' $1').trim()}<input type="number" min="1" max="65535" value={network[key]} onInput={e => setNetwork(old => ({ ...old, [key]: Number(e.currentTarget.value) }))} /></label>)}</div>
                <label class="ad-field">Base URL<input value={network.BaseUrl || ''} onInput={e => setNetwork(old => ({ ...old, BaseUrl: e.currentTarget.value }))} /></label>
                <label class="ad-field">Known proxies (comma-separated)<input value={(network.KnownProxies || []).join(', ')} onInput={e => setNetwork(old => ({ ...old, KnownProxies: e.currentTarget.value.split(',').map(v => v.trim()).filter(Boolean) }))} /></label>
                <label class="ad-field">Published server URIs (one subnet rule per line)<textarea rows={3} value={(network.PublishedServerUriBySubnet || []).join('\n')} onInput={e => setNetwork(old => ({ ...old, PublishedServerUriBySubnet: e.currentTarget.value.split('\n').map(v => v.trim()).filter(Boolean) }))} /></label>
                <InfoRow k="Built-in HTTPS" v={network.EnableHttps ? 'Enabled' : 'Disabled'} /><InfoRow k="Certificate configured" v={network.CertificatePath ? 'Yes' : 'No'} />
                <p class="ad-note">Network changes may require a server restart. Unrelated network settings are preserved.</p>
                <ConfirmButton label="Save network settings" onConfirm={async () => {
                    const keys = ['InternalHttpPort','InternalHttpsPort','PublicHttpPort','PublicHttpsPort','BaseUrl','KnownProxies','PublishedServerUriBySubnet'];
                    for (const key of keys.filter(k => k.endsWith('Port'))) if (!Number.isInteger(network[key]) || network[key] < 1 || network[key] > 65535) throw new Error('Ports must be between 1 and 65535.');
                    const patch = Object.fromEntries(keys.filter(k => JSON.stringify(network[k]) !== JSON.stringify(savedNetwork?.[k])).map(k => [k, network[k]]));
                    await api.saveNetworkConfig(patch); const c = await api.getNetworkConfig(); setNetwork(c); setSavedNetwork(c); setMessage('Network settings saved.');
                }} />{message && <p role="status" class="ad-note">{message}</p>}
            </Card>}
            <Card title="API keys">
                <div class="ad-toolbar"><input class="ad-search" placeholder="Application name" value={newKeyName} onInput={e => setNewKeyName((e.currentTarget as HTMLInputElement).value)} /><button class="ad-btn" disabled={!newKeyName.trim()} onClick={createKey}>Create key</button></div>
                {keyMessage && <p class="ad-note" role="status">{keyMessage}</p>}
                <DataTable rows={keys} columns={keyColumns} getKey={k => k.AccessToken || k.AppName || ''} empty="No API keys" query={search} />
            </Card>
        </>}
        {tab === 'Devices' && <Card title="Authorised devices"><DataTable rows={devices} columns={[
            { key: 'Name', label: 'Device', value: (d: DeviceInfo) => d.Name || '—', searchValue: (d: DeviceInfo) => d.Name || '' },
            { key: 'User', label: 'Last user', value: (d: DeviceInfo) => d.LastUserName || '—' },
            { key: 'App', label: 'Application', value: (d: DeviceInfo) => `${d.AppName || ''} ${d.AppVersion || ''}` },
            { key: 'Activity', label: 'Last activity', value: (d: DeviceInfo) => timeAgo(d.DateLastActivity) },
            { key: 'Action', label: '', value: (d: DeviceInfo) => d.Id ? <ConfirmButton label="Revoke" tone="danger" onConfirm={async () => { await api.deleteDevice(d.Id!); await load(); }} /> : null },
        ]} getKey={d => d.Id || d.Name || ''} empty="No devices" /></Card>}
        {tab === 'Scheduled tasks' && <Card title="Scheduled tasks"><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search tasks…" /></div><DataTable rows={tasks} columns={taskColumns} getKey={t => t.Id} query={search} empty="No scheduled tasks" /></Card>}
        {tab === 'Plugins' && <Card title="Installed plugins"><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search plugins…" /></div><DataTable rows={plugins} columns={pluginColumns} getKey={p => p.Id || p.Guid || p.Name || ''} query={search} empty="No plugins installed" /></Card>}
        {tab === 'Backups' && <Card title="Backup & restore">{backups === null ? <Empty muted>Backup listing is loading or unavailable on this server.</Empty> : <><div class="ad-toolbar"><ConfirmButton label="Create database backup" onConfirm={async () => { await api.createBackup(); setBackups(await api.getBackups()); }} /></div><DataTable rows={backups} getKey={b => b.Path} empty="No backups have been created" columns={[
            { key: 'Name', label: 'Archive', value: (b: typeof backups[number]) => b.Path.split(/[\\/]/).pop() || b.Path },
            { key: 'Created', label: 'Created', value: (b: typeof backups[number]) => new Date(b.DateCreated).toLocaleString(), searchValue: (b: typeof backups[number]) => b.DateCreated },
            { key: 'Version', label: 'Server version', value: (b: typeof backups[number]) => b.ServerVersion },
            { key: 'Restore', label: '', value: (b: typeof backups[number]) => <ConfirmButton label="Restore and restart server" tone="danger" onConfirm={() => api.restoreBackup(b.Path)} /> },
        ]} /><p class="ad-note">Restore replaces server data and restarts Jellyfin.</p></>}</Card>}
        {tab === 'Storage' && (storage ? <Card title="System storage">
            {[['Program data', storage.ProgramDataFolder], ['Web', storage.WebFolder], ['Image cache', storage.ImageCacheFolder], ['Cache', storage.CacheFolder], ['Metadata', storage.InternalMetadataFolder], ['Transcode temp', storage.TranscodingTempFolder], ['Logs', storage.LogFolder]].map(([label, mount]) => <StorageInfo key={label as string} label={label as string} mount={mount as SystemStorage['CacheFolder']} />)}
        </Card> : <Empty muted>System storage metrics are unavailable</Empty>)}
        {tab === 'Fork status' && (stats ? <Card title="Pgsql runtime status"><InfoRow k="Cache backend" v={stats.CacheBackend} /><InfoRow k="Cache active" v={stats.CacheActive ? 'Yes' : 'No'} /><InfoRow k="Redis availability" v={stats.RedisAvailability} /><InfoRow k="Redis connected" v={stats.RedisConnected ? 'Yes' : 'No'} /><InfoRow k="Browse hit / miss" v={`${stats.BrowseCacheHits} / ${stats.BrowseCacheMisses}`} /><InfoRow k="Latest hit / miss" v={`${stats.LatestCacheHits} / ${stats.LatestCacheMisses}`} /><InfoRow k="Effective browse TTL" v={`${stats.BrowseTtlSeconds}s`} /></Card> : <Empty muted>Pgsql runtime status unavailable</Empty>)}
        {tab === 'Danger zone' && <Card title="Danger zone"><div class="ad-danger"><p>Server shutdown stops playback and background work.</p><ConfirmButton label="Shut down server" tone="danger" onConfirm={() => api.shutdownServer()} /><p class="ad-note">Cache flush and database reset operations are not exposed by the current server APIs.</p></div></Card>}
    </PageShell>;
}

function StorageInfo({ label, mount }: { label: string; mount: { Path: string; UsedSpace: number; FreeSpace: number; StorageType?: string } }) {
    const total = mount.UsedSpace + mount.FreeSpace;
    const pct = total > 0 ? mount.UsedSpace / total * 100 : 0;
    const color = pct > 90 ? '#EF4444' : pct > 70 ? '#F59E0B' : '#22C55E';
    return <div class="ad-storage-info"><InfoRow k={label} v={`${formatBytes(mount.FreeSpace)} free · ${pct.toFixed(0)}% used`} /><div class="ad-path">{mount.Path}{mount.StorageType ? ` · ${mount.StorageType}` : ''}</div>{total > 0 && <div class="ad-storage-track"><i style={{ width: `${pct}%`, background: color }} /></div>}</div>;
}

function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return 'Unavailable';
    const g = n / 1024 ** 3;
    return g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g.toFixed(1)} GB`;
}
