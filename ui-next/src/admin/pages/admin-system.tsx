import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi, BackupManifest } from '../admin-api';
import type { SystemInfo, PluginInfo, ApiKey, ScheduledTask, SystemStorage, PgsqlStatsSnapshot, DeviceInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, Tabs, InfoRow, ConfirmButton, timeAgo, DataTable, SearchInput, ConfigSection, SettingsFields } from '../ui';
import {
    BRANDING_FIELDS, DEVICE_PLAYBACK_FIELDS, GENERAL_FIELDS, NETWORK_FIELDS, WEEK_DAYS, buildTrigger, describeTrigger, devicePlaybackDraft, devicePlaybackPayload,
    type TaskTrigger, type TriggerForm,
} from '../server-settings';

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
        { key: 'Name', label: 'Task', value: (t: ScheduledTask) => t.Name || '—', searchValue: (t: ScheduledTask) => t.Name || '' },
        { key: 'State', label: 'State', value: (t: ScheduledTask) => t.State || '—' },
        { key: 'Last', label: 'Last run', value: (t: ScheduledTask) => t.LastExecutionResult?.EndTimeUtc ? timeAgo(t.LastExecutionResult.EndTimeUtc) : 'Not run' },
        { key: 'Result', label: 'Result', value: (t: ScheduledTask) => t.LastExecutionResult?.Status || '—' },
        { key: 'Schedule', label: '', value: (t: ScheduledTask) => <button class="ad-btn" aria-expanded={taskId === t.Id} onClick={() => setTaskId(current => current === t.Id ? '' : t.Id)}>Schedule</button> },
        { key: 'Action', label: '', value: (t: ScheduledTask) => t.State === 'Running' ? <ConfirmButton label="Stop" tone="danger" busy={taskBusy === t.Id} onConfirm={async () => { setTaskBusy(t.Id); setTaskError(''); try { await api.stopTask(t.Id); await load(); } catch (e) { setTaskError(e instanceof Error ? e.message : 'Task action failed.'); } finally { setTaskBusy(''); } }} /> : <button class="ad-btn" disabled={taskBusy === t.Id} onClick={async () => { setTaskBusy(t.Id); setTaskError(''); try { await api.startTask(t.Id); await load(); } catch (e) { setTaskError(e instanceof Error ? e.message : 'Task action failed.'); } finally { setTaskBusy(''); } }}>{taskBusy === t.Id ? 'Working…' : 'Run now'}</button> },
    ];

    const pluginColumns = [
        { key: 'Name', label: 'Plugin', value: (p: PluginInfo) => p.Name || '—', searchValue: (p: PluginInfo) => p.Name || '' },
        { key: 'Version', label: 'Version', value: (p: PluginInfo) => p.Version || '—' },
        { key: 'Status', label: 'Status', value: (p: PluginInfo) => <StatusChip tone={p.Status === 'Active' ? 'green' : p.Status === 'Malfunctioned' ? 'red' : 'muted'}>{p.Status || 'Not reported'}</StatusChip> },
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
        } catch { setKeyMessage('Copy failed. Select the revealed token manually.'); }
    };
    const keyColumns = [
        { key: 'App', label: 'Application', value: (k: ApiKey) => k.AppName || '—' },
        { key: 'Token', label: 'Token', value: (k: ApiKey) => k.AccessToken ? <span class="ad-flex">{copiedKey === k.AccessToken ? <code class="ad-path">{k.AccessToken}</code> : `${k.AccessToken.slice(0, 8)}…`} <button class="ad-btn" onClick={() => void copyKey(k.AccessToken!)}>{copiedKey === k.AccessToken ? 'Copied' : 'Copy'}</button></span> : '—' },
        { key: 'Action', label: '', value: (k: ApiKey) => k.AccessToken ? <ConfirmButton label="Revoke" tone="danger" onConfirm={async () => { await api.revokeKey(k.AccessToken!); await load(); }} /> : null },
    ];

    const createKey = async () => {
        if (!newKeyName.trim()) return;
        await api.createApiKey(newKeyName.trim());
        setNewKeyName(''); setKeyMessage('Key created. Use Copy on its row to reveal and copy the token.');
        await load();
    };

    return <PageShell title="System" subtitle="Configuration, maintenance and operational tools" actions={<button class="ad-btn" onClick={load}>Refresh</button>}>
        <Tabs tabs={['General', 'Network & keys', 'Branding', 'Devices', 'Scheduled tasks', 'Plugins', 'Backups', 'Storage', 'Fork status', 'Danger zone']} value={tab} onPick={setTab} />
        {tab === 'General' && <>
            <div class="ad-grid2">
                <Card title="Server"><InfoRow k="Name" v={sys?.ServerName || 'Unavailable'} /><InfoRow k="Version" v={sys?.Version || 'Unavailable'} />{sys?.SystemArchitecture && <InfoRow k="Architecture" v={sys.SystemArchitecture} />}{sys?.PackageName && <InfoRow k="Package" v={sys.PackageName} />}{sys && <InfoRow k="Restart pending" v={sys.HasPendingRestart ? 'Yes' : 'No'} />}</Card>
                <Card title="Maintenance"><div class="ad-flex"><ConfirmButton label="Restart server" onConfirm={() => api.restartServer()} /><ConfirmButton label="Shut down" tone="danger" onConfirm={() => api.shutdownServer()} /></div></Card>
            </div>
            <ConfigSection api={api} path="/System/Configuration" title="General settings" fields={GENERAL_FIELDS} options={{ UICulture: cultures }} validate={draft => String(draft.ServerName || '').trim() ? '' : 'Server name is required.'} onSaved={() => void api.getSystemInfo().then(setSys).catch(() => undefined)} />
        </>}
        {tab === 'Network & keys' && <>
            <ConfigSection api={api} path="/System/Configuration/network" title="Network" fields={NETWORK_FIELDS} note="Network changes may require a server restart. Unrelated network settings are preserved."
                validate={draft => draft.EnableHttps && !String(draft.CertificatePath || '').trim() && draft.RequireHttps ? 'Requiring HTTPS needs a certificate path.' : ''} />
            <Card title="API keys">
                <div class="ad-toolbar"><input class="ad-search" placeholder="Application name" value={newKeyName} onInput={e => setNewKeyName((e.currentTarget as HTMLInputElement).value)} /><button class="ad-btn" disabled={!newKeyName.trim()} onClick={createKey}>Create key</button></div>
                {keyMessage && <p class="ad-note" role="status">{keyMessage}</p>}
                <DataTable rows={keys} columns={keyColumns} getKey={k => k.AccessToken || k.AppName || ''} empty="No API keys" query={search} />
            </Card>
        </>}
        {tab === 'Branding' && <ConfigSection api={api} path="/System/Configuration/branding" title="Branding" fields={BRANDING_FIELDS} />}
        {tab === 'Devices' && <><Card title="Authorised devices"><DataTable rows={devices} columns={[
            { key: 'Name', label: 'Device', value: (d: DeviceInfo) => <>{d.CustomName || d.Name || '—'}{d.CustomName && d.Name && <div class="ad-cell-sub">{d.Name}</div>}</>, searchValue: (d: DeviceInfo) => `${d.CustomName || ''} ${d.Name || ''}` },
            { key: 'User', label: 'Last user', value: (d: DeviceInfo) => d.LastUserName || '—' },
            { key: 'App', label: 'Application', value: (d: DeviceInfo) => `${d.AppName || ''} ${d.AppVersion || ''}` },
            { key: 'Activity', label: 'Last activity', value: (d: DeviceInfo) => timeAgo(d.DateLastActivity) },
            { key: 'Edit', label: '', value: (d: DeviceInfo) => d.Id ? <button class="ad-btn" aria-expanded={deviceId === d.Id} onClick={() => setDeviceId(current => current === d.Id ? '' : d.Id!)}>Edit</button> : null },
            { key: 'Action', label: '', value: (d: DeviceInfo) => d.Id ? <ConfirmButton label="Revoke" tone="danger" onConfirm={async () => { await api.deleteDevice(d.Id!); await load(); }} /> : null },
        ]} getKey={d => d.Id || d.Name || ''} empty="No devices" /></Card>
        {deviceId && devices.some(d => d.Id === deviceId) && <DeviceEditor key={deviceId} api={api} device={devices.find(d => d.Id === deviceId)!} onSaved={load} onClose={() => setDeviceId('')} />}</>}
        {tab === 'Scheduled tasks' && <Card title="Scheduled tasks"><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search tasks…" /></div>{taskError && <p role="alert" class="ad-error">{taskError}</p>}<DataTable rows={tasks} columns={taskColumns} getKey={t => t.Id} query={search} empty="No scheduled tasks" /></Card>}
        {tab === 'Scheduled tasks' && taskId && <TaskSchedule key={taskId} api={api} taskId={taskId} onClose={() => setTaskId('')} />}
        {tab === 'Plugins' && <Card title="Installed plugins"><div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search plugins…" /></div><DataTable rows={plugins} columns={pluginColumns} getKey={p => p.Id || p.Guid || p.Name || ''} query={search} empty="No plugins installed" /></Card>}
        {tab === 'Backups' && <Card title="Backup & restore">{restartState && <p role="status" class="ad-note">{restartState}</p>}{backups === null ? <Empty muted>Backup listing is loading or unavailable on this server.</Empty> : <><div class="ad-toolbar">
            <span class="ad-flex" role="group" aria-label="Backup contents"><label class="ad-policy-row"><span>Database</span><input type="checkbox" checked disabled /></label>{(['Metadata', 'Trickplay', 'Subtitles'] as const).map(key => <label key={key} class="ad-policy-row"><span>{key}</span><input type="checkbox" checked={backupOptions[key]} onChange={e => setBackupOptions(old => ({ ...old, [key]: e.currentTarget.checked }))} /></label>)}</span>
            <ConfirmButton label="Create backup" onConfirm={async () => { await api.createBackup(backupOptions); setBackups(await api.getBackups()); }} /></div><DataTable rows={backups} getKey={b => b.Path} empty="No backups have been created" columns={[
            { key: 'Name', label: 'Archive', value: (b: typeof backups[number]) => b.Path.split(/[\\/]/).pop() || b.Path },
            { key: 'Created', label: 'Created', value: (b: typeof backups[number]) => new Date(b.DateCreated).toLocaleString(), searchValue: (b: typeof backups[number]) => b.DateCreated },
            { key: 'Version', label: 'Server version', value: (b: typeof backups[number]) => b.ServerVersion },
            { key: 'Inspect', label: '', value: (b: typeof backups[number]) => <button class="ad-btn" onClick={async () => {
                setManifest({ path: b.Path, value: null, error: '' });
                try { const value = await api.getBackupManifest(b.Path); setManifest(current => current?.path === b.Path ? { path: b.Path, value, error: '' } : current); }
                catch (e) { setManifest(current => current?.path === b.Path ? { path: b.Path, value: null, error: e instanceof Error ? e.message : 'The archive could not be inspected.' } : current); }
            }}>Inspect</button> },
            { key: 'Restore', label: '', value: (b: typeof backups[number]) => <ConfirmButton label="Restore and restart server" tone="danger" onConfirm={async () => { await api.restoreBackup(b.Path); void waitForRestart(api, setRestartState); }} /> },
        ]} />
        {manifest && <div class="ad-backup-manifest" aria-live="polite"><h4>{manifest.path.split(/[\\/]/).pop()}</h4>{manifest.error ? <p role="alert" class="ad-error">{manifest.error}</p> : !manifest.value ? <p class="ad-note">Reading archive…</p> : <>
            <InfoRow k="Server version" v={manifest.value.ServerVersion || '—'} /><InfoRow k="Backup engine" v={manifest.value.BackupEngineVersion || '—'} /><InfoRow k="Created" v={manifest.value.DateCreated ? new Date(manifest.value.DateCreated).toLocaleString() : '—'} />
            <InfoRow k="Contents" v={Object.entries(manifest.value.Options || {}).filter(([, on]) => on).map(([key]) => key).join(', ') || 'Database'} />
        </>}<button class="ad-btn" onClick={() => setManifest(null)}>Close</button></div>}
        <p class="ad-note">Restore replaces server data and restarts Jellyfin. This page reports when the server is reachable again.</p></>}</Card>}
        {tab === 'Storage' && (storage ? <Card title="System storage">
            {[['Program data', storage.ProgramDataFolder], ['Web', storage.WebFolder], ['Image cache', storage.ImageCacheFolder], ['Cache', storage.CacheFolder], ['Metadata', storage.InternalMetadataFolder], ['Transcode temp', storage.TranscodingTempFolder], ['Logs', storage.LogFolder]].map(([label, mount]) => <StorageInfo key={label as string} label={label as string} mount={mount as SystemStorage['CacheFolder']} />)}
        </Card> : <Empty muted>System storage metrics are unavailable</Empty>)}
        {tab === 'Fork status' && (stats ? <Card title="Pgsql runtime status"><InfoRow k="Cache backend" v={stats.CacheBackend} /><InfoRow k="Cache active" v={stats.CacheActive ? 'Yes' : 'No'} /><InfoRow k="Redis availability" v={stats.RedisAvailability} /><InfoRow k="Redis connected" v={stats.RedisConnected ? 'Yes' : 'No'} /><InfoRow k="Browse hit / miss" v={`${stats.BrowseCacheHits} / ${stats.BrowseCacheMisses}`} /><InfoRow k="Latest hit / miss" v={`${stats.LatestCacheHits} / ${stats.LatestCacheMisses}`} /><InfoRow k="Effective browse TTL" v={`${stats.BrowseTtlSeconds}s`} /></Card> : <Empty muted>Pgsql runtime status unavailable</Empty>)}
        {tab === 'Danger zone' && <Card title="Danger zone"><div class="ad-danger"><p>Server shutdown stops playback and background work.</p><ConfirmButton label="Shut down server" tone="danger" onConfirm={() => api.shutdownServer()} /><p class="ad-note">Cache flush and database reset operations are not exposed by the current server APIs.</p></div></Card>}
    </PageShell>;
}

async function waitForRestart(api: AdminApi, report: (state: string) => void): Promise<void> {
    report('Restore started. Waiting for the server to restart…');
    const deadline = Date.now() + 10 * 60_000;
    let wentDown = false;
    while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 3000));
        try {
            await api.getPublicSystemInfo();
            if (wentDown) { report('The server is back online. Sign in again if your session was reset.'); return; }
        } catch {
            wentDown = true;
            report('The server is restarting and restoring data…');
        }
    }
    report(wentDown ? 'The server has not come back within 10 minutes. Check its logs.' : 'The server did not restart. Check its logs for restore errors.');
}

const EMPTY_TRIGGER: TriggerForm = { type: 'DailyTrigger', time: '03:00', day: 'Sunday', intervalHours: '24', maxRuntimeHours: '' };

function TaskSchedule({ api, taskId, onClose }: { api: AdminApi; taskId: string; onClose: () => void }) {
    const [task, setTask] = useState<ScheduledTask | null>(null);
    const [error, setError] = useState('');
    const [form, setForm] = useState<TriggerForm>(EMPTY_TRIGGER);
    const [message, setMessage] = useState('');
    useEffect(() => {
        let active = true;
        api.getScheduledTask(taskId).then(value => { if (active) setTask(value); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'The task could not be loaded.'); });
        return () => { active = false; };
    }, [api, taskId]);
    const save = async (triggers: TaskTrigger[], done: string) => {
        await api.updateTaskTriggers(taskId, triggers);
        setTask(await api.getScheduledTask(taskId));
        setMessage(done);
    };
    return <Card title={task?.Name ? `Schedule · ${task.Name}` : 'Task schedule'} actions={<button class="ad-btn" onClick={onClose}>Close</button>}>
        {error && <p role="alert" class="ad-error">{error}</p>}
        {!task && !error && <p role="status" class="ad-note">Loading task…</p>}
        {task && <>
            {task.Description && <p class="ad-note">{task.Description}</p>}
            {task.Category && <InfoRow k="Category" v={task.Category} />}
            {task.LastExecutionResult?.ErrorMessage && <InfoRow k="Last error" v={task.LastExecutionResult.ErrorMessage} />}
            <h4>Triggers</h4>
            {(task.Triggers || []).length === 0 ? <Empty muted>This task only runs manually.</Empty> : (task.Triggers || []).map((trigger, index) => <div class="ad-info" key={index}><span class="ad-info-k">{describeTrigger(trigger)}</span><ConfirmButton label="Remove" tone="danger" onConfirm={() => save((task.Triggers || []).filter((_, i) => i !== index), 'Trigger removed.')} /></div>)}
            <h4>Add trigger</h4>
            <div class="ad-form-grid">
                <label class="ad-form-field"><span class="ad-form-label">Type</span><select class="ad-form-input" value={form.type} onChange={e => setForm(old => ({ ...old, type: e.currentTarget.value as TriggerForm['type'] }))}><option value="DailyTrigger">Daily</option><option value="WeeklyTrigger">Weekly</option><option value="IntervalTrigger">Interval</option><option value="StartupTrigger">On startup</option></select></label>
                {form.type === 'WeeklyTrigger' && <label class="ad-form-field"><span class="ad-form-label">Day</span><select class="ad-form-input" value={form.day} onChange={e => setForm(old => ({ ...old, day: e.currentTarget.value }))}>{WEEK_DAYS.map(day => <option key={day} value={day}>{day}</option>)}</select></label>}
                {(form.type === 'DailyTrigger' || form.type === 'WeeklyTrigger') && <label class="ad-form-field"><span class="ad-form-label">Time (server local)</span><input class="ad-form-input" type="time" value={form.time} onInput={e => setForm(old => ({ ...old, time: e.currentTarget.value }))} /></label>}
                {form.type === 'IntervalTrigger' && <label class="ad-form-field"><span class="ad-form-label">Every (hours)</span><input class="ad-form-input" type="number" min="0.25" step="0.25" value={form.intervalHours} onInput={e => setForm(old => ({ ...old, intervalHours: e.currentTarget.value }))} /></label>}
                <label class="ad-form-field"><span class="ad-form-label">Time limit (hours, optional)</span><input class="ad-form-input" type="number" min="0" step="0.5" value={form.maxRuntimeHours} onInput={e => setForm(old => ({ ...old, maxRuntimeHours: e.currentTarget.value }))} /></label>
            </div>
            <ConfirmButton label="Add trigger" onConfirm={async () => {
                const trigger = buildTrigger(form);
                if ('error' in trigger) throw new Error(trigger.error);
                await save([ ...(task.Triggers || []), trigger ], 'Trigger added.');
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
        }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Device options could not be loaded.'); });
        return () => { active = false; };
    }, [api, device.Id]);
    return <Card title={`Device · ${device.CustomName || device.Name || 'Unknown'}`} actions={<button class="ad-btn" onClick={onClose}>Close</button>}>
        {error && <p role="alert" class="ad-error">{error}</p>}
        {!draft && !error && <p role="status" class="ad-note">Loading device options…</p>}
        {draft && <>
            <label class="ad-form-field"><span class="ad-form-label">Custom name</span><input class="ad-form-input" value={name} maxLength={100} placeholder={device.Name} onInput={e => setName(e.currentTarget.value)} /></label>
            <h4>Playback overrides</h4>
            <p class="ad-note">Inherit uses the user and server settings. Overrides apply to new playback on this device only.</p>
            <SettingsFields fields={DEVICE_PLAYBACK_FIELDS} draft={draft as Record<string, any>} onChange={setDraft} />
            <div class="ad-flex">
                <ConfirmButton label="Save device" onConfirm={async () => {
                    if (name.trim() !== (device.CustomName || '')) await api.saveDeviceName(device.Id!, name.trim());
                    await api.saveDevicePlaybackOptions(device.Id!, devicePlaybackPayload(draft));
                    setMessage('Device saved.');
                    await onSaved();
                }} />
                <ConfirmButton label="Clear overrides" tone="danger" onConfirm={async () => { await api.saveDevicePlaybackOptions(device.Id!, {}); setDraft({}); setMessage('Overrides cleared.'); }} />
            </div>
            {message && <p role="status" class="ad-note">{message}</p>}
        </>}
    </Card>;
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
