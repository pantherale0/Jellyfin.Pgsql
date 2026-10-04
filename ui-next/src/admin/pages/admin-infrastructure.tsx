import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { ScheduledTask, DeviceInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, Tabs, timeAgo, fmtDate, ConfirmButton, SearchInput, DataTable, InfoRow } from '../ui';
import { LiveLogViewer } from '../live-log';

export function AdminInfrastructure({ adminApi: api }: { adminApi: AdminApi }) {
    const [tab, setTab] = useState('Stack');
    const [stats, setStats] = useState<any>(null);
    const [tasks, setTasks] = useState<ScheduledTask[]>([]);
    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [sys, setSys] = useState<any>(null);
    const [encoder, setEncoder] = useState<Record<string, any> | null>(null);
    const [logs, setLogs] = useState<Array<{ Name?: string; Size?: number }>>([]);
    const [logName, setLogName] = useState('');
    const [search, setSearch] = useState('');

    const load = useCallback(() => {
        api.getPgsqlStats().then(setStats).catch(() => undefined);
        api.getScheduledTasks().then(setTasks).catch(() => undefined);
        api.getDevices().then(r => setDevices(r.Items || [])).catch(() => undefined);
        api.getSystemInfo().then(setSys).catch(() => undefined);
        api.getLogs().then(rows => { setLogs(rows); setLogName(current => current || rows[0]?.Name || ''); }).catch(() => undefined);
    }, [api]);
    useEffect(() => { load(); const iv = window.setInterval(load, 12000); return () => window.clearInterval(iv); }, [load]);
    useEffect(() => { api.getMediaEncoderCapabilities().then(setEncoder).catch(() => undefined); }, [api]);

    const total = stats ? stats.BrowseCacheHits + stats.LatestCacheHits + stats.BrowseCacheMisses + stats.LatestCacheMisses : 0;
    const hitRate = total ? ((stats.BrowseCacheHits + stats.LatestCacheHits) / total * 100).toFixed(1) + '%' : undefined;
    const redisTone = stats?.RedisAvailability === 'Ready' ? 'green' : stats?.RedisAvailability === 'Disabled' ? 'muted' : 'amber';

    const taskColumns = [
        { key: 'Name', label: 'Task', value: (t: ScheduledTask) => t.Name || '—', searchValue: (t: ScheduledTask) => t.Name || '' },
        { key: 'State', label: 'State', value: (t: ScheduledTask) => t.State === 'Running' ? <StatusChip tone="green">Running</StatusChip> : <StatusChip tone="muted">{t.State || 'Idle'}</StatusChip> },
        { key: 'Progress', label: 'Progress', value: (t: ScheduledTask) => t.CurrentProgressPercentage != null ? `${Math.round(t.CurrentProgressPercentage)}%` : '—' },
        { key: 'Last', label: 'Last run', value: (t: ScheduledTask) => fmtDate(t.LastExecutionResult?.EndTimeUtc) },
        { key: 'Action', label: '', value: (t: ScheduledTask) => t.State === 'Running' ? <ConfirmButton label="Stop" onConfirm={() => api.stopTask(t.Id)} tone="danger" /> : <button class="ad-btn" onClick={() => api.startTask(t.Id)}>Run</button> },
    ];
    const deviceColumns = [
        { key: 'Name', label: 'Device', value: (d: DeviceInfo) => d.Name || '—', searchValue: (d: DeviceInfo) => `${d.Name || ''} ${d.AppName || ''} ${d.LastUserName || ''}` },
        { key: 'User', label: 'User', value: (d: DeviceInfo) => d.LastUserName || '—' },
        { key: 'App', label: 'App', value: (d: DeviceInfo) => `${d.AppName || ''} ${d.AppVersion || ''}` },
        { key: 'Last', label: 'Last activity', value: (d: DeviceInfo) => timeAgo(d.DateLastActivity) },
        { key: 'Action', label: '', value: (d: DeviceInfo) => d.Id ? <ConfirmButton label="Revoke" tone="danger" onConfirm={async () => { await api.deleteDevice(d.Id!); await load(); }} /> : null },
    ];

    return <PageShell title="Infrastructure" subtitle="Pgsql cache, system health, devices, tasks and logs">
        <Tabs tabs={['Stack', 'Tasks', 'Devices', 'Logs']} value={tab} onPick={setTab} />
        {tab === 'Stack' && <div class="ad-grid2">
            <Card title="PostgreSQL provider">
                <InfoRow k="Database provider" v={<StatusChip tone="blue">PostgreSQL</StatusChip>} />
                {stats && <><InfoRow k="Optimised Latest runs" v={`${stats.OptimizedLatestRuns} · failures ${stats.OptimizedLatestFailures}`} /><InfoRow k="Optimised NextUp runs" v={`${stats.OptimizedNextUpRuns} · failures ${stats.OptimizedNextUpFailures}`} /></>}
                <p class="ad-note">Connection count, database size and long-running queries are not exposed by the plugin API.</p>
            </Card>
            <Card title="Pgsql query cache">
                {stats ? <><InfoRow k="Backend" v={stats.CacheBackend} /><InfoRow k="Cache active" v={stats.CacheActive ? 'Yes' : 'No'} /><InfoRow k="Redis" v={<StatusChip tone={redisTone as any}>{stats.RedisAvailability}</StatusChip>} />{hitRate && <InfoRow k="Combined hit rate" v={hitRate} />}<InfoRow k="Browse TTL" v={`${stats.BrowseTtlSeconds}s`} /><InfoRow k="Latest TTL" v={`${stats.LatestTtlSeconds}s`} /><InfoRow k="Resume / NextUp TTL" v={`${stats.ResumeTtlSeconds}s / ${stats.NextUpTtlSeconds}s`} /></> : <Empty muted>Pgsql stats unavailable</Empty>}
            </Card>
            {sys && <Card title="System"><InfoRow k="Operating system" v={sys.OperatingSystemDisplayName || sys.OperatingSystem || 'Unavailable'} /><InfoRow k="Server version" v={sys.Version || 'Unavailable'} /><InfoRow k="HTTP port" v={sys.InternalHttpPort ?? 'Unavailable'} /><InfoRow k="HTTPS port" v={sys.HttpsPort ?? 'Unavailable'} /></Card>}
            {encoder && <Card title="Hardware acceleration"><InfoRow k="Detected acceleration types" v={(encoder.AvailableAccelerationTypes || []).join(', ') || 'None detected'} /><InfoRow k="FFmpeg accelerators" v={(encoder.Hwaccels || []).join(', ') || 'None detected'} /><details class="ad-rbac-row"><summary>Encoder capability details</summary><pre class="ad-json">{JSON.stringify({ HardwareEncoding: encoder.HardwareEncoding, HardwareDecodingCodecs: encoder.HardwareDecodingCodecs }, null, 2)}</pre></details></Card>}
            {stats && <Card title="Query optimisations"><InfoRow k="Movies Latest" v={stats.OptimizeMoviesLatest ? 'Enabled' : 'Disabled'} /><InfoRow k="TV Latest" v={stats.OptimizeTvLatest ? 'Enabled' : 'Disabled'} /><InfoRow k="Music Latest" v={stats.OptimizeMusicLatest ? 'Enabled' : 'Disabled'} /><InfoRow k="NextUp" v={stats.OptimizeNextUp ? 'Enabled' : 'Disabled'} /></Card>}
        </div>}
        {tab === 'Tasks' && <Card title="Scheduled tasks"><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search tasks…" /></div><DataTable rows={tasks} columns={taskColumns} getKey={t => t.Id} query={search} empty="No scheduled tasks" /></Card>}
        {tab === 'Devices' && <Card title="Authorised devices"><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search devices…" /></div><DataTable rows={devices} columns={deviceColumns} getKey={d => d.Id || d.Name || ''} query={search} empty="No devices" /></Card>}
        {tab === 'Logs' && <Card title="Server logs">
            {logs.length === 0 ? <Empty muted>No server logs are exposed.</Empty> : <LiveLogViewer api={api} logName={logName} onNameChange={setLogName} />}
        </Card>}
    </PageShell>;
}
