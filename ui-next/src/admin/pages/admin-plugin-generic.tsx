import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { Card, Empty, InfoRow } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';

export function AdminPluginGeneric({ adminApi: api, plugin, session }: {
    adminApi: AdminApi; plugin: PluginInfo; session: { server: string };
}) {
    const [config, setConfig] = useState<Record<string, any> | null>(null);
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [modified, setModified] = useState(false);
    const [fields, setFields] = useState<FieldDef[]>([]);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        if (!plugin.Id) return;
        try {
            const cfg = await api.raw<Record<string, any>>(`/Plugins/${plugin.Id}/Configuration`);
            setConfig(cfg);
            setDraft(JSON.parse(JSON.stringify(cfg)));
            setFields(inferFields(cfg));
            setModified(false);
        } catch { setError('Configuration is unavailable for this plugin.'); }
    }, [api, plugin.Id]);

    useEffect(() => { load(); }, [load]);

    const patch = (key: string, value: any) => {
        setDraft(old => ({ ...old, [key]: value }));
        setModified(true);
    };

    const save = async () => {
        if (!plugin.Id) return;
        await api.putB(`/Plugins/${plugin.Id}/Configuration`, draft);
        setModified(false);
    };

    const group = (key: string) => {
        if (/[Pp]assword|[Tt]oken|[Ss]ecret|[Aa]pi[Kk]ey/i.test(key)) return 'secret';
        if (/[Ee]nable|[Ee]nabled|[Dd]isable|[Dd]isabled|[Uu]se[Pp]re|allow|Allow/.test(key)) return 'bool';
        return 'plain';
    };

    if (error) return <div class="admin-plugin-config"><div class="admin-plugin-body"><h1>{plugin.Name || 'Plugin'}</h1><Empty muted>{error}</Empty>
        <PluginEmbedLegacy api={api} plugin={plugin} session={session} />
    </div></div>;

    if (!config) return <div class="admin-plugin-config"><div class="admin-plugin-body"><h1>{plugin.Name || 'Plugin'}</h1><Empty muted>Loading configuration…</Empty></div></div>;

    return <PluginPageShell name={plugin.Name || 'Plugin'} status={plugin.Status} session={session} onSave={save} modified={modified}>
        <div class="ad-page-section"><Card title="Configuration">
            <div class="ad-form-grid">
                {fields.map(f => <div key={f.key} class="ad-form-field">
                    <label class="ad-form-label">{labelify(f.key)}</label>
                    {f.type === 'bool' ? <label class="ad-toggle-row"><span>{draft[f.key] ? 'Enabled' : 'Disabled'}</span><input type="checkbox" checked={draft[f.key]} onChange={e => patch(f.key, e.currentTarget.checked)} /></label>
                    : f.type === 'number' ? <input type="number" class="ad-form-input" value={draft[f.key] ?? ''} onInput={e => patch(f.key, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} />
                    : f.type === 'secret' ? <input type="password" class="ad-form-input" value={draft[f.key] ?? ''} onInput={e => patch(f.key, e.currentTarget.value)} />
                    : <input class="ad-form-input" value={draft[f.key] ?? ''} onInput={e => patch(f.key, e.currentTarget.value)} />}
                </div>)}
            </div>
        </Card></div>
    </PluginPageShell>;
}

function PluginEmbedLegacy({ api, plugin, session }: { api: AdminApi; plugin: PluginInfo; session: { server: string } }) {
    return <Card title="Classic config page">
        <iframe src={`${session.server}/web/ConfigurationPage?name=${encodeURIComponent(plugin.Name || '')}`} class="ad-legacy-iframe" title={plugin.Name || 'Plugin'} sandbox="allow-scripts allow-same-origin allow-forms" />
    </Card>;
}

function labelify(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).replace(/\./g, ' · ');
}

interface FieldDef { key: string; type: 'string' | 'number' | 'bool' | 'secret' }

function inferFields(obj: Record<string, any>): FieldDef[] {
    return Object.entries(obj)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map(([key, value]) => ({
            key,
            type: typeof value as 'string' | 'number' | 'bool',
        }));
}