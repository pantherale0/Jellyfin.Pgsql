import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { isMergePreviewCurrent, type MergePreviewIdentity } from '../merge-preview';
import { canDeleteAdminUser, embyImportMapping, userChangeError, sameEmbyImportMapping, validateNewPassword, type EmbyImportMapping } from '../admin-state';
import type { AdminApi, UserAdminTransferResponse } from '../admin-api';
import type { JellyfinUserInfo } from '../types';
import type { DeviceInfo } from '../types';
import type { TasteProfile } from '../../types';
import { PageShell, Card, StatusChip, SearchInput, FilterPills, Empty, Tabs, timeAgo, InfoRow, ConfirmButton, DataTable, SettingsFields } from '../ui';
import { POLICY_FIELDS, RBAC_PERMISSIONS, SCHEDULE_DAYS, UNRATED_ITEM_KINDS, validateSchedule, type AccessSchedule } from '../server-settings';
import { t } from '../../i18n';

export function AdminUsers({ adminApi: api, session }: { adminApi: AdminApi; session: { user: { Id: string } } }) {
    const [tab, setTab] = useState('Users');
    const [users, setUsers] = useState<JellyfinUserInfo[]>([]);
    const [search, setSearch] = useState('');
    const [role, setRole] = useState('All');
    const [status, setStatus] = useState('All');
    const [selected, setSelected] = useState<JellyfinUserInfo | null>(null);
    const [selectedPolicy, setSelectedPolicy] = useState<Record<string, any>>({});
    const drawerRef = useRef<HTMLElement>(null);
    const [userBusy, setUserBusy] = useState(false);
    const [userError, setUserError] = useState('');
    const [userMessage, setUserMessage] = useState('');
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [mergeTarget, setMergeTarget] = useState('');
    const [mergeMode, setMergeMode] = useState<'merge' | 'move'>('merge');
    const [mergePreview, setMergePreview] = useState<UserAdminTransferResponse | null>(null);
    const [mergePreviewIdentity, setMergePreviewIdentity] = useState<MergePreviewIdentity | null>(null);
    const mergeRequest = useRef(0);
    const [allLibraries, setAllLibraries] = useState<Array<{ ItemId?: string; Name?: string }>>([]);
    const [userDevices, setUserDevices] = useState<DeviceInfo[]>([]);
    const [allDevices, setAllDevices] = useState<DeviceInfo[]>([]);
    const [contentChannels, setContentChannels] = useState<Array<{ Id: string; Name?: string }>>([]);
    const [providers, setProviders] = useState<{ auth: Array<[string, string]>; reset: Array<[string, string]> }>({ auth: [], reset: [] });
    const [renameDraft, setRenameDraft] = useState('');
    const [schedule, setSchedule] = useState<AccessSchedule>({ DayOfWeek: 'Everyday', StartHour: 0, EndHour: 24 });
    const [taste, setTaste] = useState<TasteProfile | null>(null);
    const [history, setHistory] = useState<Array<{ MediaType: string; TotalTicks: number; PlayCount: number }> | null>(null);
    const [checkedUsers, setCheckedUsers] = useState<string[]>([]);
    const [importStep, setImportStep] = useState<'upload' | 'select' | 'preview' | 'done'>('upload');
    const [libraryFile, setLibraryFile] = useState<File | null>(null);
    const [usersFile, setUsersFile] = useState<File | null>(null);
    const [importSession, setImportSession] = useState('');
    const uploadAbort = useRef<AbortController | null>(null);
    const uploadSession = useRef('');
    const [embyUsers, setEmbyUsers] = useState<Array<{ id: number; name: string; userDataCount: number }>>([]);
    const [selectedEmbyUsers, setSelectedEmbyUsers] = useState<number[]>([]);
    const [targetUserId, setTargetUserId] = useState('');
    const [importProgress, setImportProgress] = useState(0);
    const [importBusy, setImportBusy] = useState(false);
    const [importError, setImportError] = useState('');
    const [importPreview, setImportPreview] = useState<any>(null);
    const [importResult, setImportResult] = useState<any>(null);
    const [importMapping, setImportMapping] = useState<EmbyImportMapping | null>(null);
    const [newUserPassword, setNewUserPassword] = useState('');
    const [confirmUserPassword, setConfirmUserPassword] = useState('');

    const resetImportMapping = () => {
        setEmbyUsers([]);
        setSelectedEmbyUsers([]);
        setTargetUserId('');
        setImportPreview(null);
        setImportResult(null);
        setImportMapping(null);
    };

    const load = useCallback(async () => { try { setUsers(await api.getUsers()); } catch (e) { setUserError(e instanceof Error ? e.message : t('Could not load users.')); } }, [api]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (selected) return;
        mergeRequest.current += 1;
        setMergePreview(null); setMergePreviewIdentity(null);
    }, [selected === null]);
    useEffect(() => { api.getLibraries().then(setAllLibraries).catch(() => undefined); api.getContentChannels().then(setContentChannels).catch(() => undefined); api.getAuthProviders().then(setProviders).catch(() => undefined); }, [api]);
    useEffect(() => {
        setUserDevices([]); setTaste(null); setHistory(null);
        if (!selected) return;
        let active = true;
        const id = encodeURIComponent(selected.Id);
        void Promise.all([
            api.getDevices().then(r => { if (active) setAllDevices(r.Items || []); return (r.Items || []).filter(d => d.LastUserId?.replace(/-/g, '') === selected.Id.replace(/-/g, '')); }).catch(() => []),
            api.raw<TasteProfile>(`/Pgsql/Taste/Users/${id}`).catch(() => null),
            api.raw<Array<{ MediaType: string; TotalTicks: number; PlayCount: number }>>(`/Users/${id}/PlaybackStats?startDate=${new Date(Date.now() - 28 * 86400000).toISOString().slice(0,10)}`).catch(() => null),
        ]).then(([devices, t, h]) => { if (active) { setUserDevices(devices); setTaste(t); setHistory(h); } });
        return () => { active = false; };
    }, [api, selected?.Id]);
    useEffect(() => () => { uploadAbort.current?.abort(); if (uploadSession.current) void api.discardEmbyImport(uploadSession.current).catch(() => undefined); }, [api]);
    useEffect(() => {
        if (!selected || !drawerRef.current) return;
        const previous = document.activeElement as HTMLElement | null;
        const drawer = drawerRef.current;
        drawer.querySelector<HTMLButtonElement>('button')?.focus();
        const keyboard = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); setSelected(null); }
            if (event.key === 'Tab') {
                const controls = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')).filter(el => el.getClientRects().length);
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        };
        drawer.addEventListener('keydown', keyboard);
        return () => { drawer.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
    }, [Boolean(selected)]);
    const filtered = users.filter(u => {
        if (search && !u.Name.toLowerCase().includes(search.toLowerCase())) return false;
        if (role === 'Admin' && !u.IsAdministrator) return false;
        if (role === 'User' && u.IsAdministrator) return false;
        if (status === 'Active' && u.IsDisabled) return false;
        if (status === 'Disabled' && !u.IsDisabled) return false;
        return true;
    });

    const openUser = (u: JellyfinUserInfo) => {
        mergeRequest.current += 1;
        setSelected(u); setSelectedPolicy(u.Policy || {}); setRenameDraft(u.Name); setUserError(''); setNewUserPassword(''); setConfirmUserPassword(''); setMergeTarget(''); setMergePreview(null); setMergePreviewIdentity(null);
    };
    const userColumns = [
        { key: 'Select', label: '', value: (u: JellyfinUserInfo) => <input type="checkbox" aria-label={t('Select {0}', u.Name)} disabled={userBusy || u.Id === session.user.Id} checked={checkedUsers.includes(u.Id)} onChange={e => { const checked = e.currentTarget.checked; setCheckedUsers(old => checked ? [...old, u.Id] : old.filter(id => id !== u.Id)); }} /> },
        { key: 'Name', label: t('User'), value: (u: JellyfinUserInfo) => <><span class="ad-av">{u.Name[0]}</span><button class="ad-text-link" onClick={() => openUser(u)}>{u.DisplayName || u.Name}</button>{u.Id === session.user.Id && <StatusChip tone="blue">{t('You')}</StatusChip>}</>, searchValue: (u: JellyfinUserInfo) => u.Name },
        { key: 'Role', label: t('Role'), value: (u: JellyfinUserInfo) => <StatusChip tone={u.IsAdministrator ? 'blue' : 'muted'}>{u.IsAdministrator ? t('Admin') : t('User')}</StatusChip> },
        { key: 'LastSeen', label: t('Last seen'), value: (u: JellyfinUserInfo) => timeAgo(u.LastActivityDate || u.LastLoginDate), searchValue: (u: JellyfinUserInfo) => u.LastActivityDate || u.LastLoginDate || '' },
        { key: 'Status', label: t('Status'), value: (u: JellyfinUserInfo) => <StatusChip tone={u.IsDisabled ? 'red' : 'green'}>{u.IsDisabled ? t('Disabled') : t('Active')}</StatusChip> },
        { key: 'Libraries', label: t('Libraries'), value: (u: JellyfinUserInfo) => u.Policy?.EnableAllFolders ? 'All libraries' : Array.isArray(u.Policy?.EnabledFolders) ? u.Policy!.EnabledFolders.length : 'Not reported' },
        { key: 'Action', label: '', value: (u: JellyfinUserInfo) => <button class="ad-btn" onClick={() => openUser(u)}>{t('Details')}</button> },
    ];
    const bulk = async (action: 'enable' | 'disable' | 'delete') => {
        setUserBusy(true);
        const failed: string[] = []; let completed = 0;
        for (const id of checkedUsers) {
            try {
                if (action === 'delete') await api.deleteUser(id);
                else { const user = await api.getUser(id); if (!user.Policy) throw new Error(t('Policy not reported')); await api.updateUserPolicy(id, { ...user.Policy, IsDisabled: action === 'disable' }); }
                completed += 1;
            } catch (e) { failed.push(`${users.find(u => u.Id === id)?.Name || id}: ${userChangeError(e, action === 'delete' ? 'delete' : 'policy', 'Failed')}`); }
        }
        setUserBusy(false); setCheckedUsers([]); await load();
        setUserMessage(t('{0} users updated.{1}', completed, failed.length ? ` Failures: ${failed.join('; ')}` : ''));
    };

    return <PageShell title={t('Users & access')} subtitle={t('Lifecycle, permissions and SSO/RBAC')}
        actions={<><button class="ad-btn" onClick={() => setCreating(v => !v)}>{t('Add user')}</button><button class="ad-btn" onClick={load}>{t('Refresh')}</button></>}>
        <Tabs tabs={['Users', 'SSO / OIDC', 'Emby import']} value={tab} onPick={setTab} />
        {userError && !selected && <p role="alert" class="ad-error">{userError}</p>}
        {userMessage && <p role="status" class="ad-note">{userMessage}</p>}
        {creating && <Card title={t('Add local user')}><form onSubmit={async e => {
            e.preventDefault(); if (userBusy || !newName.trim() || !newPassword) return;
            setUserBusy(true); setUserError('');
            try { await api.createUser(newName.trim(), newPassword); setCreating(false); setNewName(''); setNewPassword(''); await load(); setUserMessage(t('User created.')); }
            catch (err) { setUserError(err instanceof Error ? err.message : t('User creation failed.')); }
            finally { setUserBusy(false); }
        }}><div class="ad-grid2"><label class="ad-field">{t('Username')}<input required value={newName} onInput={e => setNewName(e.currentTarget.value)} autoComplete="off" /></label><label class="ad-field">{t('Initial password')}<input required type="password" value={newPassword} onInput={e => setNewPassword(e.currentTarget.value)} autoComplete="new-password" /></label></div><button class="ad-btn" type="submit" disabled={userBusy}>{t('Create user')}</button></form></Card>}

        {tab === 'Users' && <Card title={t('Users')}>
            <div class="ad-toolbar">
                <SearchInput value={search} onInput={setSearch} placeholder={t('Search users…')} />
                <FilterPills options={['All', 'Admin', 'User']} value={role} onPick={setRole} />
                <FilterPills options={['All', 'Active', 'Disabled']} value={status} onPick={setStatus} />
            </div>
            {checkedUsers.length > 0 && <div class="ad-toolbar"><span class="ad-note">{t('{0} selected', checkedUsers.length)}</span><ConfirmButton label={t('Enable selected')} onConfirm={() => bulk('enable')} busy={userBusy} /><ConfirmButton label={t('Disable selected')} tone="danger" onConfirm={() => bulk('disable')} busy={userBusy} /><ConfirmButton label={t('Delete selected')} tone="danger" onConfirm={() => bulk('delete')} busy={userBusy} /><button class="ad-btn" disabled={userBusy} onClick={() => setCheckedUsers([])}>{t('Clear selection')}</button></div>}
            <DataTable rows={filtered} columns={userColumns} query={search} getKey={u => u.Id} empty={t('No users match')} />
        </Card>}

        {tab === 'SSO / OIDC' && <SsoPanel api={api} />}

        {tab === 'Emby import' && <Card title={t('Emby userdata import')}>
            {importError && <p class="ad-import-error" role="alert">{importError}</p>}
            {importStep === 'upload' && <div class="ad-import-step">
                <p class="ad-note">{t('Select the Emby')}{' '}<code>library.db</code>{' '}{t('and')}{' '}<code>users.db</code>{' '}{t('files. Upload is chunked and held in a short-lived, admin-owned import session.')}</p>
                <label class="ad-file-field">{t('library.db')}<input type="file" accept=".db,.sqlite,.sqlite3" onChange={e => setLibraryFile((e.currentTarget as HTMLInputElement).files?.[0] || null)} /></label>
                <label class="ad-file-field">{t('users.db')}<input type="file" accept=".db,.sqlite,.sqlite3" onChange={e => setUsersFile((e.currentTarget as HTMLInputElement).files?.[0] || null)} /></label>
                {importBusy && <div class="ad-progress"><i style={{ width: `${importProgress}%` }} /></div>}
                <button class="ad-btn" disabled={!libraryFile || !usersFile || importBusy} onClick={async () => {
                    if (!libraryFile || !usersFile) return;
                    setImportBusy(true); setImportError('');
                    resetImportMapping();
                    const abort = new AbortController(); uploadAbort.current = abort;
                    try {
                        if (uploadSession.current) await api.discardEmbyImport(uploadSession.current);
                        const init = await api.initEmbyUpload(libraryFile.size, usersFile.size);
                        uploadSession.current = init.sessionId;
                        setImportSession(init.sessionId);
                        await api.uploadEmbyChunks(init.sessionId, 'libraryDb', libraryFile, init.chunkSizeBytes, p => setImportProgress(Math.round(p * .5)), abort.signal);
                        await api.uploadEmbyChunks(init.sessionId, 'usersDb', usersFile, init.chunkSizeBytes, p => setImportProgress(50 + Math.round(p * .5)), abort.signal);
                        const complete = await api.completeEmbyUpload(init.sessionId);
                        setEmbyUsers(complete.users); setImportStep('select');
                    } catch (e) { setImportError(e instanceof Error ? e.message : t('Upload failed.')); resetImportMapping(); if (uploadSession.current) { await api.discardEmbyImport(uploadSession.current).catch(() => undefined); uploadSession.current = ''; } }
                    finally { setImportBusy(false); }
                }}>{importBusy ? t('Uploading {0}%', importProgress) : t('Upload databases')}</button>
                {importBusy && <button class="ad-btn" onClick={() => uploadAbort.current?.abort()}>{t('Cancel upload')}</button>}
            </div>}
            {importStep === 'select' && <div class="ad-import-step">
                <div class="ad-grid2"><label class="ad-field">{t('Target Jellyfin user')}<select value={targetUserId} onChange={e => setTargetUserId((e.currentTarget as HTMLSelectElement).value)}><option value="">{t('Choose a user')}</option>{users.map(u => <option value={u.Id}>{u.Name}</option>)}</select></label>
                    <div class="ad-user-options">{embyUsers.map(u => <label key={u.id}><input type="checkbox" checked={selectedEmbyUsers.includes(u.id)} onChange={e => setSelectedEmbyUsers(old => (e.currentTarget as HTMLInputElement).checked ? [...old, u.id] : old.filter(x => x !== u.id))} /> {t('{0} · {1} entries', u.name, u.userDataCount)}</label>)}</div></div>
                <div class="ad-flex"><button class="ad-btn" disabled={!targetUserId || selectedEmbyUsers.length === 0 || importBusy} onClick={async () => {
                    const mapping = embyImportMapping(importSession, selectedEmbyUsers, embyUsers, targetUserId);
                    if (!mapping) { setImportError(t('Select at least one user from the current upload.')); return; }
                    setImportBusy(true); try { const p = await api.previewEmbyImport(mapping.sessionId, mapping.sourceUserIds, mapping.targetUserId); setSelectedEmbyUsers(mapping.sourceUserIds); setImportMapping(mapping); setImportPreview(p); setImportStep('preview'); } catch (e) { setImportError(e instanceof Error ? e.message : t('Preview failed.')); } finally { setImportBusy(false); }
                }}>{t('Preview import')}</button><button class="ad-btn" disabled={importBusy} onClick={async () => { await api.discardEmbyImport(importSession).catch(() => undefined); uploadSession.current = ''; resetImportMapping(); setImportStep('upload'); }}>{t('Discard')}</button></div>
            </div>}
            {importStep === 'preview' && <div class="ad-import-step"><p class="ad-note">{t('Review the preview counts before applying userdata.')}</p>
                {importPreview?.counts && Object.entries(importPreview.counts).map(([k, v]) => <InfoRow key={k} k={k} v={String(v)} />)}
                <div class="ad-danger"><p>{t('Import selected users into')}{' '}{users.find(u => u.Id === targetUserId)?.Name || t('target user')}?</p><ConfirmButton label={t('Import UserData')} tone="danger" onConfirm={async () => {
                    const mapping = embyImportMapping(importSession, selectedEmbyUsers, embyUsers, targetUserId);
                    if (!importMapping || !sameEmbyImportMapping(mapping, importMapping)) throw new Error(t('The mapping changed after the preview. Preview the import again.'));
                    setImportBusy(true); try { setImportResult(await api.executeEmbyImport(importMapping.sessionId, importMapping.sourceUserIds, importMapping.targetUserId)); uploadSession.current = ''; resetImportMapping(); setEmbyUsers([]); setImportStep('done'); } catch (e) { setImportError(e instanceof Error ? e.message : t('Import failed.')); } finally { setImportBusy(false); }
                }} busy={importBusy} /><button class="ad-btn" disabled={importBusy} onClick={() => { setImportPreview(null); setImportMapping(null); setImportStep('select'); }}>{t('Back to mapping')}</button></div>
            </div>}
            {importStep === 'done' && <div class="ad-import-step"><StatusChip tone="green">{t('Import complete')}</StatusChip>{importResult?.counts && Object.entries(importResult.counts).map(([k, v]) => <InfoRow key={k} k={k} v={String(v)} />)}{importResult?.warning && <p class="ad-note">{importResult.warning}</p>}<button class="ad-btn" onClick={() => { setImportStep('upload'); setImportProgress(0); setLibraryFile(null); setUsersFile(null); resetImportMapping(); }}>{t('Start another import')}</button></div>}
        </Card>}
        {selected && <div class="ad-drawer-backdrop" onClick={() => setSelected(null)}><aside ref={drawerRef} class="ad-drawer" role="dialog" aria-modal="true" aria-labelledby="admin-user-detail-title" onClick={e => e.stopPropagation()}>
            <button class="ad-drawer-close" onClick={() => setSelected(null)} aria-label={t('Close details')}>×</button>
            <h2 id="admin-user-detail-title">{selected.DisplayName || selected.Name}</h2>
            <StatusChip tone={selected.IsAdministrator ? 'blue' : 'muted'}>{selected.IsAdministrator ? t('Administrator') : t('User')}</StatusChip>
            <InfoRow k={t('Status')} v={selected.IsDisabled ? t('Disabled') : t('Active')} />
            <InfoRow k={t('Last seen')} v={timeAgo(selected.LastActivityDate || selected.LastLoginDate)} />
            {userError && <p class="ad-error" role="alert">{userError}</p>}
            <h3 class="ad-drawer-section-title">{t('Profile')}</h3>
            <div class="ad-flex"><label class="ad-field">{t('Username')}<input value={renameDraft} maxLength={100} autoComplete="off" onInput={e => setRenameDraft(e.currentTarget.value)} /></label>
                <ConfirmButton label={t('Rename')} onConfirm={async () => {
                    const name = renameDraft.trim();
                    if (!name) throw new Error(t('A username is required.'));
                    if (name === selected.Name) return;
                    if (users.some(u => u.Id !== selected.Id && u.Name.toLowerCase() === name.toLowerCase())) throw new Error(t('Another user already has that name.'));
                    await api.renameUser(selected.Id, name);
                    setSelected({ ...selected, Name: name });
                    setUserMessage(t('Renamed to {0}.', name));
                    await load();
                }} /></div>
            {selected.Policy && <><h3 class="ad-drawer-section-title">{t('Permissions & access')}</h3>
                {(['IsAdministrator', 'IsDisabled', 'EnableLiveTvAccess', 'EnableLiveTvManagement', 'EnableRemoteAccess', 'EnableMediaPlayback'] as const).map(key => <label class="ad-policy-row" key={key}><span>{policyLabel(key)}</span><input type="checkbox" checked={selectedPolicy[key] === true} disabled={userBusy || key === 'IsDisabled' && selected.IsAdministrator} onChange={e => setSelectedPolicy(old => ({ ...old, [key]: (e.currentTarget as HTMLInputElement).checked }))} /></label>)}
                {'EnableLiveTvMultiview' in selectedPolicy && <label class="ad-policy-row"><span>{t('Live TV Multiview')}</span><input type="checkbox" checked={selectedPolicy.EnableLiveTvMultiview === true} onChange={e => setSelectedPolicy(old => ({ ...old, EnableLiveTvMultiview: e.currentTarget.checked }))} /></label>}
                <h3 class="ad-drawer-section-title">{t('Library access')}</h3>
                <label class="ad-policy-row"><span>{t('All libraries')}</span><input type="checkbox" checked={selectedPolicy.EnableAllFolders === true} onChange={e => setSelectedPolicy(old => ({ ...old, EnableAllFolders: e.currentTarget.checked }))} /></label>
                {!selectedPolicy.EnableAllFolders && allLibraries.map(l => <label class="ad-policy-row" key={l.ItemId}><span>{l.Name}</span><input type="checkbox" checked={(selectedPolicy.EnabledFolders || []).includes(l.ItemId)} onChange={e => { const checked = e.currentTarget.checked; setSelectedPolicy(old => ({ ...old, EnabledFolders: checked ? [...(old.EnabledFolders || []), l.ItemId] : (old.EnabledFolders || []).filter((id: string) => id !== l.ItemId) })); }} /></label>)}
                <h3 class="ad-drawer-section-title">{t('Parental controls')}</h3>
                <label class="ad-field">{t('Maximum parental rating (empty means unrestricted)')}<input type="number" min="0" value={selectedPolicy.MaxParentalRating ?? ''} onInput={e => setSelectedPolicy(old => ({ ...old, MaxParentalRating: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) }))} /></label>
                <label class="ad-field">{t('Blocked tags (comma-separated)')}<input value={(selectedPolicy.BlockedTags || []).join(', ')} onInput={e => setSelectedPolicy(old => ({ ...old, BlockedTags: e.currentTarget.value.split(',').map(t => t.trim()).filter(Boolean) }))} /></label>
                <fieldset class="ad-fieldset"><legend>{t('Block items with no rating')}</legend>{UNRATED_ITEM_KINDS.map(([kind, label]) => <label class="ad-policy-row" key={kind}><span>{t(label)}</span><input type="checkbox" checked={(selectedPolicy.BlockUnratedItems || []).includes(kind)} onChange={e => { const checked = e.currentTarget.checked; setSelectedPolicy(old => ({ ...old, BlockUnratedItems: checked ? [ ...(old.BlockUnratedItems || []), kind ] : (old.BlockUnratedItems || []).filter((value: string) => value !== kind) })); }} /></label>)}</fieldset>
                <h3 class="ad-drawer-section-title">{t('Access schedule')}</h3>
                {(selectedPolicy.AccessSchedules || []).length === 0 ? <p class="ad-note">{t('No schedule: access is allowed at any time.')}</p> : (selectedPolicy.AccessSchedules as AccessSchedule[]).map((entry, index) => <div class="ad-info" key={index}><span class="ad-info-k">{entry.DayOfWeek} · {entry.StartHour}:00–{entry.EndHour}:00</span><button class="ad-btn" onClick={() => setSelectedPolicy(old => ({ ...old, AccessSchedules: (old.AccessSchedules || []).filter((_: AccessSchedule, i: number) => i !== index) }))}>{t('Remove')}</button></div>)}
                <div class="ad-flex"><label class="ad-field">{t('Day')}<select value={schedule.DayOfWeek} onChange={e => setSchedule(old => ({ ...old, DayOfWeek: e.currentTarget.value }))}>{SCHEDULE_DAYS.map(day => <option key={day} value={day}>{t(day)}</option>)}</select></label>
                    <label class="ad-field">{t('From hour')}<input type="number" min="0" max="23" value={schedule.StartHour} onInput={e => setSchedule(old => ({ ...old, StartHour: Number(e.currentTarget.value) }))} /></label>
                    <label class="ad-field">{t('To hour')}<input type="number" min="1" max="24" value={schedule.EndHour} onInput={e => setSchedule(old => ({ ...old, EndHour: Number(e.currentTarget.value) }))} /></label>
                    <button class="ad-btn" onClick={() => { const problem = validateSchedule(schedule); if (problem) { setUserError(problem); return; } setUserError(''); setSelectedPolicy(old => ({ ...old, AccessSchedules: [ ...(old.AccessSchedules || []), schedule ] })); }}>{t('Add window')}</button></div>
                <h3 class="ad-drawer-section-title">{t('Channel access')}</h3>
                <label class="ad-policy-row"><span>{t('All channels')}</span><input type="checkbox" checked={selectedPolicy.EnableAllChannels !== false} onChange={e => setSelectedPolicy(old => ({ ...old, EnableAllChannels: e.currentTarget.checked }))} /></label>
                {selectedPolicy.EnableAllChannels === false && (contentChannels.length ? contentChannels.map(c => <label class="ad-policy-row" key={c.Id}><span>{c.Name || c.Id}</span><input type="checkbox" checked={(selectedPolicy.EnabledChannels || []).includes(c.Id)} onChange={e => { const checked = e.currentTarget.checked; setSelectedPolicy(old => ({ ...old, EnabledChannels: checked ? [ ...(old.EnabledChannels || []), c.Id ] : (old.EnabledChannels || []).filter((id: string) => id !== c.Id) })); }} /></label>) : <p class="ad-note">{t('No content channels are installed.')}</p>)}
                <h3 class="ad-drawer-section-title">{t('Device access')}</h3>
                <label class="ad-policy-row"><span>{t('All devices')}</span><input type="checkbox" checked={selectedPolicy.EnableAllDevices !== false} onChange={e => setSelectedPolicy(old => ({ ...old, EnableAllDevices: e.currentTarget.checked }))} /></label>
                {selectedPolicy.EnableAllDevices === false && (allDevices.length ? allDevices.filter(d => d.Id).map(d => <label class="ad-policy-row" key={d.Id}><span>{d.CustomName || d.Name} · {d.AppName}</span><input type="checkbox" checked={(selectedPolicy.EnabledDevices || []).includes(d.Id)} onChange={e => { const checked = e.currentTarget.checked; setSelectedPolicy(old => ({ ...old, EnabledDevices: checked ? [ ...(old.EnabledDevices || []), d.Id ] : (old.EnabledDevices || []).filter((id: string) => id !== d.Id) })); }} /></label>) : <p class="ad-note">{t('No devices are registered.')}</p>)}
                <h3 class="ad-drawer-section-title">{t('Playback and features')}</h3>
                <SettingsFields key={selected.Id} fields={POLICY_FIELDS} draft={selectedPolicy} onChange={setSelectedPolicy} options={{ AuthenticationProviderId: providers.auth, PasswordResetProviderId: providers.reset }} />
                <div class="ad-drawer-actions"><ConfirmButton label={t('Save policy')} busy={userBusy} onConfirm={async () => { setUserBusy(true); setUserError(''); try { await api.updateUserPolicy(selected.Id, selectedPolicy); setSelected({ ...selected, Policy: selectedPolicy, IsAdministrator: selectedPolicy.IsAdministrator, IsDisabled: selectedPolicy.IsDisabled }); await load(); } catch (e) { setUserError(userChangeError(e, 'policy', t('Policy update failed.'))); } finally { setUserBusy(false); } }} />
                    {canDeleteAdminUser(selected, session.user.Id, users)
                        ? <ConfirmButton label={t('Delete user')} tone="danger" onConfirm={async () => {
                            setUserBusy(true);
                            try {
                                const currentUsers = await api.getUsers();
                                const currentTarget = currentUsers.find(user => user.Id === selected.Id);
                                if (!currentTarget) throw new Error(t('This user no longer exists. Refresh the user list and try again.'));
                                if (!canDeleteAdminUser(currentTarget, session.user.Id, currentUsers)) throw new Error(t('You cannot delete your own account or the last enabled administrator.'));
                                await api.deleteUser(currentTarget.Id);
                                setSelected(null);
                                await load();
                            } catch (e) { setUserError(userChangeError(e, 'delete', t('Delete failed.'))); }
                            finally { setUserBusy(false); }
                        }} busy={userBusy} />
                        : <p class="ad-note">{selected.Id === session.user.Id ? t('You cannot delete your own account here.') : t('The last enabled administrator cannot be deleted.')}</p>}
                </div>
                {selected.Id !== session.user.Id && <form class="ad-password-form" onSubmit={e => e.preventDefault()}>
                    <h3 class="ad-drawer-section-title">{t('Set password')}</h3>
                    <div class="ad-grid2"><label class="ad-field">{t('New password')}<input type="password" autoComplete="new-password" value={newUserPassword} onInput={e => setNewUserPassword(e.currentTarget.value)} /></label>
                        <label class="ad-field">{t('Confirm password')}<input type="password" autoComplete="new-password" value={confirmUserPassword} onInput={e => setConfirmUserPassword(e.currentTarget.value)} /></label></div>
                    <ConfirmButton label={t('Set password')} onConfirm={async () => {
                        const problem = validateNewPassword(newUserPassword, confirmUserPassword);
                        if (problem) throw new Error(problem);
                        await api.setUserPassword(selected.Id, newUserPassword);
                        setNewUserPassword(''); setConfirmUserPassword('');
                        setUserMessage(t('Password updated for {0}. Their other sessions were signed out.', selected.Name));
                    }} />
                </form>}
                <div class="ad-drawer-actions">{selected.IsAdministrator
                    ? <p class="ad-note">{t('Clearing the password is unavailable for administrators; set a new password instead.')}</p>
                    : <ConfirmButton label={t('Clear password')} tone="danger" onConfirm={async () => { await api.resetUserPassword(selected.Id); setUserMessage(t('Password cleared. The user can sign in without a password until one is set.')); }} />}</div>
                <h3 class="ad-drawer-section-title">{t('Merge userdata and account')}</h3>
                <label class="ad-field">{t('Merge into')}<select value={mergeTarget} onChange={e => { mergeRequest.current += 1; setMergeTarget(e.currentTarget.value); setMergePreview(null); setMergePreviewIdentity(null); }}><option value="">{t('Select target')}</option>{users.filter(u => u.Id !== selected.Id).map(u => <option value={u.Id} key={u.Id}>{u.Name}</option>)}</select></label>
                <div class="ad-flex" role="group" aria-label={t('Transfer mode')}>
                    {([['merge', 'Full merge'], ['move', 'Userdata only']] as const).map(([mode, label]) => <button key={mode} type="button" class={`ad-btn${mergeMode === mode ? ' active' : ''}`} aria-pressed={mergeMode === mode} onClick={() => { mergeRequest.current += 1; setMergeMode(mode); setMergePreview(null); setMergePreviewIdentity(null); }}>{t(label)}</button>)}
                </div>
                {mergeMode === 'move' && <p class="ad-note">{t('Moves watch history and favorites without deleting the source account.')}</p>}
                {selected.Id !== session.user.Id && <button class="ad-btn" disabled={!mergeTarget} onClick={async () => {
                    const sourceId = selected.Id, targetId = mergeTarget, mode = mergeMode;
                    const requestId = ++mergeRequest.current;
                    try {
                        const preview = mode === 'move' ? await api.moveUserData(sourceId, targetId) : await api.mergeUsers(sourceId, targetId);
                        if (mergeRequest.current !== requestId) return;
                        if (!preview.previewToken) throw new Error(t('The server did not authorize this preview. Preview again.'));
                        setMergePreview(preview);
                        setMergePreviewIdentity({ sourceId, targetId, requestId, mode });
                    } catch (e) { if (mergeRequest.current === requestId) setUserError(e instanceof Error ? e.message : t('Merge preview failed.')); }
                }}>{t('Preview merge')}</button>}
                {mergePreview && mergePreviewIdentity && isMergePreviewCurrent(mergePreviewIdentity, selected.Id, mergeTarget, mergeRequest.current, mergeMode) && <><div class="ad-note">{mergePreviewIdentity.mode === 'move' ? t('The source account is kept.') : t('The source account will be deleted after merging.')}</div>{Object.entries(mergePreview.counts).map(([k, v]) => <InfoRow key={k} k={k} v={v} />)}<ConfirmButton key={`${mergePreviewIdentity.sourceId}:${mergePreviewIdentity.targetId}:${mergePreviewIdentity.requestId}:${mergePreviewIdentity.mode}`} label={mergePreviewIdentity.mode === 'move' ? t('Move userdata') : t('Merge and delete source')} tone="danger" onConfirm={async () => {
                    if (!isMergePreviewCurrent(mergePreviewIdentity, selected.Id, mergeTarget, mergeRequest.current, mergeMode)) throw new Error(t('This preview is for a different user pair. Preview the current pair before merging.'));
                    const move = mergePreviewIdentity.mode === 'move';
                    let result: UserAdminTransferResponse;
                    try {
                        result = move
                            ? await api.moveUserData(mergePreviewIdentity.sourceId, mergePreviewIdentity.targetId, false, mergePreview.previewToken)
                            : await api.mergeUsers(mergePreviewIdentity.sourceId, mergePreviewIdentity.targetId, false, mergePreview.previewToken);
                    } catch (error) {
                        if ((error as { status?: unknown } | null)?.status === 409) {
                            mergeRequest.current += 1;
                            setMergePreview(null); setMergePreviewIdentity(null);
                            throw new Error(t('The users changed since the preview. Preview again.'));
                        }
                        throw error;
                    }
                    mergeRequest.current += 1;
                    setMergePreview(null); setMergePreviewIdentity(null);
                    setUserMessage(result.warning || (move ? t('Userdata moved.') : t('Accounts merged.')));
                    if (!move) setSelected(null);
                    await load();
                }} /></>}
            </>}
            {!selected.Policy && <p class="ad-note">{t('User policy is not available from the response.')}</p>}
            <h3 class="ad-drawer-section-title">{t('Devices last used by this user')}</h3>
            {userDevices.length ? userDevices.map(d => <div class="ad-info" key={d.Id}><span class="ad-info-k">{d.Name} · {d.AppName}</span>{d.Id && <ConfirmButton label={t('Revoke device')} tone="danger" onConfirm={async () => { await api.deleteDevice(d.Id!); setUserDevices(old => old.filter(v => v.Id !== d.Id)); }} />}</div>) : <Empty muted>{t('No devices reported')}</Empty>}
            {history && <><h3 class="ad-drawer-section-title">{t('Watch history · last 28 days')}</h3>{history.length ? history.map(h => <InfoRow key={h.MediaType} k={h.MediaType} v={t('{0} plays · {1} hours', h.PlayCount, (h.TotalTicks / 36_000_000_000).toFixed(1))} />) : <Empty muted>{t('No recorded playback')}</Empty>}</>}
            {taste?.HasProfile && <><h3 class="ad-drawer-section-title">{t('Taste profile')}</h3>{taste.Persona?.Title && <InfoRow k={t('Identity')} v={taste.Persona.Title} />}<InfoRow k={t('Samples')} v={taste.SampleCount} /><InfoRow k={t('Top genres')} v={(taste.Genres || []).slice(0,5).map(g => g.Label).filter(Boolean).join(', ')} />{taste.UpdatedAt && <InfoRow k={t('Refreshed')} v={timeAgo(taste.UpdatedAt)} />}</>}
        </aside></div>}
    </PageShell>;
}

function SsoPanel({ api }: { api: AdminApi }) {
    const [mappings, setMappings] = useState<any[] | null>(null);
    const [libraries, setLibraries] = useState<Array<{ name?: string; id?: string }>>([]);
    const [channels, setChannels] = useState<Array<{ id: string; name: string; number?: string }>>([]);
    const [categories, setCategories] = useState<string[]>([]);
    const [oidcEnabled, setOidcEnabled] = useState<boolean | null>(null);
    const [editingRbac, setEditingRbac] = useState(false);
    const [rbacText, setRbacText] = useState('[]');
    const [rbacSaved, setRbacSaved] = useState('');
    useEffect(() => {
        Promise.all([api.raw<any>('/SSO/rbac/config').catch(() => null), api.raw<Array<{ name?: string; id?: string }>>('/SSO/rbac/libraries').catch(() => []), api.raw<{ channels: Array<{ id: string; name: string; number?: string }>; categories: string[] }>('/SSO/rbac/livetv').catch(() => null), api.getSsoStatus()])
            .then(([m, l, c, status]) => { setMappings(Array.isArray(m) ? m : null); setRbacText(JSON.stringify(Array.isArray(m) ? m : [], null, 2)); setLibraries(l || []); setChannels(c?.channels || []); setCategories(c?.categories || []); setOidcEnabled(status?.enabled ?? null); });
    }, [api]);
    let draft: any[] = [];
    try { const value = JSON.parse(rbacText); if (Array.isArray(value)) draft = value; } catch { /* advanced JSON editor reports validation on save */ }
    const updateMapping = (index: number, patch: Record<string, unknown>) => setRbacText(JSON.stringify(draft.map((m, i) => i === index ? { ...m, ...patch } : m), null, 2));
    return <Card title={t('SSO / OIDC')}>
        <div class="ad-grid2">
            <InfoRow k={t('OIDC configuration')} v={<StatusChip tone={oidcEnabled ? 'green' : 'muted'}>{oidcEnabled === null ? t('Unavailable') : oidcEnabled ? t('Configured') : t('Not configured')}</StatusChip>} />
            <InfoRow k={t('RBAC mappings')} v={mappings ? <StatusChip tone={mappings.length ? 'green' : 'muted'}>{mappings.length ? t('Configured') : t('No mappings')}</StatusChip> : <StatusChip tone="muted">{t('Endpoint unavailable')}</StatusChip>} />
            {mappings && <InfoRow k={t('Mappings')} v={t('{0} group mappings', mappings.length)} />}
        </div>
        {mappings && !editingRbac && <div class="ad-rbac-list">{mappings.map((m, i) => <details class="ad-rbac-row" key={i}><summary>{m.oidcGroup || t('Mapping {0}', i + 1)}</summary><InfoRow k={t('Administrator')} v={m.permissions?.IsAdministrator ? t('Yes') : t('No')} /><InfoRow k={t('Libraries')} v={m.enableAllFolders ? t('All libraries') : (m.enabledFolders || []).map((id: string) => libraries.find(l => l.id === id)?.name || id).join(', ') || t('None')} /><pre class="ad-json">{JSON.stringify(m, null, 2)}</pre></details>)}</div>}
        {mappings && <div class="ad-rbac-editor">
            {editingRbac && <>
                <div class="ad-rbac-list">{draft.map((m, index) => <fieldset class="ad-mapping-form" key={index}><legend>{t('Group {0}', index + 1)}</legend>
                    <label class="ad-field">{t('IdP group')}<input value={m.oidcGroup || ''} onInput={e => updateMapping(index, { oidcGroup: e.currentTarget.value })} /></label>
                    <div class="ad-grid2">{RBAC_PERMISSIONS.map(([key, label]) => <label key={key} class="ad-policy-row"><span>{t(label)}</span><input type="checkbox" checked={m.permissions?.[key] === true} onChange={e => updateMapping(index, { permissions: { ...m.permissions, [key]: e.currentTarget.checked } })} /></label>)}</div>
                    <label class="ad-policy-row"><span>{t('All libraries')}</span><input type="checkbox" checked={m.enableAllFolders === true} onChange={e => updateMapping(index, { enableAllFolders: e.currentTarget.checked })} /></label>
                    {!m.enableAllFolders && <label class="ad-field">{t('Allowed libraries')}<select multiple size={Math.min(5, libraries.length || 1)} value={m.enabledFolders || []} onChange={e => updateMapping(index, { enabledFolders: Array.from(e.currentTarget.selectedOptions).map(o => o.value) })}>{libraries.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
                    <div class="ad-grid2"><label class="ad-field">{t('Blocked tags (comma-separated)')}<input value={(m.blockedTags || []).join(', ')} onInput={e => updateMapping(index, { blockedTags: e.currentTarget.value.split(',').map(t => t.trim()).filter(Boolean) })} /></label><label class="ad-field">{t('Allowed tags (comma-separated)')}<input value={(m.allowedTags || []).join(', ')} onInput={e => updateMapping(index, { allowedTags: e.currentTarget.value.split(',').map(t => t.trim()).filter(Boolean) })} /></label></div>
                    <div class="ad-grid2">{UNRATED_ITEM_KINDS.map(([kind, label]) => <label key={kind} class="ad-policy-row"><span>{t('Block unrated {0}', label)}</span><input type="checkbox" checked={(m.blockUnratedItems || []).includes(kind)} onChange={e => updateMapping(index, { blockUnratedItems: e.currentTarget.checked ? [...(m.blockUnratedItems || []), kind] : (m.blockUnratedItems || []).filter((value: string) => value !== kind) })} /></label>)}</div>
                    <div class="ad-grid2"><label class="ad-field">{t('Live TV allowlisted categories')}<select multiple size={4} value={m.allowedLiveTvCategories || []} onChange={e => updateMapping(index, { allowedLiveTvCategories: Array.from(e.currentTarget.selectedOptions).map(o => o.value) })}>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></label><label class="ad-field">{t('Live TV allowlisted channels')}<select multiple size={4} value={m.allowedLiveTvChannels || []} onChange={e => updateMapping(index, { allowedLiveTvChannels: Array.from(e.currentTarget.selectedOptions).map(o => o.value) })}>{channels.map(c => <option key={c.id} value={c.id}>{c.number ? `${c.number} · ` : ''}{c.name}</option>)}</select></label></div>
                    <ConfirmButton label={t('Remove draft group')} tone="danger" onConfirm={() => setRbacText(JSON.stringify(draft.filter((_, i) => i !== index), null, 2))} />
                </fieldset>)}</div>
                <button class="ad-btn" onClick={() => setRbacText(JSON.stringify([...draft, { oidcGroup: '', enableAllFolders: false, enabledFolders: [], permissions: {}, blockedTags: [], allowedTags: [], allowedLiveTvChannels: [], allowedLiveTvCategories: [] }], null, 2))}>{t('Add group mapping')}</button>
                <details class="ad-rbac-row"><summary>{t('Advanced JSON')}</summary><label class="ad-field">{t('Group mapping JSON')}<textarea value={rbacText} rows={12} onInput={e => setRbacText(e.currentTarget.value)} /></label></details>
            </>}
            {rbacSaved && <p class="ad-note" role="status">{rbacSaved}</p>}
            {!editingRbac
                ? <button class="ad-btn" onClick={() => setEditingRbac(true)}>{t('Edit mappings')}</button>
                : <span class="ad-flex"><ConfirmButton label={t('Save mappings')} onConfirm={async () => { const value = JSON.parse(rbacText); if (!Array.isArray(value) || value.some(m => typeof m.oidcGroup !== 'string' || !m.oidcGroup.trim())) throw new Error(t('Each group mapping must have an IdP group name.')); await api.saveSsoConfig(value); setMappings(value); setEditingRbac(false); setRbacSaved(t('Mappings saved.')); }} /><button class="ad-btn" onClick={() => { setRbacText(JSON.stringify(mappings, null, 2)); setEditingRbac(false); }}>{t('Cancel')}</button></span>}
        </div>}
        {libraries.length > 0 && <InfoRow k={t('Available libraries')} v={libraries.map(l => l.name).filter(Boolean).join(', ')} />}
        {channels.length > 0 && <InfoRow k={t('Live TV allowlist candidates')} v={t('{0} channels / categories available', channels.length)} />}
        <div class="ad-note">{t('Mappings apply at the next OIDC sign-in. Emergency local login:')}{' '}<code>?local=true</code>.</div>
    </Card>;
}

function policyLabel(key: string): string { return ({ IsAdministrator: 'Administrator', IsDisabled: 'Disabled', EnableLiveTvAccess: t('Live TV access'), EnableLiveTvManagement: t('Live TV management'), EnableRemoteAccess: t('Remote access'), EnableMediaPlayback: t('Media playback') } as Record<string, string>)[key] || key; }
