import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { ScheduledTask, DeviceInfo, SystemInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, Tabs, timeAgo, fmtDate, ConfirmButton, SearchInput, DataTable, InfoRow, ConfigSection } from '../ui';
import { LOGGING_FIELDS } from '../server-settings';
import { LiveLogViewer } from '../live-log';
import { t } from '../../i18n';

export function AdminInfrastructure({ adminApi: api }: { adminApi: AdminApi }) {
    const [tab, setTab] = useState('Stack');
    const [stats, setStats] = useState<any>(null);
    const [tasks, setTasks] = useState<ScheduledTask[]>([]);
    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [sys, setSys] = useState<SystemInfo | null>(null);
    const [network, setNetwork] = useState<Record<string, any> | null>(null);
    const [encoder, setEncoder] = useState<Record<string, any> | null>(null);
    const [logs, setLogs] = useState<Array<{ Name?: string; Size?: number }>>([]);
    const [logName, setLogName] = useState('');
    const [search, setSearch] = useState('');
    const [taskBusy, setTaskBusy] = useState('');
    const [taskError, setTaskError] = useState('');

    const load = useCallback(() => {
        api.getPgsqlStats().then(setStats).catch(() => undefined);
        api.getScheduledTasks().then(setTasks).catch(() => undefined);
        api.getDevices().then(r => setDevices(r.Items || [])).catch(() => undefined);
        api.getSystemInfo().then(setSys).catch(() => undefined);
    }, [api]);
    useEffect(() => { api.getLogs().then(rows => { setLogs(rows); setLogName(current => current || rows[0]?.Name || ''); }).catch(() => undefined); }, [api]);
    useEffect(() => { api.getNetworkConfig().then(setNetwork).catch(() => undefined); }, [api]);
    useEffect(() => { load(); const iv = window.setInterval(load, 12000); return () => window.clearInterval(iv); }, [load]);
    useEffect(() => { api.getMediaEncoderCapabilities().then(setEncoder).catch(() => undefined); }, [api]);

    const total = stats ? stats.BrowseCacheHits + stats.LatestCacheHits + stats.BrowseCacheMisses + stats.LatestCacheMisses : 0;
    const hitRate = total ? ((stats.BrowseCacheHits + stats.LatestCacheHits) / total * 100).toFixed(1) + '%' : undefined;
    const redisTone = stats?.RedisAvailability === 'Ready' ? 'green' : stats?.RedisAvailability === 'Disabled' ? 'muted' : 'amber';

    const taskColumns = [
        { key: 'Name', label: t('Task'), value: (task: ScheduledTask) => task.Name || '—', searchValue: (task: ScheduledTask) => task.Name || '' },
        { key: 'State', label: t('State'), value: (task: ScheduledTask) => task.State === 'Running' ? <StatusChip tone="green">{t('Running')}</StatusChip> : <StatusChip tone="muted">{task.State || t('Idle')}</StatusChip> },
        { key: 'Progress', label: t('Progress'), value: (task: ScheduledTask) => task.CurrentProgressPercentage != null ? `${Math.round(task.CurrentProgressPercentage)}%` : '—' },
        { key: 'Last', label: t('Last run'), value: (task: ScheduledTask) => fmtDate(task.LastExecutionResult?.EndTimeUtc) },
        { key: 'Action', label: '', value: (task: ScheduledTask) => task.State === 'Running' ? <ConfirmButton label={t('Stop')} busy={taskBusy === task.Id} onConfirm={async () => { setTaskBusy(task.Id); setTaskError(''); try { await api.stopTask(task.Id); await load(); } catch (e) { setTaskError(e instanceof Error ? e.message : t('Task action failed.')); } finally { setTaskBusy(''); } }} tone="danger" /> : <button class="ad-btn" disabled={taskBusy === task.Id} onClick={async () => { setTaskBusy(task.Id); setTaskError(''); try { await api.startTask(task.Id); await load(); } catch (e) { setTaskError(e instanceof Error ? e.message : t('Task action failed.')); } finally { setTaskBusy(''); } }}>{taskBusy === task.Id ? t('Working…') : t('Run')}</button> },
    ];
    const deviceColumns = [
        { key: 'Name', label: t('Device'), value: (d: DeviceInfo) => d.Name || '—', searchValue: (d: DeviceInfo) => `${d.Name || ''} ${d.AppName || ''} ${d.LastUserName || ''}` },
        { key: 'User', label: t('User'), value: (d: DeviceInfo) => d.LastUserName || '—' },
        { key: 'App', label: t('App'), value: (d: DeviceInfo) => `${d.AppName || ''} ${d.AppVersion || ''}` },
        { key: 'Last', label: t('Last activity'), value: (d: DeviceInfo) => timeAgo(d.DateLastActivity) },
        { key: 'Action', label: '', value: (d: DeviceInfo) => d.Id ? <ConfirmButton label={t('Revoke')} tone="danger" onConfirm={async () => { await api.deleteDevice(d.Id!); await load(); }} /> : null },
    ];

    return <PageShell title={t('Infrastructure')} subtitle={t('Pgsql cache, system health, devices, tasks and logs')}>
        <Tabs tabs={['Stack', 'Tasks', 'Devices', 'Logs']} value={tab} onPick={setTab} />
        {tab === 'Stack' && <div class="ad-grid2">
            <Card title={t('PostgreSQL provider')}>
                <InfoRow k={t('Database provider')} v={<StatusChip tone="blue">{t('PostgreSQL')}</StatusChip>} />
                {stats && <><InfoRow k={t('Optimised Latest runs')} v={t('{0} · failures {1}', stats.OptimizedLatestRuns, stats.OptimizedLatestFailures)} /><InfoRow k={t('Optimised NextUp runs')} v={t('{0} · failures {1}', stats.OptimizedNextUpRuns, stats.OptimizedNextUpFailures)} /></>}
                <p class="ad-note">{t('Connection count, database size and long-running queries are not exposed by the plugin API.')}</p>
            </Card>
            <Card title={t('Pgsql query cache')}>
                {stats ? <><InfoRow k={t('Backend')} v={stats.CacheBackend} /><InfoRow k={t('Cache active')} v={stats.CacheActive ? t('Yes') : t('No')} /><InfoRow k={t('Redis')} v={<StatusChip tone={redisTone as any}>{stats.RedisAvailability}</StatusChip>} />{hitRate && <InfoRow k={t('Combined hit rate')} v={hitRate} />}<InfoRow k={t('Browse TTL')} v={`${stats.BrowseTtlSeconds}s`} /><InfoRow k={t('Latest TTL')} v={`${stats.LatestTtlSeconds}s`} /><InfoRow k={t('Resume / NextUp TTL')} v={`${stats.ResumeTtlSeconds}s / ${stats.NextUpTtlSeconds}s`} /></> : <Empty muted>{t('Pgsql stats unavailable')}</Empty>}
            </Card>
            {(sys || network) && <Card title={t('System')}><InfoRow k={t('Server version')} v={sys?.Version || t('Unavailable')} /><InfoRow k={t('Architecture')} v={sys?.SystemArchitecture || t('Not reported')} /><InfoRow k={t('HTTP port')} v={network?.InternalHttpPort ?? t('Unavailable')} /><InfoRow k={t('HTTPS port')} v={network ? (network.EnableHttps ? network.InternalHttpsPort : t('HTTPS disabled')) : t('Unavailable')} /><p class="ad-note">{t('The server does not report its operating system or uptime.')}</p></Card>}
            {encoder && <Card title={t('Hardware acceleration')}><InfoRow k={t('Detected acceleration types')} v={(encoder.AvailableAccelerationTypes || []).join(', ') || t('None detected')} /><InfoRow k={t('FFmpeg accelerators')} v={(encoder.Hwaccels || []).join(', ') || t('None detected')} /><details class="ad-rbac-row"><summary>{t('Encoder capability details')}</summary><pre class="ad-json">{JSON.stringify({ HardwareEncoding: encoder.HardwareEncoding, HardwareDecodingCodecs: encoder.HardwareDecodingCodecs }, null, 2)}</pre></details></Card>}
            {stats && <Card title={t('Query optimisations')}><InfoRow k={t('Movies Latest')} v={stats.OptimizeMoviesLatest ? t('Enabled') : t('Disabled')} /><InfoRow k={t('TV Latest')} v={stats.OptimizeTvLatest ? t('Enabled') : t('Disabled')} /><InfoRow k={t('Music Latest')} v={stats.OptimizeMusicLatest ? t('Enabled') : t('Disabled')} /><InfoRow k={t('NextUp')} v={stats.OptimizeNextUp ? t('Enabled') : t('Disabled')} /></Card>}
        </div>}
        {tab === 'Tasks' && <Card title={t('Scheduled tasks')}><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder={t('Search tasks…')} /></div>{taskError && <p role="alert" class="ad-error">{taskError}</p>}<DataTable rows={tasks} columns={taskColumns} getKey={task => task.Id} query={search} empty={t('No scheduled tasks')} /></Card>}
        {tab === 'Devices' && <Card title={t('Authorised devices')}><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder={t('Search devices…')} /></div><DataTable rows={devices} columns={deviceColumns} getKey={d => d.Id || d.Name || ''} query={search} empty={t('No devices')} /></Card>}
        {tab === 'Logs' && <Card title={t('Server logs')}>
            {logs.length === 0 ? <Empty muted>{t('No server logs are exposed.')}</Empty> : <LiveLogViewer api={api} logName={logName} onNameChange={setLogName} />}
        </Card>}
        {tab === 'Logs' && <ConfigSection api={api} path="/System/Configuration" title={t('Logging')} fields={LOGGING_FIELDS} />}
    </PageShell>;
}
