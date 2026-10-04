import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { JellyfinUserInfo } from '../types';
import type { DeviceInfo } from '../types';
import type { TasteProfile } from '../../types';
import { PageShell, Card, StatusChip, SearchInput, FilterPills, Empty, Tabs, timeAgo, InfoRow, ConfirmButton, DataTable } from '../ui';

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
    const [mergePreview, setMergePreview] = useState<{ counts: Record<string, number>; warning?: string } | null>(null);
    const [allLibraries, setAllLibraries] = useState<Array<{ ItemId?: string; Name?: string }>>([]);
    const [userDevices, setUserDevices] = useState<DeviceInfo[]>([]);
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

    const load = useCallback(async () => { try { setUsers(await api.getUsers()); } catch (e) { setUserError(e instanceof Error ? e.message : 'Could not load users.'); } }, [api]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => { api.getLibraries().then(setAllLibraries).catch(() => undefined); }, [api]);
    useEffect(() => {
        setUserDevices([]); setTaste(null); setHistory(null);
        if (!selected) return;
        let active = true;
        const id = encodeURIComponent(selected.Id);
        void Promise.all([
            api.getDevices().then(r => (r.Items || []).filter(d => d.LastUserId?.replace(/-/g, '') === selected.Id.replace(/-/g, ''))).catch(() => []),
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
        setSelected(u); setSelectedPolicy(u.Policy || {}); setUserError(''); setMergeTarget(''); setMergePreview(null);
    };
    const userColumns = [
        { key: 'Select', label: '', value: (u: JellyfinUserInfo) => <input type="checkbox" aria-label={`Select ${u.Name}`} disabled={userBusy || u.Id === session.user.Id} checked={checkedUsers.includes(u.Id)} onChange={e => { const checked = e.currentTarget.checked; setCheckedUsers(old => checked ? [...old, u.Id] : old.filter(id => id !== u.Id)); }} /> },
        { key: 'Name', label: 'User', value: (u: JellyfinUserInfo) => <><span class="ad-av">{u.Name[0]}</span><button class="ad-text-link" onClick={() => openUser(u)}>{u.DisplayName || u.Name}</button>{u.Id === session.user.Id && <StatusChip tone="blue">You</StatusChip>}</>, searchValue: (u: JellyfinUserInfo) => u.Name },
        { key: 'Role', label: 'Role', value: (u: JellyfinUserInfo) => <StatusChip tone={u.IsAdministrator ? 'blue' : 'muted'}>{u.IsAdministrator ? 'Admin' : 'User'}</StatusChip> },
        { key: 'LastSeen', label: 'Last seen', value: (u: JellyfinUserInfo) => timeAgo(u.LastActivityDate || u.LastLoginDate), searchValue: (u: JellyfinUserInfo) => u.LastActivityDate || u.LastLoginDate || '' },
        { key: 'Status', label: 'Status', value: (u: JellyfinUserInfo) => <StatusChip tone={u.IsDisabled ? 'red' : 'green'}>{u.IsDisabled ? 'Disabled' : 'Active'}</StatusChip> },
        { key: 'Libraries', label: 'Libraries', value: (u: JellyfinUserInfo) => u.Policy?.EnableAllFolders ? 'All libraries' : Array.isArray(u.Policy?.EnabledFolders) ? u.Policy!.EnabledFolders.length : 'Not reported' },
        { key: 'Action', label: '', value: (u: JellyfinUserInfo) => <button class="ad-btn" onClick={() => openUser(u)}>Details</button> },
    ];
    const bulk = async (action: 'enable' | 'disable' | 'delete') => {
        setUserBusy(true);
        const failed: string[] = []; let completed = 0;
        for (const id of checkedUsers) {
            try {
                if (action === 'delete') await api.deleteUser(id);
                else { const user = await api.getUser(id); if (!user.Policy) throw new Error('Policy not reported'); await api.updateUserPolicy(id, { ...user.Policy, IsDisabled: action === 'disable' }); }
                completed += 1;
            } catch (e) { failed.push(`${users.find(u => u.Id === id)?.Name || id}: ${e instanceof Error ? e.message : 'Failed'}`); }
        }
        setUserBusy(false); setCheckedUsers([]); await load();
        setUserMessage(`${completed} users updated.${failed.length ? ` Failures: ${failed.join('; ')}` : ''}`);
    };

    return <PageShell title="Users & access" subtitle="Lifecycle, permissions and SSO/RBAC"
        actions={<><button class="ad-btn" onClick={() => setCreating(v => !v)}>Add user</button><button class="ad-btn" onClick={load}>Refresh</button></>}>
        <Tabs tabs={['Users', 'SSO / OIDC', 'Emby import']} value={tab} onPick={setTab} />
        {userError && !selected && <p role="alert" class="ad-error">{userError}</p>}
        {userMessage && <p role="status" class="ad-note">{userMessage}</p>}
        {creating && <Card title="Add local user"><form onSubmit={async e => {
            e.preventDefault(); if (userBusy || !newName.trim() || !newPassword) return;
            setUserBusy(true); setUserError('');
            try { await api.createUser(newName.trim(), newPassword); setCreating(false); setNewName(''); setNewPassword(''); await load(); setUserMessage('User created.'); }
            catch (err) { setUserError(err instanceof Error ? err.message : 'User creation failed.'); }
            finally { setUserBusy(false); }
        }}><div class="ad-grid2"><label class="ad-field">Username<input required value={newName} onInput={e => setNewName(e.currentTarget.value)} autoComplete="off" /></label><label class="ad-field">Initial password<input required type="password" value={newPassword} onInput={e => setNewPassword(e.currentTarget.value)} autoComplete="new-password" /></label></div><button class="ad-btn" type="submit" disabled={userBusy}>Create user</button></form></Card>}

        {tab === 'Users' && <Card title="Users">
            <div class="ad-toolbar">
                <SearchInput value={search} onInput={setSearch} placeholder="Search users…" />
                <FilterPills options={['All', 'Admin', 'User']} value={role} onPick={setRole} />
                <FilterPills options={['All', 'Active', 'Disabled']} value={status} onPick={setStatus} />
            </div>
            {checkedUsers.length > 0 && <div class="ad-toolbar"><span class="ad-note">{checkedUsers.length} selected</span><ConfirmButton label="Enable selected" onConfirm={() => bulk('enable')} busy={userBusy} /><ConfirmButton label="Disable selected" tone="danger" onConfirm={() => bulk('disable')} busy={userBusy} /><ConfirmButton label="Delete selected" tone="danger" onConfirm={() => bulk('delete')} busy={userBusy} /><button class="ad-btn" disabled={userBusy} onClick={() => setCheckedUsers([])}>Clear selection</button></div>}
            <DataTable rows={filtered} columns={userColumns} query={search} getKey={u => u.Id} empty="No users match" />
        </Card>}

        {tab === 'SSO / OIDC' && <SsoPanel api={api} />}

        {tab === 'Emby import' && <Card title="Emby userdata import">
            {importError && <p class="ad-import-error" role="alert">{importError}</p>}
            {importStep === 'upload' && <div class="ad-import-step">
                <p class="ad-note">Select the Emby <code>library.db</code> and <code>users.db</code> files. Upload is chunked and held in a short-lived, admin-owned import session.</p>
                <label class="ad-file-field">library.db<input type="file" accept=".db,.sqlite,.sqlite3" onChange={e => setLibraryFile((e.currentTarget as HTMLInputElement).files?.[0] || null)} /></label>
                <label class="ad-file-field">users.db<input type="file" accept=".db,.sqlite,.sqlite3" onChange={e => setUsersFile((e.currentTarget as HTMLInputElement).files?.[0] || null)} /></label>
                {importBusy && <div class="ad-progress"><i style={{ width: `${importProgress}%` }} /></div>}
                <button class="ad-btn" disabled={!libraryFile || !usersFile || importBusy} onClick={async () => {
                    if (!libraryFile || !usersFile) return;
                    setImportBusy(true); setImportError('');
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
                    } catch (e) { setImportError(e instanceof Error ? e.message : 'Upload failed.'); if (uploadSession.current) { await api.discardEmbyImport(uploadSession.current).catch(() => undefined); uploadSession.current = ''; } }
                    finally { setImportBusy(false); }
                }}>{importBusy ? `Uploading ${importProgress}%` : 'Upload databases'}</button>
                {importBusy && <button class="ad-btn" onClick={() => uploadAbort.current?.abort()}>Cancel upload</button>}
            </div>}
            {importStep === 'select' && <div class="ad-import-step">
                <div class="ad-grid2"><label class="ad-field">Target Jellyfin user<select value={targetUserId} onChange={e => setTargetUserId((e.currentTarget as HTMLSelectElement).value)}><option value="">Choose a user</option>{users.map(u => <option value={u.Id}>{u.Name}</option>)}</select></label>
                    <div class="ad-user-options">{embyUsers.map(u => <label key={u.id}><input type="checkbox" checked={selectedEmbyUsers.includes(u.id)} onChange={e => setSelectedEmbyUsers(old => (e.currentTarget as HTMLInputElement).checked ? [...old, u.id] : old.filter(x => x !== u.id))} /> {u.name} · {u.userDataCount} entries</label>)}</div></div>
                <div class="ad-flex"><button class="ad-btn" disabled={!targetUserId || selectedEmbyUsers.length === 0 || importBusy} onClick={async () => { setImportBusy(true); try { const p = await api.previewEmbyImport(importSession, selectedEmbyUsers, targetUserId); setImportPreview(p); setImportStep('preview'); } catch (e) { setImportError(e instanceof Error ? e.message : 'Preview failed.'); } finally { setImportBusy(false); } }}>Preview import</button><button class="ad-btn" disabled={importBusy} onClick={async () => { await api.discardEmbyImport(importSession).catch(() => undefined); uploadSession.current = ''; setImportStep('upload'); }}>Discard</button></div>
            </div>}
            {importStep === 'preview' && <div class="ad-import-step"><p class="ad-note">Review the preview counts before applying userdata.</p>
                {importPreview?.counts && Object.entries(importPreview.counts).map(([k, v]) => <InfoRow key={k} k={k} v={String(v)} />)}
                <div class="ad-danger"><p>Import selected users into {users.find(u => u.Id === targetUserId)?.Name || 'target user'}?</p><ConfirmButton label="Import UserData" tone="danger" onConfirm={async () => { setImportBusy(true); try { setImportResult(await api.executeEmbyImport(importSession, selectedEmbyUsers, targetUserId)); uploadSession.current = ''; setImportStep('done'); } catch (e) { setImportError(e instanceof Error ? e.message : 'Import failed.'); } finally { setImportBusy(false); } }} busy={importBusy} /><button class="ad-btn" disabled={importBusy} onClick={() => setImportStep('select')}>Back to mapping</button></div>
            </div>}
            {importStep === 'done' && <div class="ad-import-step"><StatusChip tone="green">Import complete</StatusChip>{importResult?.counts && Object.entries(importResult.counts).map(([k, v]) => <InfoRow key={k} k={k} v={String(v)} />)}{importResult?.warning && <p class="ad-note">{importResult.warning}</p>}<button class="ad-btn" onClick={() => { setImportStep('upload'); setImportProgress(0); setLibraryFile(null); setUsersFile(null); }}>Start another import</button></div>}
        </Card>}
        {selected && <div class="ad-drawer-backdrop" onClick={() => setSelected(null)}><aside ref={drawerRef} class="ad-drawer" role="dialog" aria-modal="true" aria-labelledby="admin-user-detail-title" onClick={e => e.stopPropagation()}>
            <button class="ad-drawer-close" onClick={() => setSelected(null)} aria-label="Close details">×</button>
            <h2 id="admin-user-detail-title">{selected.DisplayName || selected.Name}</h2>
            <StatusChip tone={selected.IsAdministrator ? 'blue' : 'muted'}>{selected.IsAdministrator ? 'Administrator' : 'User'}</StatusChip>
            <InfoRow k="Status" v={selected.IsDisabled ? 'Disabled' : 'Active'} />
            <InfoRow k="Last seen" v={timeAgo(selected.LastActivityDate || selected.LastLoginDate)} />
            {userError && <p class="ad-error" role="alert">{userError}</p>}
            {selected.Policy && <><h3 class="ad-drawer-section-title">Permissions &amp; access</h3>
                {(['IsAdministrator', 'IsDisabled', 'EnableLiveTvAccess', 'EnableLiveTvManagement', 'EnableRemoteAccess', 'EnableMediaPlayback'] as const).map(key => <label class="ad-policy-row" key={key}><span>{policyLabel(key)}</span><input type="checkbox" checked={selectedPolicy[key] === true} disabled={userBusy || key === 'IsDisabled' && selected.IsAdministrator} onChange={e => setSelectedPolicy(old => ({ ...old, [key]: (e.currentTarget as HTMLInputElement).checked }))} /></label>)}
                {'EnableLiveTvMultiview' in selectedPolicy && <label class="ad-policy-row"><span>Live TV Multiview</span><input type="checkbox" checked={selectedPolicy.EnableLiveTvMultiview === true} onChange={e => setSelectedPolicy(old => ({ ...old, EnableLiveTvMultiview: e.currentTarget.checked }))} /></label>}
                <h3 class="ad-drawer-section-title">Library access</h3>
                <label class="ad-policy-row"><span>All libraries</span><input type="checkbox" checked={selectedPolicy.EnableAllFolders === true} onChange={e => setSelectedPolicy(old => ({ ...old, EnableAllFolders: e.currentTarget.checked }))} /></label>
                {!selectedPolicy.EnableAllFolders && allLibraries.map(l => <label class="ad-policy-row" key={l.ItemId}><span>{l.Name}</span><input type="checkbox" checked={(selectedPolicy.EnabledFolders || []).includes(l.ItemId)} onChange={e => { const checked = e.currentTarget.checked; setSelectedPolicy(old => ({ ...old, EnabledFolders: checked ? [...(old.EnabledFolders || []), l.ItemId] : (old.EnabledFolders || []).filter((id: string) => id !== l.ItemId) })); }} /></label>)}
                <h3 class="ad-drawer-section-title">Parental controls</h3>
                <label class="ad-field">Maximum parental rating (empty means unrestricted)<input type="number" min="0" value={selectedPolicy.MaxParentalRating ?? ''} onInput={e => setSelectedPolicy(old => ({ ...old, MaxParentalRating: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) }))} /></label>
                <label class="ad-field">Blocked tags (comma-separated)<input value={(selectedPolicy.BlockedTags || []).join(', ')} onInput={e => setSelectedPolicy(old => ({ ...old, BlockedTags: e.currentTarget.value.split(',').map(t => t.trim()).filter(Boolean) }))} /></label>
                <div class="ad-drawer-actions"><ConfirmButton label="Save policy" busy={userBusy} onConfirm={async () => { setUserBusy(true); setUserError(''); try { await api.updateUserPolicy(selected.Id, selectedPolicy); setSelected({ ...selected, Policy: selectedPolicy, IsAdministrator: selectedPolicy.IsAdministrator, IsDisabled: selectedPolicy.IsDisabled }); await load(); } catch (e) { setUserError(e instanceof Error ? e.message : 'Policy update failed.'); } finally { setUserBusy(false); } }} />
                    <ConfirmButton label="Delete user" tone="danger" onConfirm={async () => { setUserBusy(true); try { await api.deleteUser(selected.Id); setSelected(null); await load(); } catch (e) { setUserError(e instanceof Error ? e.message : 'Delete failed.'); } finally { setUserBusy(false); } }} busy={userBusy} />
                </div>
                <div class="ad-drawer-actions"><ConfirmButton label="Reset password" tone="danger" onConfirm={async () => { await api.resetUserPassword(selected.Id); setUserMessage('Password reset completed.'); }} /></div>
                <h3 class="ad-drawer-section-title">Merge userdata and account</h3>
                <label class="ad-field">Merge into<select value={mergeTarget} onChange={e => { setMergeTarget(e.currentTarget.value); setMergePreview(null); }}><option value="">Select target</option>{users.filter(u => u.Id !== selected.Id).map(u => <option value={u.Id} key={u.Id}>{u.Name}</option>)}</select></label>
                {selected.Id !== session.user.Id && <button class="ad-btn" disabled={!mergeTarget} onClick={async () => { try { setMergePreview(await api.mergeUsers(selected.Id, mergeTarget)); } catch (e) { setUserError(e instanceof Error ? e.message : 'Merge preview failed.'); } }}>Preview merge</button>}
                {mergePreview && <><div class="ad-note">The source account will be deleted after merging.</div>{Object.entries(mergePreview.counts).map(([k, v]) => <InfoRow key={k} k={k} v={v} />)}<ConfirmButton label="Merge and delete source" tone="danger" onConfirm={async () => { const result = await api.mergeUsers(selected.Id, mergeTarget, false); setUserMessage(result.warning || 'Accounts merged.'); setSelected(null); await load(); }} /></>}
            </>}
            {!selected.Policy && <p class="ad-note">User policy is not available from the response.</p>}
            <h3 class="ad-drawer-section-title">Devices last used by this user</h3>
            {userDevices.length ? userDevices.map(d => <div class="ad-info" key={d.Id}><span class="ad-info-k">{d.Name} · {d.AppName}</span>{d.Id && <ConfirmButton label="Revoke device" tone="danger" onConfirm={async () => { await api.deleteDevice(d.Id!); setUserDevices(old => old.filter(v => v.Id !== d.Id)); }} />}</div>) : <Empty muted>No devices reported</Empty>}
            {history && <><h3 class="ad-drawer-section-title">Watch history · last 28 days</h3>{history.length ? history.map(h => <InfoRow key={h.MediaType} k={h.MediaType} v={`${h.PlayCount} plays · ${(h.TotalTicks / 36_000_000_000).toFixed(1)} hours`} />) : <Empty muted>No recorded playback</Empty>}</>}
            {taste?.HasProfile && <><h3 class="ad-drawer-section-title">Taste profile</h3>{taste.Persona?.Title && <InfoRow k="Identity" v={taste.Persona.Title} />}<InfoRow k="Samples" v={taste.SampleCount} /><InfoRow k="Top genres" v={(taste.Genres || []).slice(0,5).map(g => g.Label).filter(Boolean).join(', ')} />{taste.UpdatedAt && <InfoRow k="Refreshed" v={timeAgo(taste.UpdatedAt)} />}</>}
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
    return <Card title="SSO / OIDC">
        <div class="ad-grid2">
            <InfoRow k="OIDC configuration" v={<StatusChip tone={oidcEnabled ? 'green' : 'muted'}>{oidcEnabled === null ? 'Unavailable' : oidcEnabled ? 'Configured' : 'Not configured'}</StatusChip>} />
            <InfoRow k="RBAC mappings" v={mappings ? <StatusChip tone={mappings.length ? 'green' : 'muted'}>{mappings.length ? 'Configured' : 'No mappings'}</StatusChip> : <StatusChip tone="muted">Endpoint unavailable</StatusChip>} />
            {mappings && <InfoRow k="Mappings" v={`${mappings.length} group mappings`} />}
        </div>
        {mappings && !editingRbac && <div class="ad-rbac-list">{mappings.map((m, i) => <details class="ad-rbac-row" key={i}><summary>{m.oidcGroup || `Mapping ${i + 1}`}</summary><InfoRow k="Administrator" v={m.permissions?.IsAdministrator ? 'Yes' : 'No'} /><InfoRow k="Libraries" v={m.enableAllFolders ? 'All libraries' : (m.enabledFolders || []).map((id: string) => libraries.find(l => l.id === id)?.name || id).join(', ') || 'None'} /><pre class="ad-json">{JSON.stringify(m, null, 2)}</pre></details>)}</div>}
        {mappings && <div class="ad-rbac-editor">
            {editingRbac && <>
                <div class="ad-rbac-list">{draft.map((m, index) => <fieldset class="ad-mapping-form" key={index}><legend>Group {index + 1}</legend>
                    <label class="ad-field">IdP group<input value={m.oidcGroup || ''} onInput={e => updateMapping(index, { oidcGroup: e.currentTarget.value })} /></label>
                    <div class="ad-grid2">{['IsAdministrator', 'EnableLiveTvAccess', 'EnableLiveTvManagement', 'EnableLiveTvMultiview', 'EnableRemoteAccess', 'EnableMediaPlayback'].map(key => <label key={key} class="ad-policy-row"><span>{policyLabel(key)}</span><input type="checkbox" checked={m.permissions?.[key] === true} onChange={e => updateMapping(index, { permissions: { ...m.permissions, [key]: e.currentTarget.checked } })} /></label>)}</div>
                    <label class="ad-policy-row"><span>All libraries</span><input type="checkbox" checked={m.enableAllFolders === true} onChange={e => updateMapping(index, { enableAllFolders: e.currentTarget.checked })} /></label>
                    {!m.enableAllFolders && <label class="ad-field">Allowed libraries<select multiple size={Math.min(5, libraries.length || 1)} value={m.enabledFolders || []} onChange={e => updateMapping(index, { enabledFolders: Array.from(e.currentTarget.selectedOptions).map(o => o.value) })}>{libraries.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
                    <div class="ad-grid2"><label class="ad-field">Blocked tags (comma-separated)<input value={(m.blockedTags || []).join(', ')} onInput={e => updateMapping(index, { blockedTags: e.currentTarget.value.split(',').map(t => t.trim()).filter(Boolean) })} /></label><label class="ad-field">Allowed tags (comma-separated)<input value={(m.allowedTags || []).join(', ')} onInput={e => updateMapping(index, { allowedTags: e.currentTarget.value.split(',').map(t => t.trim()).filter(Boolean) })} /></label></div>
                    <div class="ad-grid2">{['Movie', 'Series', 'Music', 'Book', 'Trailer', 'LiveTvChannel'].map(kind => <label key={kind} class="ad-policy-row"><span>Block unrated {kind}</span><input type="checkbox" checked={(m.blockUnratedItems || []).includes(kind)} onChange={e => updateMapping(index, { blockUnratedItems: e.currentTarget.checked ? [...(m.blockUnratedItems || []), kind] : (m.blockUnratedItems || []).filter((value: string) => value !== kind) })} /></label>)}</div>
                    <div class="ad-grid2"><label class="ad-field">Live TV allowlisted categories<select multiple size={4} value={m.allowedLiveTvCategories || []} onChange={e => updateMapping(index, { allowedLiveTvCategories: Array.from(e.currentTarget.selectedOptions).map(o => o.value) })}>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select></label><label class="ad-field">Live TV allowlisted channels<select multiple size={4} value={m.allowedLiveTvChannels || []} onChange={e => updateMapping(index, { allowedLiveTvChannels: Array.from(e.currentTarget.selectedOptions).map(o => o.value) })}>{channels.map(c => <option key={c.id} value={c.id}>{c.number ? `${c.number} · ` : ''}{c.name}</option>)}</select></label></div>
                    <ConfirmButton label="Remove draft group" tone="danger" onConfirm={() => setRbacText(JSON.stringify(draft.filter((_, i) => i !== index), null, 2))} />
                </fieldset>)}</div>
                <button class="ad-btn" onClick={() => setRbacText(JSON.stringify([...draft, { oidcGroup: '', enableAllFolders: false, enabledFolders: [], permissions: {}, blockedTags: [], allowedTags: [], allowedLiveTvChannels: [], allowedLiveTvCategories: [] }], null, 2))}>Add group mapping</button>
                <details class="ad-rbac-row"><summary>Advanced JSON</summary><label class="ad-field">Group mapping JSON<textarea value={rbacText} rows={12} onInput={e => setRbacText(e.currentTarget.value)} /></label></details>
            </>}
            {rbacSaved && <p class="ad-note" role="status">{rbacSaved}</p>}
            {!editingRbac
                ? <button class="ad-btn" onClick={() => setEditingRbac(true)}>Edit mappings</button>
                : <span class="ad-flex"><ConfirmButton label="Save mappings" onConfirm={async () => { const value = JSON.parse(rbacText); if (!Array.isArray(value) || value.some(m => typeof m.oidcGroup !== 'string' || !m.oidcGroup.trim())) throw new Error('Each group mapping must have an IdP group name.'); await api.saveSsoConfig(value); setMappings(value); setEditingRbac(false); setRbacSaved('Mappings saved.'); }} /><button class="ad-btn" onClick={() => { setRbacText(JSON.stringify(mappings, null, 2)); setEditingRbac(false); }}>Cancel</button></span>}
        </div>}
        {libraries.length > 0 && <InfoRow k="Available libraries" v={libraries.map(l => l.name).filter(Boolean).join(', ')} />}
        {channels.length > 0 && <InfoRow k="Live TV allowlist candidates" v={`${channels.length} channels / categories available`} />}
        <div class="ad-note">Mappings apply at the next OIDC sign-in. Emergency local login: <code>?local=true</code>.</div>
    </Card>;
}

function policyLabel(key: string): string { return ({ IsAdministrator: 'Administrator', IsDisabled: 'Disabled', EnableLiveTvAccess: 'Live TV access', EnableLiveTvManagement: 'Live TV management', EnableRemoteAccess: 'Remote access', EnableMediaPlayback: 'Media playback' } as Record<string, string>)[key] || key; }
