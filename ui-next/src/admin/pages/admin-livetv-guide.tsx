import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { ListingsProviderInfo, TunerHostInfo } from '../types';
import { Card, ConfirmButton, DataTable, Empty, SearchInput, StatusChip } from '../ui';
import {
    ProvisioningLoadTracker, buildProviderPayload, canSaveProvisioningDraft, mergeChannelMappings, providerDraftFrom, schedulesDirectCountries, validateProviderDraft,
    type ChannelMappingRow, type ProviderDraft, type ProvisioningDraftStatus,
} from '../livetv-provisioning';
import { ProvisioningDrawer, errorText, tunerTypeName } from './admin-livetv-tuners';
import { t } from '../../i18n';

export function providerTypeName(type: string | undefined): string {
    return type === 'xmltv' ? 'XMLTV' : type === 'SchedulesDirect' ? t('Schedules Direct') : type || t('Guide provider');
}

type ProviderTarget = { mode: 'edit'; id: string } | { mode: 'new'; type: 'xmltv' | 'SchedulesDirect' };

function ProviderEditor({ api, target, tuners, onClose, onSaved }: { api: AdminApi; target: ProviderTarget; tuners: TunerHostInfo[]; onClose: () => void; onSaved: (message: string) => void }) {
    const tracker = useRef(new ProvisioningLoadTracker());
    const lineupTracker = useRef(new ProvisioningLoadTracker());
    const [providerId, setProviderId] = useState(target.mode === 'edit' ? target.id : '');
    const key = providerId || 'new';
    const [status, setStatus] = useState<ProvisioningDraftStatus>('loading');
    const [draft, setDraft] = useState<ProviderDraft>(() => providerDraftFrom(null, target.mode === 'new' ? target.type : 'xmltv'));
    const [draftKey, setDraftKey] = useState<string>();
    const [hasStoredPassword, setHasStoredPassword] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [countries, setCountries] = useState<Array<{ name: string; value: string }>>([]);
    const [lineups, setLineups] = useState<Array<{ Id?: string; Name?: string }> | null>(null);
    const [lineupsBusy, setLineupsBusy] = useState(false);

    useEffect(() => {
        const token = tracker.current.begin(key);
        if (target.mode === 'new' && !providerId) {
            setStatus('loading');
            api.getDefaultListingProvider().catch(() => null).then(defaults => {
                if (!tracker.current.isCurrent(token, key)) return;
                setDraft({ ...providerDraftFrom(defaults ? { ...defaults, Id: undefined, Type: target.type } : null, target.type), EnableAllTuners: true, EnabledTuners: [] });
                setDraftKey(key); setStatus('ready');
            });
            return () => tracker.current.cancel();
        }
        if (draftKey === key) return () => tracker.current.cancel();
        setStatus('loading');
        api.getLiveTvConfig().then(config => {
            if (!tracker.current.isCurrent(token, key)) return;
            const stored = (config.ListingProviders || []).find(p => p.Id === providerId);
            if (!stored) { setStatus('error'); setError(t('This guide provider no longer exists.')); return; }
            setDraft(providerDraftFrom(stored)); setHasStoredPassword(!!stored.Password); setDraftKey(key); setStatus('ready');
        }).catch(e => {
            if (!tracker.current.isCurrent(token, key)) return;
            setStatus('error'); setError(errorText(e, t('Guide provider settings could not be loaded.')));
        });
        return () => tracker.current.cancel();
    }, [api, key]);

    const isSd = draft.Type === 'SchedulesDirect';
    const signedIn = isSd && !!providerId;
    useEffect(() => {
        if (!signedIn || countries.length) return;
        let active = true;
        api.getSchedulesDirectCountries().then(rows => { if (active) setCountries(schedulesDirectCountries(rows)); }).catch(() => undefined);
        return () => { active = false; };
    }, [api, signedIn]);

    const update = (patch: Partial<ProviderDraft>) => { setDraft(old => ({ ...old, ...patch })); setDirty(true); setError(''); setNotice(''); };
    const ready = status === 'ready' && draftKey === key;
    const canSave = canSaveProvisioningDraft(status, draftKey, key, busy);

    const latestStored = async (): Promise<ListingsProviderInfo | undefined> => {
        if (!providerId) return undefined;
        const stored = (await api.getLiveTvConfig()).ListingProviders?.find(p => p.Id === providerId);
        if (!stored) throw new Error(t('This guide provider no longer exists.'));
        return stored;
    };

    const signIn = async () => {
        if (!canSave) return;
        const invalid = validateProviderDraft(draft, 'login', hasStoredPassword);
        if (invalid) { setError(invalid); return; }
        const token = tracker.current.begin(key);
        setBusy(true); setError('');
        try {
            const payload = buildProviderPayload(await latestStored(), draft);
            if (!providerId) delete payload.Id;
            const saved = await api.saveListingProvider(payload, { validateLogin: true });
            if (!tracker.current.isCurrent(token, key)) return;
            setHasStoredPassword(true);
            setDraft(old => ({ ...old, Password: '' }));
            setDirty(false);
            setBusy(false);
            if (saved?.Id && saved.Id !== providerId) { tracker.current.cancel(); setDraftKey(saved.Id); setProviderId(saved.Id); }
            setNotice(t('Signed in to Schedules Direct. Choose a country, postal code and lineup.'));
        } catch (e) {
            if (tracker.current.isCurrent(token, key)) setError(errorText(e, t('Schedules Direct sign-in failed. Check the username and password.')));
        } finally {
            if (tracker.current.isCurrent(token, key)) setBusy(false);
        }
    };

    const findLineups = async () => {
        if (!providerId || !draft.Country || !draft.ZipCode.trim()) { setError(t('Choose a country and enter a postal code first.')); return; }
        const lookup = `${providerId}|${draft.Country}|${draft.ZipCode.trim()}`;
        const token = lineupTracker.current.begin(lookup);
        setLineupsBusy(true); setError('');
        try {
            const rows = await api.getLineups({ Id: providerId, Type: draft.Type, Country: draft.Country, ZipCode: draft.ZipCode.trim() });
            if (!lineupTracker.current.isCurrent(token, lookup)) return;
            setLineups(rows);
            if (!rows.some(r => r.Id === draft.ListingsId)) update({ ListingsId: '' });
        } catch (e) {
            if (lineupTracker.current.isCurrent(token, lookup)) setError(errorText(e, t('Lineups could not be loaded for that location.')));
        } finally {
            if (lineupTracker.current.isCurrent(token, lookup)) setLineupsBusy(false);
        }
    };

    const save = async () => {
        if (!canSave) return;
        const invalid = validateProviderDraft(draft, 'listings', hasStoredPassword);
        if (invalid) { setError(invalid); return; }
        const token = tracker.current.begin(key);
        setBusy(true); setError('');
        try {
            const payload = buildProviderPayload(await latestStored(), draft);
            if (!providerId) delete payload.Id;
            await api.saveListingProvider(payload, { validateListings: true });
            if (!tracker.current.isCurrent(token, key)) return;
            onSaved(target.mode === 'edit' ? t('Guide provider saved. Refresh the guide to apply it.') : t('Guide provider added. Refresh the guide to load listings.'));
        } catch (e) {
            if (tracker.current.isCurrent(token, key)) setError(errorText(e, t('The guide provider could not be saved. Check that the server can read the listings.')));
        } finally {
            if (tracker.current.isCurrent(token, key)) setBusy(false);
        }
    };

    const close = () => { if (!dirty || window.confirm(t('Discard unsaved guide provider changes?'))) onClose(); };
    const categoryField = (field: 'MovieCategories' | 'KidsCategories' | 'NewsCategories' | 'SportsCategories', label: string) =>
        <label class="ad-field" key={field}>{t(label)}<input value={draft[field]} disabled={busy} placeholder={t('Separate categories with |')} onInput={e => update({ [field]: e.currentTarget.value } as Partial<ProviderDraft>)} /></label>;

    return <ProvisioningDrawer title={target.mode === 'edit' ? t('Edit {0}', providerTypeName(draft.Type)) : t('Add {0}', providerTypeName(draft.Type))} closeLabel={t('Close guide provider editor')} busy={status === 'loading' || busy} onClose={close}
        subtitle={<StatusChip tone="muted">{providerTypeName(draft.Type)}</StatusChip>}>
        {error && <p role="alert" class="ad-error">{error}</p>}
        {notice && <p role="status" class="ad-note">{notice}</p>}
        {status === 'loading' && <Empty muted>{t('Loading guide provider…')}</Empty>}
        {ready && <form onSubmit={e => { e.preventDefault(); void (isSd && !signedIn ? signIn() : save()); }}>
            {!isSd && <>
                <label class="ad-field">{t('XMLTV file path or URL')}<input required value={draft.Path} disabled={busy} placeholder={t('/config/guide.xml or https://example/guide.xml')} onInput={e => update({ Path: e.currentTarget.value })} /></label>
                <label class="ad-field">{t('User agent')}<input value={draft.UserAgent} disabled={busy} onInput={e => update({ UserAgent: e.currentTarget.value })} /></label>
                <label class="ad-field">{t('Movie title prefix')}<input value={draft.MoviePrefix} disabled={busy} onInput={e => update({ MoviePrefix: e.currentTarget.value })} /></label>
                <h3 class="ad-drawer-section-title">{t('Category mapping')}</h3>
                <p class="ad-note">{t('XMLTV categories that identify each kind of programme.')}</p>
                {categoryField('MovieCategories', t('Movie categories'))}
                {categoryField('KidsCategories', t('Kids categories'))}
                {categoryField('NewsCategories', t('News categories'))}
                {categoryField('SportsCategories', t('Sports categories'))}
            </>}
            {isSd && <>
                <label class="ad-field">{t('Username')}<input required autocomplete="username" value={draft.Username} disabled={busy} onInput={e => update({ Username: e.currentTarget.value })} /></label>
                <label class="ad-field">{t('Password')}<input type="password" autocomplete="new-password" value={draft.Password} disabled={busy} placeholder={hasStoredPassword ? t('Leave blank to keep the saved password') : ''} onInput={e => update({ Password: e.currentTarget.value })} /></label>
                {signedIn && <button class="ad-btn" type="button" disabled={busy || (!draft.Password && !dirty)} onClick={() => void signIn()}>{t('Update sign-in')}</button>}
                {signedIn && <>
                    <h3 class="ad-drawer-section-title">{t('Lineup')}</h3>
                    <label class="ad-field">{t('Country')}<select value={draft.Country} disabled={busy} onChange={e => { update({ Country: e.currentTarget.value }); setLineups(null); }}>
                        <option value="">{t('Select country')}</option>
                        {countries.map(c => <option key={c.value} value={c.value}>{c.name}</option>)}
                    </select></label>
                    <div class="ad-flex ad-inline-field">
                        <label class="ad-field">{t('Postal code')}<input value={draft.ZipCode} disabled={busy} onInput={e => { update({ ZipCode: e.currentTarget.value }); setLineups(null); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void findLineups(); } }} /></label>
                        <button class="ad-btn" type="button" disabled={busy || lineupsBusy || !draft.Country || !draft.ZipCode.trim()} onClick={() => void findLineups()}>{lineupsBusy ? t('Searching…') : t('Find lineups')}</button>
                    </div>
                    {lineups !== null && (lineups.length
                        ? <label class="ad-field">{t('Lineup')}<select value={draft.ListingsId} disabled={busy} onChange={e => update({ ListingsId: e.currentTarget.value })}>
                            <option value="">{t('Select lineup')}</option>
                            {lineups.map(l => <option key={l.Id} value={l.Id}>{l.Name || l.Id}</option>)}
                        </select></label>
                        : <Empty muted>{t('No lineups were found for that location.')}</Empty>)}
                    {lineups === null && draft.ListingsId && <p class="ad-note">{t('Current lineup: {0}. Use Find lineups to change it.', draft.ListingsId)}</p>}
                </>}
            </>}
            {(!isSd || signedIn) && <>
                <h3 class="ad-drawer-section-title">{t('Tuners')}</h3>
                <label class="ad-policy-row"><span>{t('Use with all tuners')}</span><input type="checkbox" checked={draft.EnableAllTuners} disabled={busy} onChange={e => update({ EnableAllTuners: e.currentTarget.checked })} /></label>
                {!draft.EnableAllTuners && (tuners.length ? tuners.filter(t => t.Id).map(t => <label class="ad-policy-row" key={t.Id}>
                    <span>{t.FriendlyName || tunerTypeName(t.Type, [])}<span class="ad-cell-sub">{t.Url}</span></span>
                    <input type="checkbox" checked={draft.EnabledTuners.includes(t.Id!)} disabled={busy} onChange={e => { const checked = e.currentTarget.checked; update({ EnabledTuners: checked ? [...draft.EnabledTuners.filter(id => id !== t.Id), t.Id!] : draft.EnabledTuners.filter(id => id !== t.Id) }); }} />
                </label>) : <Empty muted>{t('No tuners are configured yet.')}</Empty>)}
            </>}
            <div class="ad-drawer-actions">
                {isSd && !signedIn
                    ? <button class="ad-btn" type="submit" disabled={!canSave}>{busy ? t('Signing in…') : t('Sign in')}</button>
                    : <button class="ad-btn" type="submit" disabled={!canSave}>{busy ? t('Saving…') : target.mode === 'edit' ? t('Save provider') : t('Add provider')}</button>}
                <button class="ad-btn" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button>
            </div>
        </form>}
    </ProvisioningDrawer>;
}

function ChannelMappingDrawer({ api, provider, onClose }: { api: AdminApi; provider: ListingsProviderInfo; onClose: () => void }) {
    const providerId = provider.Id!;
    const tracker = useRef(new ProvisioningLoadTracker());
    const rowRequests = useRef(new Map<string, number>());
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    const [status, setStatus] = useState<ProvisioningDraftStatus>('loading');
    const [error, setError] = useState('');
    const [rows, setRows] = useState<ChannelMappingRow[]>([]);
    const [providerChannels, setProviderChannels] = useState<Array<{ Id: string; Name: string }>>([]);
    const [providerName, setProviderName] = useState('');
    const [pending, setPending] = useState<Record<string, boolean>>({});
    const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
    const [picking, setPicking] = useState<ChannelMappingRow | null>(null);
    const [pickerQuery, setPickerQuery] = useState('');
    const [query, setQuery] = useState('');

    useEffect(() => {
        const token = tracker.current.begin(providerId);
        setStatus('loading');
        api.getChannelMappingOptions(providerId).then(options => {
            if (!tracker.current.isCurrent(token, providerId)) return;
            setRows(mergeChannelMappings(options));
            setProviderChannels((options.ProviderChannels || []).filter(c => c.Id).map(c => ({ Id: c.Id!, Name: c.Name || c.Id! })).sort((a, b) => a.Name.localeCompare(b.Name)));
            setProviderName(options.ProviderName || providerTypeName(provider.Type));
            setStatus('ready');
        }).catch(e => {
            if (!tracker.current.isCurrent(token, providerId)) return;
            setStatus('error'); setError(errorText(e, t('Channel mapping options could not be loaded. Check that the provider and tuners are reachable.')));
        });
        return () => tracker.current.cancel();
    }, [api, providerId]);

    const map = async (row: ChannelMappingRow, providerChannelId: string) => {
        const request = (rowRequests.current.get(row.tunerChannelId) || 0) + 1;
        rowRequests.current.set(row.tunerChannelId, request);
        setPending(old => ({ ...old, [row.tunerChannelId]: true }));
        setRowErrors(old => ({ ...old, [row.tunerChannelId]: '' }));
        try {
            const result = await api.setChannelMapping(providerId, row.tunerChannelId, providerChannelId);
            if (rowRequests.current.get(row.tunerChannelId) !== request || !mounted.current) return;
            const reset = providerChannelId === row.tunerChannelId;
            const mappedId = result?.ProviderChannelId || (reset ? '' : providerChannelId);
            setRows(old => old.map(r => r.tunerChannelId === row.tunerChannelId ? {
                ...r,
                providerChannelId: mappedId,
                providerChannelName: result?.ProviderChannelName || providerChannels.find(c => c.Id.toLowerCase() === mappedId.toLowerCase())?.Name || mappedId,
                explicit: !reset,
            } : r));
        } catch (e) {
            if (rowRequests.current.get(row.tunerChannelId) === request && mounted.current) setRowErrors(old => ({ ...old, [row.tunerChannelId]: errorText(e, t('Mapping failed.')) }));
        } finally {
            if (rowRequests.current.get(row.tunerChannelId) === request && mounted.current) setPending(old => ({ ...old, [row.tunerChannelId]: false }));
        }
    };

    const pickerOptions = useMemo(() => {
        const needle = pickerQuery.trim().toLowerCase();
        return providerChannels.filter(c => !needle || c.Name.toLowerCase().includes(needle) || c.Id.toLowerCase().includes(needle)).slice(0, 100);
    }, [providerChannels, pickerQuery]);

    const columns = [
        { key: 'Tuner', label: t('Tuner channel'), value: (r: ChannelMappingRow) => <><strong>{r.tunerChannelName}</strong><div class="ad-cell-sub">{r.tunerChannelId}</div></>, searchValue: (r: ChannelMappingRow) => `${r.tunerChannelName} ${r.tunerChannelId}` },
        { key: 'Guide', label: `${providerName || 'Guide'} channel`, value: (r: ChannelMappingRow) => <>{r.providerChannelName || <span class="ad-subtle">{t('Not matched')}</span>} {r.explicit ? <StatusChip tone="blue">{t('Mapped')}</StatusChip> : r.providerChannelId ? <StatusChip tone="muted">{t('Automatic')}</StatusChip> : null}{rowErrors[r.tunerChannelId] && <div role="alert" class="ad-error">{rowErrors[r.tunerChannelId]}</div>}</>, searchValue: (r: ChannelMappingRow) => r.providerChannelName },
        { key: 'Actions', label: '', value: (r: ChannelMappingRow) => <div class="ad-flex">
            <button class="ad-btn" disabled={pending[r.tunerChannelId]} aria-label={t('Change guide channel for {0}', r.tunerChannelName)} onClick={() => { setPicking(r); setPickerQuery(''); }}>{pending[r.tunerChannelId] ? t('Saving…') : t('Change')}</button>
            {r.explicit && <button class="ad-btn" disabled={pending[r.tunerChannelId]} aria-label={t('Use automatic match for {0}', r.tunerChannelName)} onClick={() => void map(r, r.tunerChannelId)}>{t('Automatic')}</button>}
        </div> },
    ];

    return <ProvisioningDrawer title={t('Map channels · {0}', provider.Path || provider.ListingsId || providerTypeName(provider.Type))} closeLabel={t('Close channel mapping')} busy={status === 'loading'} onClose={() => { if (picking) setPicking(null); else onClose(); }}>
        <p class="ad-note">{t('Each change is saved immediately and queues a guide refresh.')}</p>
        {error && <p role="alert" class="ad-error">{error}</p>}
        {status === 'loading' && <Empty muted>{t('Loading channels…')}</Empty>}
        {status === 'ready' && !picking && <>
            <div class="ad-toolbar"><SearchInput value={query} onInput={setQuery} placeholder={t('Search channels…')} /><span class="ad-subtle">{t('{0} tuner channels', rows.length)}</span></div>
            <DataTable rows={rows} columns={columns} getKey={r => r.tunerChannelId} empty={t('No tuner channels')} query={query} />
        </>}
        {status === 'ready' && picking && <div class="ad-channel-picker">
            <h3 class="ad-drawer-section-title">{t('Guide channel for {0}', picking.tunerChannelName)}</h3>
            <SearchInput value={pickerQuery} onInput={setPickerQuery} placeholder={t('Filter guide channels…')} />
            <div class="ad-channel-picker-list" role="listbox" aria-label={t('Guide channels')}>
                {pickerOptions.map(c => <button key={c.Id} type="button" role="option" aria-selected={c.Id.toLowerCase() === picking.providerChannelId.toLowerCase()} class={`ad-channel-option${c.Id.toLowerCase() === picking.providerChannelId.toLowerCase() ? ' on' : ''}`}
                    onClick={() => { const row = picking; setPicking(null); void map(row, c.Id); }}><span>{c.Name}</span><span class="ad-cell-sub">{c.Id}</span></button>)}
                {pickerOptions.length === 0 && <Empty muted>{t('No guide channels match.')}</Empty>}
            </div>
            {providerChannels.length > pickerOptions.length && pickerOptions.length === 100 && <p class="ad-note">{t('Showing the first 100 matches. Refine the filter to find more.')}</p>}
            <div class="ad-drawer-actions"><button class="ad-btn" type="button" onClick={() => setPicking(null)}>{t('Back to channels')}</button></div>
        </div>}
    </ProvisioningDrawer>;
}

export function AdminLiveTvGuide({ api, providers, tuners, onChanged }: { api: AdminApi; providers: ListingsProviderInfo[]; tuners: TunerHostInfo[]; onChanged: () => Promise<unknown> | void }) {
    const [target, setTarget] = useState<ProviderTarget | null>(null);
    const [mapping, setMapping] = useState<ListingsProviderInfo | null>(null);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [refreshing, setRefreshing] = useState(false);

    const refreshGuide = async () => {
        setRefreshing(true); setError(''); setMessage('');
        try {
            const task = (await api.getScheduledTasks()).find(t => t.Key === 'RefreshGuide');
            if (!task) throw new Error(t('The guide refresh task is not available on this server.'));
            await api.startTask(task.Id);
            setMessage(t('Guide refresh started. Progress is shown under Infrastructure scheduled tasks.'));
        } catch (e) {
            setError(errorText(e, t('The guide refresh could not be started.')));
        } finally {
            setRefreshing(false);
        }
    };

    const columns = [
        { key: 'Type', label: t('Provider'), value: (p: ListingsProviderInfo) => <><strong>{providerTypeName(p.Type)}</strong><div class="ad-cell-sub">{p.Type === 'SchedulesDirect' ? p.Username || t('Not signed in') : ''}</div></>, searchValue: (p: ListingsProviderInfo) => providerTypeName(p.Type) },
        { key: 'Source', label: t('Source'), value: (p: ListingsProviderInfo) => <span class="ad-path">{p.Type === 'xmltv' ? p.Path || '—' : p.ListingsId || t('No lineup selected')}</span>, searchValue: (p: ListingsProviderInfo) => p.Path || p.ListingsId || '' },
        { key: 'Tuners', label: t('Tuners'), value: (p: ListingsProviderInfo) => p.EnableAllTuners ? 'All tuners' : `${(p.EnabledTuners || []).length} selected` },
        { key: 'Mappings', label: t('Mapped channels'), value: (p: ListingsProviderInfo) => String((p.ChannelMappings || []).length) },
        { key: 'Actions', label: '', value: (p: ListingsProviderInfo) => <div class="ad-flex">
            <button class="ad-btn" disabled={!p.Id} onClick={() => setTarget({ mode: 'edit', id: p.Id! })}>{t('Edit')}</button>
            <button class="ad-btn" disabled={!p.Id} onClick={() => setMapping(p)}>{t('Map channels')}</button>
            {p.Id && <ConfirmButton label={t('Delete')} tone="danger" onConfirm={async () => { await api.deleteListingProvider(p.Id!); setMessage(t('Guide provider deleted.')); await onChanged(); }} />}
        </div> },
    ];

    return <>
        <Card title={t('Guide providers')} actions={<>
            <button class="ad-btn" onClick={() => setTarget({ mode: 'new', type: 'xmltv' })}>{t('Add XMLTV')}</button>
            <button class="ad-btn" onClick={() => setTarget({ mode: 'new', type: 'SchedulesDirect' })}>{t('Add Schedules Direct')}</button>
            <button class="ad-btn" disabled={refreshing || providers.length === 0} onClick={() => void refreshGuide()}>{refreshing ? t('Starting…') : t('Refresh guide')}</button>
        </>}>
            {error && <p role="alert" class="ad-error">{error}</p>}
            {message && <p role="status" class="ad-note">{message}</p>}
            {providers.length ? <DataTable rows={providers} columns={columns} getKey={p => p.Id || p.Path || ''} empty={t('No guide providers match')} /> : <Empty muted>{t('No guide providers configured. Add an XMLTV source or a Schedules Direct account to populate the guide.')}</Empty>}
        </Card>
        {target && <ProviderEditor key={target.mode === 'edit' ? target.id : `new-${target.type}`} api={api} target={target} tuners={tuners} onClose={() => { setTarget(null); void onChanged(); }}
            onSaved={async text => { setTarget(null); setMessage(text); await onChanged(); }} />}
        {mapping && <ChannelMappingDrawer key={mapping.Id} api={api} provider={mapping} onClose={() => { setMapping(null); void onChanged(); }} />}
    </>;
}
