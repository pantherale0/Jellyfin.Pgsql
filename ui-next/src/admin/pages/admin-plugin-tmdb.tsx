import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { Card, InfoRow } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';
import { canSavePluginDraft } from '../admin-state';

export function AdminPluginTmdb({ adminApi: api, plugin, session }: {
    adminApi: AdminApi; plugin: PluginInfo; session: { server: string };
}) {
    const [config, setConfig] = useState<Record<string, any>>({});
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [modified, setModified] = useState(false);
    const [message, setMessage] = useState('');
    const [loadedId, setLoadedId] = useState('');
    const [loadError, setLoadError] = useState('');
    const [libraries, setLibraries] = useState<Array<{ ItemId?: string; Name?: string }>>([]);

    const load = useCallback(async () => {
        if (!plugin.Id) return;
        const id = plugin.Id;
        const cfg = await api.raw<Record<string, any>>(`/Plugins/${id}/Configuration`).catch(() => null);
        if (id !== plugin.Id) return;
        if (cfg === null) { setLoadError('The plugin configuration could not be loaded, so it cannot be saved.'); return; }
        setLoadError('');
        setConfig(cfg); setDraft(JSON.parse(JSON.stringify(cfg)));
        setLoadedId(id);
        void api.getVirtualFolders().then(folders => { if (id === plugin.Id) setLibraries(folders); }).catch(() => undefined);
    }, [api, plugin.Id]);

    useEffect(() => { load(); }, [load]);

    const patch = (key: string, value: any) => { setDraft(o => ({ ...o, [key]: value })); setModified(true); };
    const save = async () => {
        if (!plugin.Id) return;
        if (!canSavePluginDraft(loadedId, plugin.Id)) throw new Error('Configuration is still loading. Wait for it to load before saving.');
        await api.putB(`/Plugins/${plugin.Id}/Configuration`, draft, true);
        setConfig(draft); setModified(false); setMessage('Saved.');
    };
    const discard = () => { setDraft(JSON.parse(JSON.stringify(config))); setModified(false); };

    const bool = (key: string, label: string) => (
        <div class="ad-form-field"><label class="ad-form-label">{label}</label>
            <label class="ad-toggle-row"><span>{draft[key] ? 'Enabled' : 'Disabled'}</span><input type="checkbox" checked={draft[key] === true} onChange={e => patch(key, e.currentTarget.checked)} /></label>
        </div>
    );

    const missingEpisodeLibraries: any = Array.isArray(draft.EnabledMissingEpisodeLibraries)
        ? draft.EnabledMissingEpisodeLibraries
        : [];

    const num = (key: string, label: string, unit?: string) => (
        <div class="ad-form-field"><label class="ad-form-label">{label}</label>
            <div class="ad-input-unit"><input type="number" min="0" class="ad-form-input" value={draft[key] ?? ''} onInput={e => patch(key, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} />{unit && <span class="ad-unit">{unit}</span>}</div>
        </div>
    );

    return <PluginPageShell name={plugin.Name || 'TMDb'} description="Movie database metadata provider" status={plugin.Status} session={session} onSave={save} onDiscard={discard} modified={modified} loaded={canSavePluginDraft(loadedId, plugin.Id || '')} loadError={loadError}>
        <div class="ad-page-section ad-grid2">
            <Card title="Content filters">
                {bool('IncludeAdult', 'Include adult content')}
                {num('MaxCastMembers', 'Max cast members', 'people')}
                {num('MaxCrewMembers', 'Max crew members', 'people')}
                {bool('HideMissingCastMembers', 'Hide cast members without images')}
                {bool('HideMissingCrewMembers', 'Hide crew members without images')}
                {bool('ExcludeTagsMovies', 'Exclude tags for movies')}
                {bool('ExcludeTagsSeries', 'Exclude tags for series')}
            </Card>
            <Card title="Episodes & seasons">
                {bool('ImportMissingEpisodes', 'Create missing episodes')}
                {bool('ImportUnairedEpisodes', 'Create unaired episodes')}
                {bool('ImportSpecials', 'Include specials')}
                {bool('ImportSeasonName', 'Import season name')}
                {num('UpcomingEpisodeGracePeriodDays', 'Retention for missing episodes', 'days')}
                {num('MissingEpisodeRefreshIntervalDays', 'Scheduled re-check interval', 'days')}
                <div class="ad-form-field"><label class="ad-form-label">Libraries for missing and unaired episodes</label>
                    <select multiple size={Math.min(5, libraries.length || 1)} value={missingEpisodeLibraries} onChange={e => patch('EnabledMissingEpisodeLibraries', Array.from(e.currentTarget.selectedOptions).map(o => o.value))}>
                        {libraries.map(l => l.ItemId && <option key={l.ItemId} value={l.ItemId}>{l.Name || l.ItemId}</option>)}
                    </select>
                </div>
            </Card>
            <Card title="API access">
                <div class="ad-form-field"><label class="ad-form-label">Custom TMDb API key</label>
                    <input type="password" autoComplete="off" class="ad-form-input" value={draft.TmdbApiKey ?? ''} onInput={e => patch('TmdbApiKey', e.currentTarget.value)} />
                    <span class="ad-note">Leave empty to use the built-in key.</span>
                </div>
            </Card>
            <Card title="Image sizes">
                {[['PosterSize', 'Poster'], ['BackdropSize', 'Backdrop'], ['LogoSize', 'Logo'], ['ProfileSize', 'Profile'], ['StillSize', 'Episode still']].map(([key, label]) => (
                    <div class="ad-form-field" key={key}><label class="ad-form-label">{label} size</label>
                        <input class="ad-form-input" placeholder="original" value={draft[key] ?? ''} onInput={e => patch(key, e.currentTarget.value || null)} />
                    </div>
                ))}
                <p class="ad-note">TMDb size names such as w500 or original. Empty uses the provider default.</p>
            </Card>
            <Card title="Similar items">
                {num('SimilarItemsCacheDays', 'Cache duration', 'days')}
            </Card>
        </div>
        {message && <p role="status" class="ad-shell-message">{message}</p>}
    </PluginPageShell>;
}