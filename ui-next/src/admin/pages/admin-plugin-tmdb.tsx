import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { Card, InfoRow } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';

export function AdminPluginTmdb({ adminApi: api, plugin, session }: {
    adminApi: AdminApi; plugin: PluginInfo; session: { server: string };
}) {
    const [config, setConfig] = useState<Record<string, any>>({});
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [modified, setModified] = useState(false);
    const [message, setMessage] = useState('');

    const load = useCallback(async () => {
        if (!plugin.Id) return;
        const cfg = await api.raw<Record<string, any>>(`/Plugins/${plugin.Id}/Configuration`).catch(() => ({}));
        setConfig(cfg); setDraft(JSON.parse(JSON.stringify(cfg)));
    }, [api, plugin.Id]);

    useEffect(() => { load(); }, [load]);

    const patch = (key: string, value: any) => { setDraft(o => ({ ...o, [key]: value })); setModified(true); };
    const save = async () => {
        if (!plugin.Id) return;
        await api.putB(`/Plugins/${plugin.Id}/Configuration`, draft);
        setModified(false); setMessage('Saved.');
    };

    const bool = (key: string, label: string) => (
        <div class="ad-form-field"><label class="ad-form-label">{label}</label>
            <label class="ad-toggle-row"><span>{draft[key] ? 'Enabled' : 'Disabled'}</span><input type="checkbox" checked={draft[key] === true} onChange={e => patch(key, e.currentTarget.checked)} /></label>
        </div>
    );

    const num = (key: string, label: string, unit?: string) => (
        <div class="ad-form-field"><label class="ad-form-label">{label}</label>
            <div class="ad-input-unit"><input type="number" min="0" class="ad-form-input" value={draft[key] ?? ''} onInput={e => patch(key, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} />{unit && <span class="ad-unit">{unit}</span>}</div>
        </div>
    );

    return <PluginPageShell name={plugin.Name || 'TMDb'} description="Movie database metadata provider" status={plugin.Status} session={session} onSave={save} modified={modified}>
        <div class="ad-page-section ad-grid2">
            <Card title="Content filters">
                {bool('CastList', 'Include adult content')}
                {num('CastAndCrewMaxCount', 'Max cast members', 'people')}
                {bool('ExcludeCastAndCrewMembersWithoutImages', 'Hide members without images')}
            </Card>
            <Card title="Episodes & seasons">
                {bool('CreateMissingEpisodes', 'Create missing episodes')}
                {bool('CreateUnairedEpisodes', 'Create unaired episodes')}
                {bool('IncludeSpecials', 'Include specials')}
                {bool('ImportSeasonName', 'Import season name')}
                {num('MissingEpisodesRetentionDays', 'Retention for missing episodes', 'days')}
                {num('CancelAfter', 'Scheduled re-check interval', 'days')}
            </Card>
            <Card title="Similar items">
                {num('SimilarMovieCacheDurationInDays', 'Cache duration', 'days')}
            </Card>
        </div>
        {message && <p role="status" class="ad-shell-message">{message}</p>}
    </PluginPageShell>;
}