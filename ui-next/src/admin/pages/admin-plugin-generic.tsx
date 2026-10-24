import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { inferFields, labelify, type FieldDef } from '../plugin-fields';
import { Card, Empty } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';
import { canSavePluginDraft } from '../admin-state';
import { t } from '../../i18n';

export function AdminPluginGeneric({ adminApi: api, plugin, session }: {
    adminApi: AdminApi; plugin: PluginInfo; session: { server: string };
}) {
    const [config, setConfig] = useState<Record<string, any> | null>(null);
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [modified, setModified] = useState(false);
    const [fields, setFields] = useState<FieldDef[]>([]);
    const [error, setError] = useState('');
    const [loadedId, setLoadedId] = useState('');

    const load = useCallback(async () => {
        if (!plugin.Id) return;
        const id = plugin.Id;
        try {
            const cfg = await api.raw<Record<string, any>>(`/Plugins/${id}/Configuration`);
            if (id !== plugin.Id) return;
            setConfig(cfg);
            setDraft(JSON.parse(JSON.stringify(cfg)));
            setFields(inferFields(cfg));
            setLoadedId(id);
            setModified(false);
        } catch { if (id === plugin.Id) setError(t('Configuration is unavailable for this plugin.')); }
    }, [api, plugin.Id]);

    useEffect(() => { load(); }, [load]);

    const patch = (key: string, value: any) => {
        setDraft(old => ({ ...old, [key]: value }));
        setModified(true);
    };

    const save = async () => {
        if (!plugin.Id) return;
        if (!canSavePluginDraft(loadedId, plugin.Id)) throw new Error(t('Configuration is still loading. Wait for it to load before saving.'));
        await api.putB(`/Plugins/${plugin.Id}/Configuration`, draft, true);
        setConfig(draft);
        setModified(false);
    };
    const discard = () => { if (config) setDraft(JSON.parse(JSON.stringify(config))); setModified(false); };

    if (error) return <div class="admin-plugin-config"><div class="admin-plugin-body"><h1>{plugin.Name || t('Plugin')}</h1><Empty muted>{error}</Empty>
        <PluginEmbedLegacy api={api} plugin={plugin} session={session} />
    </div></div>;

    if (!config) return <div class="admin-plugin-config"><div class="admin-plugin-body"><h1>{plugin.Name || t('Plugin')}</h1><Empty muted>{t('Loading configuration…')}</Empty></div></div>;

    return <PluginPageShell name={plugin.Name || 'Plugin'} status={plugin.Status} session={session} onSave={save} onDiscard={discard} modified={modified} loaded={canSavePluginDraft(loadedId, plugin.Id || '')}>
        <div class="ad-page-section"><Card title={t('Configuration')}>
            <div class="ad-form-grid">
                {fields.map(f => <div key={f.key} class="ad-form-field">
                    <label class="ad-form-label">{labelify(f.key)}</label>
                    {f.type === 'bool' ? <label class="ad-toggle-row"><span>{draft[f.key] ? t('Enabled') : t('Disabled')}</span><input type="checkbox" checked={draft[f.key]} onChange={e => patch(f.key, e.currentTarget.checked)} /></label>
                    : f.type === 'number' ? <input type="number" class="ad-form-input" value={draft[f.key] ?? ''} onInput={e => patch(f.key, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} />
                    : f.type === 'secret' ? <input type="password" autoComplete="off" class="ad-form-input" value={draft[f.key] ?? ''} onInput={e => patch(f.key, e.currentTarget.value)} />
                    : <input class="ad-form-input" value={draft[f.key] ?? ''} onInput={e => patch(f.key, e.currentTarget.value)} />}
                </div>)}
            </div>
        </Card></div>
    </PluginPageShell>;
}

function PluginEmbedLegacy({ api, plugin, session }: { api: AdminApi; plugin: PluginInfo; session: { server: string } }) {
    return <Card title={t('Classic config page')}>
        <iframe src={`${session.server}/web/ConfigurationPage?name=${encodeURIComponent(plugin.Name || '')}`} class="ad-legacy-iframe" title={plugin.Name || t('Plugin')} sandbox="allow-scripts allow-same-origin allow-forms" />
    </Card>;
}