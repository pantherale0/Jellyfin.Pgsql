import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { Card, InfoRow, StatusChip, Empty } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';
import { canSavePluginDraft } from '../admin-state';
import { t } from '../../i18n';

export function AdminPluginSeerr({ adminApi: api, plugin, session }: {
    adminApi: AdminApi; plugin: PluginInfo; session: { server: string };
}) {
    const [config, setConfig] = useState<Record<string, any>>({});
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [connected, setConnected] = useState<boolean | null>(null);
    const [modified, setModified] = useState(false);
    const [message, setMessage] = useState('');
    const [loadedId, setLoadedId] = useState('');
    const [loadError, setLoadError] = useState('');

    const load = useCallback(async () => {
        const id = plugin.Id || '';
        const [cfg, status] = await Promise.all([
            id ? api.raw<Record<string, any>>(`/Plugins/${id}/Configuration`).catch(() => null) : null,
            api.getSeerrStatus().catch(() => null),
        ]);
        if (id !== plugin.Id) return;
        setConnected(status?.enabled === true);
        if (cfg === null) { setLoadError(t('The plugin configuration could not be loaded, so it cannot be saved.')); return; }
        setLoadError('');
        setConfig(cfg); setDraft(JSON.parse(JSON.stringify(cfg)));
        setLoadedId(id);
    }, [api, plugin.Id]);

    useEffect(() => { load(); }, [load]);

    const patch = (key: string, value: any) => { setDraft(o => ({ ...o, [key]: value })); setModified(true); };
    const save = async () => {
        if (!plugin.Id) return;
        if (!canSavePluginDraft(loadedId, plugin.Id)) throw new Error(t('Configuration is still loading. Wait for it to load before saving.'));
        await api.putB(`/Plugins/${plugin.Id}/Configuration`, draft, true);
        setConfig(draft); setModified(false); setMessage(t('Saved.'));
    };
    const discard = () => { setDraft(JSON.parse(JSON.stringify(config))); setModified(false); };
    const testConnection = async () => {
        try {
            const result = await api.testSeerrConnection();
            setConnected(true);
            setMessage(result?.Message || result?.message || (result?.Version ? t('Connected to Seerr {0}.', result.Version) : t('Connected.')));
        } catch (e) { setConnected(false); setMessage(e instanceof Error ? e.message : t('Could not reach Seerr endpoint.')); }
    };

    return <PluginPageShell name={plugin.Name || 'Seerr'} description={t('Request gateway and Beyond Your Library')} status={plugin.Status} session={session} onSave={save} onDiscard={discard} modified={modified} loaded={canSavePluginDraft(loadedId, plugin.Id || '')} loadError={loadError}>
        <div class="ad-page-section">
            {!canSavePluginDraft(loadedId, plugin.Id || '') ? <Card title={t('Connection')}><Empty muted>{t('Seerr configuration is not available.')}</Empty></Card> : <>
            <Card title={t('Connection')} actions={<button class="ad-btn" onClick={testConnection}>{t('Test connection')}</button>}>
                <InfoRow k={t('Status')} v={connected === null ? t('Unknown') : connected ? <StatusChip tone="green">{t('Connected')}</StatusChip> : <StatusChip tone="red">{t('Disconnected')}</StatusChip>} />
                <InfoRow k={t('Plugin version')} v={plugin.Version || '—'} />
            </Card>
            <Card title={t('Gateway')}>
                <div class="ad-form-grid">
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Enabled')}</label>
                        <label class="ad-toggle-row"><span>{draft.Enabled ? t('Enabled') : t('Disabled')}</span><input type="checkbox" checked={draft.Enabled === true} onChange={e => patch('Enabled', e.currentTarget.checked)} /></label>
                    </div>
                </div>
            </Card>
            <Card title={t('Beyond Your Library')}>
                <div class="ad-form-grid">
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Seerr URL')}</label>
                        <input class="ad-form-input" value={draft.SeerrUrl ?? ''} onInput={e => { patch('SeerrUrl', e.currentTarget.value); }} />
                    </div>
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('API key')}</label>
                        <input type="password" autoComplete="off" class="ad-form-input" value={draft.ApiKey ?? ''} onInput={e => { patch('ApiKey', e.currentTarget.value); }} />
                    </div>
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Hide titles already in the library')}</label>
                        <label class="ad-toggle-row"><span>{draft.HideAvailable ? t('Enabled') : t('Disabled')}</span><input type="checkbox" checked={draft.HideAvailable === true} onChange={e => patch('HideAvailable', e.currentTarget.checked)} /></label>
                    </div>
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Search result limit')}</label>
                        <input type="number" min="1" class="ad-form-input" value={draft.SearchLimit ?? ''} onInput={e => patch('SearchLimit', e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} />
                    </div>
                </div>
            </Card>
            </>}
        </div>
        {message && <p role="status" class="ad-shell-message">{message}</p>}
    </PluginPageShell>;
}