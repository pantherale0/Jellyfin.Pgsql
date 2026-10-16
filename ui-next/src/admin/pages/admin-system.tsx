import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi, BackupManifest } from '../admin-api';
import type { SystemInfo, PluginInfo, ApiKey, ScheduledTask, SystemStorage, FolderStorage, PgsqlStatsSnapshot, DeviceInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, Tabs, InfoRow, ConfirmButton, timeAgo, DataTable, SearchInput, ConfigSection, SettingsFields } from '../ui';
import {
    BRANDING_FIELDS, DEVICE_PLAYBACK_FIELDS, GENERAL_FIELDS, NETWORK_FIELDS, WEEK_DAYS, buildTrigger, describeTrigger, devicePlaybackDraft, devicePlaybackPayload,
    type TaskTrigger, type TriggerForm,
} from '../server-settings';
import { RESTORE_MESSAGES, waitForRestart } from '../server-restart';
import { t } from '../../i18n';

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
    const [copiedKey, setCopiedKey] = useState('');
    const [taskBusy, setTaskBusy] = useState('');
    const [taskError, setTaskError] = useState('');
    const [search, setSearch] = useState('');
    const [backups, setBackups] = useState<Array<{ Path: string; ServerVersion: string; DateCreated: string }> | null>(null);
    const [backupOptions, setBackupOptions] = useState({ Metadata: false, Trickplay: false, Subtitles: false });
    const [manifest, setManifest] = useState<{ path: string; value: BackupManifest | null; error: string } | null>(null);
    const [restartState, setRestartState] = useState('');
    const [cultures, setCultures] = useState<Array<[string, string]>>([]);
    const [taskId, setTaskId] = useState('');
    const [deviceId, setDeviceId] = useState('');

    const load = useCallback(async () => {
        const [sysInfo, pluginList, keyList, taskList, storageInfo, pgsqlStats, deviceList] = await Promise.all([
            api.getSystemInfo().catch(() => undefined),
            api.getPlugins().catch(() => undefined),
            api.getApiKeys().catch(() => undefined),
            api.getScheduledTasks().catch(() => undefined),
            api.getSystemStorage().catch(() => undefined),
            api.getPgsqlStats().catch(() => undefined),
            api.getDevices().catch(() => undefined),
        ]);
        if (sysInfo !== undefined) setSys(sysInfo);
        if (pluginList !== undefined) setPlugins(pluginList);
        if (keyList !== undefined) setKeys(keyList);
        if (taskList !== undefined) setTasks(taskList);
        if (storageInfo !== undefined) setStorage(storageInfo);
        if (pgsqlStats !== undefined) setStats(pgsqlStats);
        if (deviceList !== undefined) setDevices(deviceList.Items || []);
    }, [api]);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => { api.getLocalizationOptions().then(options => setCultures(options.filter(o => o.Value).map(o => [o.Value!, o.Name || o.Value!]))).catch(() => undefined); }, [api]);
    useEffect(() => { if (tab === 'Backups') void api.getBackups().then(setBackups); }, [api, tab]);

    const taskColumns = [
        { key: 'Name', label: t('Task'), value: (task: ScheduledTask) => task.Name || '—', searchValue: (task: ScheduledTask) => task.Name || '' },
        { key: 'State', label: t('State'), value: (task: ScheduledTask) => task.State || '—' },
        { key: 'Last', label: t('Last run'), value: (task: ScheduledTask) => task.LastExecutionResult?.EndTimeUtc ? timeAgo(task.LastExecutionResult.EndTimeUtc) : 'Not run' },
        { key: 'Result', label: t('Result'), value: (task: ScheduledTask) => task.LastExecutionResult?.Status || '—' },
        { key: 'Schedule', label: '', value: (task: ScheduledTask) => <button class="ad-btn" aria-expanded={taskId === task.Id} onClick={() => setTaskId(current => current === task.Id ? '' : task.Id)}>{t('Schedule')}</button> },
        { key: 'Action', label: '', value: (task: ScheduledTask) => task.State === 'Running' ? <ConfirmButton label={t('Stop')} tone="danger" busy={taskBusy === task.Id} onConfirm={async () => { setTaskBusy(task.Id); setTaskError(''); try { await api.stopTask(task.Id); await load(); } catch (e) { setTaskError(e instanceof Error ? e.message : t('Task action failed.')); } finally { setTaskBusy(''); } }} /> : <button class="ad-btn" disabled={taskBusy === task.Id} onClick={async () => { setTaskBusy(task.Id); setTaskError(''); try { await api.startTask(task.Id); await load(); } catch (e) { setTaskError(e instanceof Error ? e.message : t('Task action failed.')); } finally { setTaskBusy(''); } }}>{taskBusy === task.Id ? t('Working…') : t('Run now')}</button> },
    ];

    const pluginColumns = [
        { key: 'Name', label: t('Plugin'), value: (p: PluginInfo) => p.Name || '—', searchValue: (p: PluginInfo) => p.Name || '' },
        { key: 'Version', label: t('Version'), value: (p: PluginInfo) => p.Version || '—' },
        { key: 'Status', label: t('Status'), value: (p: PluginInfo) => <StatusChip tone={p.Status === 'Active' ? 'green' : p.Status === 'Malfunctioned' ? 'red' : 'muted'}>{p.Status || t('Not reported')}</StatusChip> },
    ];

    const copyKey = async (token: string) => {
        try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(token);
            else {
                const area = document.createElement('textarea');
                area.value = token;
                document.body.appendChild(area);
                area.select();
                document.execCommand('copy');
                area.remove();
            }
            setCopiedKey(token);
            window.setTimeout(() => setCopiedKey(current => current === token ? '' : current), 3000);
        } catch { setKeyMessage(t('Copy failed. Select the revealed token manually.')); }
    };
    const keyColumns = [
        { key: 'App', label: t('Application'), value: (k: ApiKey) => k.AppName || '—' },
        { key: 'Token', label: t('Token'), value: (k: ApiKey) => k.AccessToken ? <span class="ad-flex">{copiedKey === k.AccessToken ? <code class="ad-path">{k.AccessToken}</code> : `${k.AccessToken.slice(0, 8)}…`} <button class="ad-btn" onClick={() => void copyKey(k.AccessToken!)}>{copiedKey === k.AccessToken ? t('Copied') : t('Copy')}</button></span> : '—' },
        { key: 'Action', label: '', value: (k: ApiKey) => k.AccessToken ? <ConfirmButton label={t('Revoke')} tone="danger" onConfirm={async () => { await api.revokeKey(k.AccessToken!); await load(); }} /> : null },
    ];

    const createKey = async () => {
        if (!newKeyName.trim()) return;
        await api.createApiKey(newKeyName.trim());
        setNewKeyName(''); setKeyMessage(t('Key created. Use Copy on its row to reveal and copy the token.'));
        await load();
    };

    const storageMounts = storage ? ([['Program data', storage.ProgramDataFolder], ['Web', storage.WebFolder], ['Image cache', storage.ImageCacheFolder], ['Cache', storage.CacheFolder], ['Metadata', storage.InternalMetadataFolder], ['Transcode temp', storage.TranscodingTempFolder], ['Logs', storage.LogFolder]] as Array<[string, FolderStorage | undefined]>)
        .filter((entry): entry is [string, FolderStorage] => !!entry[1]) : [];
    return <PageShell title={t('System')} subtitle={t('Configuration, maintenance and operational tools')} actions={<button class="ad-btn" onClick={load}>{t('Refresh')}</button>}>
        <Tabs tabs={['General', 'Network & keys', 'Branding', 'Devices', 'Scheduled tasks', 'Plugins', 'Backups', 'Storage', 'Fork status', 'Danger zone']} value={tab} onPick={setTab} />
        {tab === 'General' && <>
            <div class="ad-grid2">
                <Card title={t('Server')}><InfoRow k={t('Name')} v={sys?.ServerName || t('Unavailable')} /><InfoRow k={t('Version')} v={sys?.Version || t('Unavailable')} />{sys?.SystemArchitecture && <InfoRow k={t('Architecture')} v={sys.SystemArchitecture} />}{sys?.PackageName && <InfoRow k={t('Package')} v={sys.PackageName} />}{sys && <InfoRow k={t('Restart pending')} v={sys.HasPendingRestart ? t('Yes') : t('No')} />}</Card>
                <Card title={t('Maintenance')}><div class="ad-flex"><ConfirmButton label={t('Restart server')} onConfirm={() => api.restartServer()} /><ConfirmButton label={t('Shut down')} tone="danger" onConfirm={() => api.shutdownServer()} /></div></Card>
            </div>
            <ConfigSection api={api} path="/System/Configuration" title={t('General settings')} fields={GENERAL_FIELDS} options={{ UICulture: cultures }} validate={draft => String(draft.ServerName || '').trim() ? '' : t('Server name is required.')} onSaved={() => void api.getSystemInfo().then(setSys).catch(() => undefined)} />
        </>}
        {tab === 'Network & keys' && <>
            <ConfigSection api={api} path="/System/Configuration/network" title={t('Network')} fields={NETWORK_FIELDS} note={t('Network changes may require a server restart. Unrelated network settings are preserved.')}
                validate={draft => draft.EnableHttps && !String(draft.CertificatePath || '').trim() && draft.RequireHttps ? t('Requiring HTTPS needs a certificate path.') : ''} />
            <Card title={t('API keys')}>
                <div class="ad-toolbar"><input class="ad-search" placeholder={t('Application name')} value={newKeyName} onInput={e => setNewKeyName((e.currentTarget as HTMLInputElement).value)} /><button class="ad-btn" disabled={!newKeyName.trim()} onClick={createKey}>{t('Create key')}</button></div>
                {keyMessage && <p class="ad-note" role="status">{keyMessage}</p>}
                <DataTable rows={keys} columns={keyColumns} getKey={k => k.AccessToken || k.AppName || ''} empty={t('No API keys')} query={search} />
            </Card>
        </>}
        {tab === 'Branding' && <ConfigSection api={api} path="/System/Configuration/branding" title={t('Branding')} fields={BRANDING_FIELDS} />}
        {tab === 'Devices' && <><Card title={t('Authorised devices')}><DataTable rows={devices} columns={[
            { key: 'Name', label: t('Device'), value: (d: DeviceInfo) => <>{d.CustomName || d.Name || '—'}{d.CustomName && d.Name && <div class="ad-cell-sub">{d.Name}</div>}</>, searchValue: (d: DeviceInfo) => `${d.CustomName || ''} ${d.Name || ''}` },
            { key: 'User', label: t('Last user'), value: (d: DeviceInfo) => d.LastUserName || '—' },
            { key: 'App', label: t('Application'), value: (d: DeviceInfo) => `${d.AppName || ''} ${d.AppVersion || ''}` },
            { key: 'Activity', label: t('Last activity'), value: (d: DeviceInfo) => timeAgo(d.DateLastActivity) },
            { key: 'Edit', label: '', value: (d: DeviceInfo) => d.Id ? <button class="ad-btn" aria-expanded={deviceId === d.Id} onClick={() => setDeviceId(current => current === d.Id ? '' : d.Id!)}>{t('Edit')}</button> : null },
            { key: 'Action', label: '', value: (d: DeviceInfo) => d.Id ? <ConfirmButton label={t('Revoke')} tone="danger" onConfirm={async () => { await api.deleteDevice(d.Id!); await load(); }} /> : null },
        ]} getKey={d => d.Id || d.Name || ''} empty={t('No devices')} /></Card>
        {deviceId && devices.some(d => d.Id === deviceId) && <DeviceEditor key={deviceId} api={api} device={devices.find(d => d.Id === deviceId)!} onSaved={load} onClose={() => setDeviceId('')} />}</>}
        {tab === 'Scheduled tasks' && <Card title={t('Scheduled tasks')}><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder={t('Search tasks…')} /></div>{taskError && <p role="alert" class="ad-error">{taskError}</p>}<DataTable rows={tasks} columns={taskColumns} getKey={task => task.Id} query={search} empty={t('No scheduled tasks')} /></Card>}
        {tab === 'Scheduled tasks' && taskId && <TaskSchedule key={taskId} api={api} taskId={taskId} onClose={() => setTaskId('')} />}
        {tab === 'Plugins' && <Card title={t('Installed plugins')}><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder={t('Search plugins…')} /></div><DataTable rows={plugins} columns={pluginColumns} getKey={p => p.Id || p.Guid || p.Name || ''} query={search} empty={t('No plugins installed')} /></Card>}
        {tab === 'Backups' && <Card title={t('Backup & restore')}>{restartState && <p role="status" class="ad-note">{restartState}</p>}{backups === null ? <Empty muted>{t('Backup listing is loading or unavailable on this server.')}</Empty> : <><div class="ad-toolbar">
            <span class="ad-flex" role="group" aria-label={t('Backup contents')}><label class="ad-policy-row"><span>{t('Database')}</span><input type="checkbox" checked disabled /></label>{(['Metadata', 'Trickplay', 'Subtitles'] as const).map(key => <label key={key} class="ad-policy-row"><span>{key}</span><input type="checkbox" checked={backupOptions[key]} onChange={e => setBackupOptions(old => ({ ...old, [key]: e.currentTarget.checked }))} /></label>)}</span>
            <ConfirmButton label={t('Create backup')} onConfirm={async () => { await api.createBackup(backupOptions); setBackups(await api.getBackups()); }} /></div><DataTable rows={backups} getKey={b => b.Path} empty={t('No backups have been created')} columns={[
            { key: 'Name', label: t('Archive'), value: (b: typeof backups[number]) => b.Path.split(/[\\/]/).pop() || b.Path },
            { key: 'Created', label: t('Created'), value: (b: typeof backups[number]) => new Date(b.DateCreated).toLocaleString(), searchValue: (b: typeof backups[number]) => b.DateCreated },
            { key: 'Version', label: t('Server version'), value: (b: typeof backups[number]) => b.ServerVersion },
            { key: 'Inspect', label: '', value: (b: typeof backups[number]) => <button class="ad-btn" onClick={async () => {
                setManifest({ path: b.Path, value: null, error: '' });
                try { const value = await api.getBackupManifest(b.Path); setManifest(current => current?.path === b.Path ? { path: b.Path, value, error: '' } : current); }
                catch (e) { setManifest(current => current?.path === b.Path ? { path: b.Path, value: null, error: e instanceof Error ? e.message : t('The archive could not be inspected.') } : current); }
            }}>{t('Inspect')}</button> },
            { key: 'Restore', label: '', value: (b: typeof backups[number]) => <ConfirmButton label={t('Restore and restart server')} tone="danger" onConfirm={async () => { await api.restoreBackup(b.Path); void waitForRestart(api, setRestartState, RESTORE_MESSAGES); }} /> },
        ]} />
        {manifest && <div class="ad-backup-manifest" aria-live="polite"><h4>{manifest.path.split(/[\\/]/).pop()}</h4>{manifest.error ? <p role="alert" class="ad-error">{manifest.error}</p> : !manifest.value ? <p class="ad-note">{t('Reading archive…')}</p> : <>
            <InfoRow k={t('Server version')} v={manifest.value.ServerVersion || '—'} /><InfoRow k={t('Backup engine')} v={manifest.value.BackupEngineVersion || '—'} /><InfoRow k={t('Created')} v={manifest.value.DateCreated ? new Date(manifest.value.DateCreated).toLocaleString() : '—'} />
            <InfoRow k={t('Contents')} v={Object.entries(manifest.value.Options || {}).filter(([, on]) => on).map(([key]) => key).join(', ') || t('Database')} />
        </>}<button class="ad-btn" onClick={() => setManifest(null)}>{t('Close')}</button></div>}
        <p class="ad-note">{t('Restore replaces server data and restarts Jellyfin. This page reports when the server is reachable again.')}</p></>}</Card>}
        {tab === 'Storage' && (storageMounts.length ? <Card title={t('System storage')}>
            {storageMounts.map(([label, mount]) => <StorageInfo key={label} label={label} mount={mount} />)}
        </Card> : <Empty muted>{t('System storage metrics are unavailable')}</Empty>)}
        {tab === 'Fork status' && (stats ? <Card title={t('Pgsql runtime status')}><InfoRow k={t('Cache backend')} v={stats.CacheBackend} /><InfoRow k={t('Cache active')} v={stats.CacheActive ? t('Yes') : t('No')} /><InfoRow k={t('Redis availability')} v={stats.RedisAvailability} /><InfoRow k={t('Redis connected')} v={stats.RedisConnected ? t('Yes') : t('No')} /><InfoRow k={t('Browse hit / miss')} v={`${stats.BrowseCacheHits} / ${stats.BrowseCacheMisses}`} /><InfoRow k={t('Latest hit / miss')} v={`${stats.LatestCacheHits} / ${stats.LatestCacheMisses}`} /><InfoRow k={t('Effective browse TTL')} v={`${stats.BrowseTtlSeconds}s`} /></Card> : <Empty muted>{t('Pgsql runtime status unavailable')}</Empty>)}
        {tab === 'Danger zone' && <Card title={t('Danger zone')}><div class="ad-danger"><p>{t('Server shutdown stops playback and background work.')}</p><ConfirmButton label={t('Shut down server')} tone="danger" onConfirm={() => api.shutdownServer()} /><p class="ad-note">{t('Cache flush and database reset operations are not exposed by the current server APIs.')}</p></div></Card>}
    </PageShell>;
}

const EMPTY_TRIGGER: TriggerForm = { type: 'DailyTrigger', time: '03:00', day: 'Sunday', intervalHours: '24', maxRuntimeHours: '' };

function TaskSchedule({ api, taskId, onClose }: { api: AdminApi; taskId: string; onClose: () => void }) {
    const [task, setTask] = useState<ScheduledTask | null>(null);
    const [error, setError] = useState('');
    const [form, setForm] = useState<TriggerForm>(EMPTY_TRIGGER);
    const [message, setMessage] = useState('');
    useEffect(() => {
        let active = true;
        api.getScheduledTask(taskId).then(value => { if (active) setTask(value); }).catch(e => { if (active) setError(e instanceof Error ? e.message : t('The task could not be loaded.')); });
        return () => { active = false; };
    }, [api, taskId]);
    const save = async (triggers: TaskTrigger[], done: string) => {
        await api.updateTaskTriggers(taskId, triggers);
        setTask(await api.getScheduledTask(taskId));
        setMessage(done);
    };
    return <Card title={task?.Name ? t('Schedule · {0}', task.Name) : t('Task schedule')} actions={<button class="ad-btn" onClick={onClose}>{t('Close')}</button>}>
        {error && <p role="alert" class="ad-error">{error}</p>}
        {!task && !error && <p role="status" class="ad-note">{t('Loading task…')}</p>}
        {task && <>
            {task.Description && <p class="ad-note">{task.Description}</p>}
            {task.Category && <InfoRow k={t('Category')} v={task.Category} />}
            {task.LastExecutionResult?.ErrorMessage && <InfoRow k={t('Last error')} v={task.LastExecutionResult.ErrorMessage} />}
            <h4>{t('Triggers')}</h4>
            {(task.Triggers || []).length === 0 ? <Empty muted>{t('This task only runs manually.')}</Empty> : (task.Triggers || []).map((trigger, index) => <div class="ad-info" key={index}><span class="ad-info-k">{describeTrigger(trigger)}</span><ConfirmButton label={t('Remove')} tone="danger" onConfirm={() => save((task.Triggers || []).filter((_, i) => i !== index), t('Trigger removed.'))} /></div>)}
            <h4>{t('Add trigger')}</h4>
            <div class="ad-form-grid">
                <label class="ad-form-field"><span class="ad-form-label">{t('Type')}</span><select class="ad-form-input" value={form.type} onChange={e => setForm(old => ({ ...old, type: e.currentTarget.value as TriggerForm['type'] }))}><option value="DailyTrigger">{t('Daily')}</option><option value="WeeklyTrigger">{t('Weekly')}</option><option value="IntervalTrigger">{t('Interval')}</option><option value="StartupTrigger">{t('On startup')}</option></select></label>
                {form.type === 'WeeklyTrigger' && <label class="ad-form-field"><span class="ad-form-label">{t('Day')}</span><select class="ad-form-input" value={form.day} onChange={e => setForm(old => ({ ...old, day: e.currentTarget.value }))}>{WEEK_DAYS.map(day => <option key={day} value={day}>{t(day)}</option>)}</select></label>}
                {(form.type === 'DailyTrigger' || form.type === 'WeeklyTrigger') && <label class="ad-form-field"><span class="ad-form-label">{t('Time (server local)')}</span><input class="ad-form-input" type="time" value={form.time} onInput={e => setForm(old => ({ ...old, time: e.currentTarget.value }))} /></label>}
                {form.type === 'IntervalTrigger' && <label class="ad-form-field"><span class="ad-form-label">{t('Every (hours)')}</span><input class="ad-form-input" type="number" min="0.25" step="0.25" value={form.intervalHours} onInput={e => setForm(old => ({ ...old, intervalHours: e.currentTarget.value }))} /></label>}
                <label class="ad-form-field"><span class="ad-form-label">{t('Time limit (hours, optional)')}</span><input class="ad-form-input" type="number" min="0" step="0.5" value={form.maxRuntimeHours} onInput={e => setForm(old => ({ ...old, maxRuntimeHours: e.currentTarget.value }))} /></label>
            </div>
            <ConfirmButton label={t('Add trigger')} onConfirm={async () => {
                const trigger = buildTrigger(form);
                if ('error' in trigger) throw new Error(trigger.error);
                await save([ ...(task.Triggers || []), trigger ], t('Trigger added.'));
                setForm(EMPTY_TRIGGER);
            }} />
            {message && <p role="status" class="ad-note">{message}</p>}
        </>}
    </Card>;
}

function DeviceEditor({ api, device, onSaved, onClose }: { api: AdminApi; device: DeviceInfo; onSaved: () => void | Promise<void>; onClose: () => void }) {
    const [name, setName] = useState(device.CustomName || '');
    const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    useEffect(() => {
        let active = true;
        api.getDeviceOptions(device.Id!).then(options => {
            if (!active) return;
            setName(options.customName || '');
            setDraft(devicePlaybackDraft(options.playbackOptions));
        }).catch(e => { if (active) setError(e instanceof Error ? e.message : t('Device options could not be loaded.')); });
        return () => { active = false; };
    }, [api, device.Id]);
    return <Card title={`Device · ${device.CustomName || device.Name || t('Unknown')}`} actions={<button class="ad-btn" onClick={onClose}>{t('Close')}</button>}>
        {error && <p role="alert" class="ad-error">{error}</p>}
        {!draft && !error && <p role="status" class="ad-note">{t('Loading device options…')}</p>}
        {draft && <>
            <label class="ad-form-field"><span class="ad-form-label">{t('Custom name')}</span><input class="ad-form-input" value={name} maxLength={100} placeholder={device.Name} onInput={e => setName(e.currentTarget.value)} /></label>
            <h4>{t('Playback overrides')}</h4>
            <p class="ad-note">{t('Inherit uses the user and server settings. Overrides apply to new playback on this device only.')}</p>
            <SettingsFields fields={DEVICE_PLAYBACK_FIELDS} draft={draft as Record<string, any>} onChange={setDraft} />
            <div class="ad-flex">
                <ConfirmButton label={t('Save device')} onConfirm={async () => {
                    if (name.trim() !== (device.CustomName || '')) await api.saveDeviceName(device.Id!, name.trim());
                    await api.saveDevicePlaybackOptions(device.Id!, devicePlaybackPayload(draft));
                    setMessage(t('Device saved.'));
                    await onSaved();
                }} />
                <ConfirmButton label={t('Clear overrides')} tone="danger" onConfirm={async () => { await api.saveDevicePlaybackOptions(device.Id!, {}); setDraft({}); setMessage(t('Overrides cleared.')); }} />
            </div>
            {message && <p role="status" class="ad-note">{message}</p>}
        </>}
    </Card>;
}

function StorageInfo({ label, mount }: { label: string; mount: { Path: string; UsedSpace: number; FreeSpace: number; StorageType?: string } }) {
    const total = mount.UsedSpace + mount.FreeSpace;
    const pct = total > 0 ? mount.UsedSpace / total * 100 : 0;
    const color = pct > 90 ? '#EF4444' : pct > 70 ? '#F59E0B' : '#22C55E';
    return <div class="ad-storage-info"><InfoRow k={label} v={t('{0} free · {1}% used', formatBytes(mount.FreeSpace), pct.toFixed(0))} /><div class="ad-path">{mount.Path}{mount.StorageType ? ` · ${mount.StorageType}` : ''}</div>{total > 0 && <div class="ad-storage-track"><i style={{ width: `${pct}%`, background: color }} /></div>}</div>;
}

function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return 'Unavailable';
    const g = n / 1024 ** 3;
    return g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g.toFixed(1)} GB`;
}
