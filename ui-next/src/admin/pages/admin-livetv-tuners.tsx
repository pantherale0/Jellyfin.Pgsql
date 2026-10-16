import { useEffect, useRef, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { TunerHostInfo } from '../types';
import { Card, ConfirmButton, DataTable, Empty, StatusChip } from '../ui';
import {
    ProvisioningLoadTracker, buildTunerPayload, canSaveProvisioningDraft, tunerDraftFrom, tunerFieldVisibility, validateTunerDraft,
    type ProvisioningDraftStatus, type TunerDraft,
} from '../livetv-provisioning';
import { t } from '../../i18n';

export function errorText(e: unknown, fallback: string): string {
    return e instanceof Error && e.message ? e.message : fallback;
}

export function tunerTypeName(type: string | undefined, types: Array<{ Id?: string; Name?: string }>): string {
    return types.find(timer => timer.Id === type)?.Name || (type === 'm3u' ? 'M3U tuner' : type === 'hdhomerun' ? 'HDHomeRun' : type || 'Tuner');
}

export function ProvisioningDrawer({ title, subtitle, closeLabel, busy, onClose, children }: { title: string; subtitle?: any; closeLabel: string; busy?: boolean; onClose: () => void; children: any }) {
    const drawerRef = useRef<HTMLElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const drawer = drawerRef.current;
        if (!drawer) return;
        const previous = document.activeElement as HTMLElement | null;
        drawer.querySelector<HTMLButtonElement>('button')?.focus();
        const keyboard = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
            if (event.key === 'Tab') {
                const controls = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')).filter(el => el.getClientRects().length);
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        };
        drawer.addEventListener('keydown', keyboard);
        return () => { drawer.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
    }, []);
    const id = `admin-drawer-${title.replace(/\W+/g, '-').toLowerCase()}`;
    return <div class="ad-drawer-backdrop" onClick={() => closeRef.current()}>
        <aside ref={drawerRef} class="ad-drawer ad-provisioning" role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy} onClick={e => e.stopPropagation()}>
            <button class="ad-drawer-close" onClick={() => closeRef.current()} aria-label={closeLabel}>×</button>
            <h2 id={id}>{title}</h2>
            {subtitle}
            {children}
        </aside>
    </div>;
}

type TunerTarget = { mode: 'edit'; id: string } | { mode: 'new'; prefill?: TunerHostInfo; type: string };

function TunerEditor({ api, target, types, onClose, onSaved }: { api: AdminApi; target: TunerTarget; types: Array<{ Id?: string; Name?: string }>; onClose: () => void; onSaved: (message: string) => void }) {
    const key = target.mode === 'edit' ? target.id : 'new';
    const tracker = useRef(new ProvisioningLoadTracker());
    const [status, setStatus] = useState<ProvisioningDraftStatus>('loading');
    const [draft, setDraft] = useState<TunerDraft>(() => tunerDraftFrom(null));
    const [draftKey, setDraftKey] = useState<string>();
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        const token = tracker.current.begin(key);
        if (target.mode === 'new') {
            setDraft(tunerDraftFrom(target.prefill, target.type));
            setDraftKey(key); setStatus('ready');
            return () => tracker.current.cancel();
        }
        setStatus('loading'); setDraftKey(undefined);
        api.getLiveTvConfig().then(config => {
            if (!tracker.current.isCurrent(token, key)) return;
            const stored = (config.TunerHosts || []).find(tuner => tuner.Id === target.id);
            if (!stored) { setStatus('error'); setError(t('This tuner no longer exists.')); return; }
            setDraft(tunerDraftFrom(stored)); setDraftKey(key); setStatus('ready');
        }).catch(e => {
            if (!tracker.current.isCurrent(token, key)) return;
            setStatus('error'); setError(errorText(e, t('Tuner settings could not be loaded.')));
        });
        return () => tracker.current.cancel();
    }, [api, key]);

    const update = (patch: Partial<TunerDraft>) => { setDraft(old => ({ ...old, ...patch })); setDirty(true); setError(''); };
    const visible = tunerFieldVisibility(draft.Type);
    const ready = status === 'ready' && draftKey === key;
    const canSave = canSaveProvisioningDraft(status, draftKey, key, busy);
    const toggle = (field: keyof TunerDraft, label: string, help?: string) => <label class="ad-policy-row" key={field}>
        <span>{label}{help && <span class="ad-cell-sub">{help}</span>}</span>
        <input type="checkbox" checked={draft[field] === true} disabled={busy} onChange={e => update({ [field]: e.currentTarget.checked } as Partial<TunerDraft>)} />
    </label>;

    const save = async () => {
        if (!canSave) return;
        const invalid = validateTunerDraft(draft);
        if (invalid) { setError(invalid); return; }
        const token = tracker.current.begin(key);
        setBusy(true); setError('');
        try {
            let stored: TunerHostInfo | undefined = target.mode === 'new' ? target.prefill : undefined;
            if (target.mode === 'edit') {
                stored = (await api.getLiveTvConfig()).TunerHosts?.find(tuner => tuner.Id === target.id);
                if (!stored) throw new Error(t('This tuner no longer exists.'));
            }
            const payload = buildTunerPayload(stored, draft);
            if (target.mode === 'edit') payload.Id = target.id;
            else delete payload.Id;
            await api.saveTunerHost(payload);
            if (!tracker.current.isCurrent(token, key)) return;
            onSaved(target.mode === 'edit' ? t('Tuner saved.') : t('Tuner added. Refresh the guide to load its channels.'));
        } catch (e) {
            if (tracker.current.isCurrent(token, key)) setError(errorText(e, t('The tuner could not be saved. Check the address and that the server can reach it.')));
        } finally {
            if (tracker.current.isCurrent(token, key)) setBusy(false);
        }
    };

    const close = () => { if (!dirty || window.confirm(t('Discard unsaved tuner changes?'))) onClose(); };

    return <ProvisioningDrawer title={target.mode === 'edit' ? (draft.FriendlyName || t('Edit tuner')) : t('Add tuner')} closeLabel={t('Close tuner editor')} busy={status === 'loading' || busy} onClose={close}
        subtitle={<StatusChip tone="muted">{tunerTypeName(draft.Type, types)}</StatusChip>}>
        {error && <p role="alert" class="ad-error">{error}</p>}
        {status === 'loading' && <Empty muted>{t('Loading tuner settings…')}</Empty>}
        {ready && <form onSubmit={e => { e.preventDefault(); void save(); }}>
            {target.mode === 'new' && <label class="ad-field">{t('Tuner type')}<select value={draft.Type} disabled={busy} onChange={e => update({ Type: e.currentTarget.value })}>
                {(types.length ? types : [{ Id: 'm3u', Name: 'M3U tuner' }, { Id: 'hdhomerun', Name: 'HDHomeRun' }]).filter(timer => timer.Id === 'm3u' || timer.Id === 'hdhomerun').map(timer => <option key={timer.Id} value={timer.Id}>{timer.Name || timer.Id}</option>)}
            </select></label>}
            <label class="ad-field">{draft.Type === 'm3u' ? t('File or URL') : t('Tuner IP address or URL')}<input required value={draft.Url} disabled={busy} placeholder={draft.Type === 'm3u' ? t('http://example/playlist.m3u or /path/playlist.m3u') : '192.168.1.50'} onInput={e => update({ Url: e.currentTarget.value })} /></label>
            <label class="ad-field">{t('Friendly name')}<input value={draft.FriendlyName} disabled={busy} onInput={e => update({ FriendlyName: e.currentTarget.value })} /></label>
            {visible.tunerCount && <label class="ad-field">{t('Simultaneous stream limit (0 means unlimited)')}<input type="number" min="0" step="1" value={String(draft.TunerCount)} disabled={busy} onInput={e => update({ TunerCount: Number(e.currentTarget.value) })} /></label>}
            {visible.userAgent && <label class="ad-field">{t('User agent')}<input value={draft.UserAgent} disabled={busy} onInput={e => update({ UserAgent: e.currentTarget.value })} /></label>}
            {visible.fallbackBitrate && <label class="ad-field">{t('Fallback maximum streaming bitrate (Mbps)')}<input type="number" min="0.1" step="0.1" value={String(draft.FallbackMaxStreamingBitrateMbps)} disabled={busy} onInput={e => update({ FallbackMaxStreamingBitrateMbps: Number(e.currentTarget.value) })} /></label>}
            {visible.favoritesOnly && toggle('ImportFavoritesOnly', 'Import favourite channels only')}
            {visible.hwTranscoding && toggle('AllowHWTranscoding', 'Allow the tuner to transcode streams')}
            {visible.fmp4Container && toggle('AllowFmp4TranscodingContainer', 'Allow fMP4 transcoding container')}
            {visible.streamSharing && toggle('AllowStreamSharing', 'Allow stream sharing', 'Viewers on the same channel share one tuner stream.')}
            {visible.streamLooping && toggle('EnableStreamLooping', 'Enable stream looping', 'For sources that end and need restarting, such as some file-based channels.')}
            {visible.ignoreDts && toggle('IgnoreDts', 'Ignore DTS (decoding timestamp)')}
            {visible.nativeFramerate && toggle('ReadAtNativeFramerate', 'Read input at native frame rate')}
            <div class="ad-drawer-actions">
                <button class="ad-btn" type="submit" disabled={!canSave}>{busy ? t('Saving…') : target.mode === 'edit' ? t('Save tuner') : t('Add tuner')}</button>
                <button class="ad-btn" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button>
            </div>
        </form>}
    </ProvisioningDrawer>;
}

export function AdminLiveTvTuners({ api, tuners, types, onChanged }: { api: AdminApi; tuners: TunerHostInfo[]; types: Array<{ Id?: string; Name?: string }>; onChanged: () => Promise<unknown> | void }) {
    const [target, setTarget] = useState<TunerTarget | null>(null);
    const [discovered, setDiscovered] = useState<TunerHostInfo[] | null>(null);
    const [discovering, setDiscovering] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const discoverRequest = useRef(0);

    const discover = async () => {
        const request = ++discoverRequest.current;
        setDiscovering(true); setError(''); setMessage('');
        try {
            const rows = await api.discoverTuners(true);
            if (request === discoverRequest.current) setDiscovered(rows);
        } catch (e) {
            if (request === discoverRequest.current) setError(errorText(e, t('Tuner discovery failed.')));
        } finally {
            if (request === discoverRequest.current) setDiscovering(false);
        }
    };

    const columns = [
        { key: 'Name', label: t('Tuner'), value: (tuner: TunerHostInfo) => <><strong>{tuner.FriendlyName || tunerTypeName(tuner.Type, types)}</strong><div class="ad-cell-sub">{tunerTypeName(tuner.Type, types)}{tuner.Source && tuner.Source !== tuner.Type ? ` · ${tuner.Source}` : ''}</div></>, searchValue: (tuner: TunerHostInfo) => `${tuner.FriendlyName || ''} ${tuner.Type || ''}` },
        { key: 'Url', label: t('Address'), value: (tuner: TunerHostInfo) => <span class="ad-path">{tuner.Url || '—'}</span>, searchValue: (tuner: TunerHostInfo) => tuner.Url || '' },
        { key: 'Count', label: t('Streams'), value: (tuner: TunerHostInfo) => tuner.Type === 'm3u' ? (tuner.TunerCount ? String(tuner.TunerCount) : 'Unlimited') : 'Device reported' },
        { key: 'Actions', label: '', value: (tuner: TunerHostInfo) => <div class="ad-flex">
            <button class="ad-btn" disabled={!tuner.Id} aria-label={`Edit ${tuner.FriendlyName || t('tuner')}`} onClick={() => setTarget({ mode: 'edit', id: tuner.Id! })}>{t('Edit')}</button>
            {tuner.Id && <ConfirmButton label={t('Delete')} tone="danger" onConfirm={async () => { await api.deleteTunerHost(tuner.Id!); setMessage(t('Tuner deleted.')); await onChanged(); }} />}
        </div> },
    ];

    return <>
        <Card title={t('Tuners')} actions={<><button class="ad-btn" onClick={() => setTarget({ mode: 'new', type: 'm3u' })}>{t('Add tuner')}</button><button class="ad-btn" disabled={discovering} onClick={() => void discover()}>{discovering ? t('Discovering…') : t('Discover devices')}</button></>}>
            {error && <p role="alert" class="ad-error">{error}</p>}
            {message && <p role="status" class="ad-note">{message}</p>}
            {tuners.length ? <DataTable rows={tuners} columns={columns} getKey={tuner => tuner.Id || tuner.Url || ''} empty={t('No tuners match')} /> : <Empty muted>{t('No tuners configured. Add an M3U playlist or HDHomeRun device to get started.')}</Empty>}
        </Card>
        {discovered && <Card title={t('Discovered devices')} actions={<button class="ad-btn" onClick={() => setDiscovered(null)}>{t('Dismiss')}</button>}>
            {discovered.length ? discovered.map((device, index) => <div class="ad-info" key={device.DeviceId || device.Url || index}>
                <span class="ad-info-k">{device.FriendlyName || tunerTypeName(device.Type, types)}<span class="ad-cell-sub">{device.Url}</span></span>
                <button class="ad-btn" onClick={() => setTarget({ mode: 'new', prefill: device, type: device.Type || 'hdhomerun' })}>{t('Add')}</button>
            </div>) : <Empty muted>{t('No new devices were found on the server\'s network.')}</Empty>}
        </Card>}
        {target && <TunerEditor key={target.mode === 'edit' ? target.id : `new-${target.prefill?.DeviceId || target.type}`} api={api} target={target} types={types} onClose={() => setTarget(null)}
            onSaved={async text => { setTarget(null); setDiscovered(null); setMessage(text); await onChanged(); }} />}
    </>;
}
