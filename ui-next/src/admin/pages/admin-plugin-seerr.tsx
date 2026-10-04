import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { Card, InfoRow, StatusChip, Empty } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';

export function AdminPluginSeerr({ adminApi: api, plugin, session }: {
    adminApi: AdminApi; plugin: PluginInfo; session: { server: string };
}) {
    const [config, setConfig] = useState<Record<string, any>>({});
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [connected, setConnected] = useState<boolean | null>(null);
    const [modified, setModified] = useState(false);
    const [message, setMessage] = useState('');

    const load = useCallback(async () => {
        const [cfg, status] = await Promise.all([
            plugin.Id ? api.raw<Record<string, any>>(`/Plugins/${plugin.Id}/Configuration`).catch(() => ({})) : {},
            api.getSeerrStatus().catch(() => null),
        ]);
        setConfig(cfg); setDraft(JSON.parse(JSON.stringify(cfg)));
        setConnected(status?.Enabled === true);
    }, [api, plugin.Id]);

    useEffect(() => { load(); }, [load]);

    const patch = (key: string, value: any) => { setDraft(o => ({ ...o, [key]: value })); setModified(true); };
    const save = async () => {
        if (!plugin.Id) return;
        await api.putB(`/Plugins/${plugin.Id}/Configuration`, draft);
        setModified(false); setMessage('Saved.');
    };
    const testConnection = async () => {
        try {
            const result = await api.raw<{ Status?: string }>('/Seerr/Status');
            setConnected(result?.Status !== 'error');
            setMessage(result?.Status === 'error' ? 'Connection test failed.' : 'Connected.');
        } catch { setConnected(false); setMessage('Could not reach Seerr endpoint.'); }
    };

    return <PluginPageShell name={plugin.Name || 'Seerr'} description="Request gateway and Beyond Your Library" status={plugin.Status} session={session} onSave={save} modified={modified}>
        <div class="ad-page-section">
            {Object.keys(config).length === 0 ? <Card title="Connection"><Empty muted>Seerr configuration is not editable through this plugin. The gateway is configured via environment variables and plugin configuration JSON.</Empty></Card> : <>
            <Card title="Connection" actions={<button class="ad-btn" onClick={testConnection}>Test connection</button>}>
                <InfoRow k="Status" v={connected === null ? 'Unknown' : connected ? <StatusChip tone="green">Connected</StatusChip> : <StatusChip tone="red">Disconnected</StatusChip>} />
                <InfoRow k="Plugin version" v={plugin.Version || '—'} />
            </Card>
            <Card title="Beyond Your Library">
                <div class="ad-form-grid">
                    <div class="ad-form-field">
                        <label class="ad-form-label">Seerr URL</label>
                        <input class="ad-form-input" value={draft.SeerrUrl || draft.url || ''} onInput={e => { patch('SeerrUrl', e.currentTarget.value); }} />
                    </div>
                    <div class="ad-form-field">
                        <label class="ad-form-label">API key</label>
                        <input type="password" class="ad-form-input" value={draft.ApiKey || draft.apiKey || ''} onInput={e => { patch('ApiKey', e.currentTarget.value); }} />
                    </div>
                </div>
            </Card>
            </>}
        </div>
        {message && <p role="status" class="ad-shell-message">{message}</p>}
    </PluginPageShell>;
}