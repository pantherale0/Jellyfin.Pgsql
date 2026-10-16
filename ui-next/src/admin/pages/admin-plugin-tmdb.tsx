import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { Card, InfoRow } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';
import { canSavePluginDraft } from '../admin-state';
import { t } from '../../i18n';

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
        if (cfg === null) { setLoadError(t('The plugin configuration could not be loaded, so it cannot be saved.')); return; }
        setLoadError('');
        setConfig(cfg); setDraft(JSON.parse(JSON.stringify(cfg)));
        setLoadedId(id);
        void api.getVirtualFolders().then(folders => { if (id === plugin.Id) setLibraries(folders); }).catch(() => undefined);
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

    const bool = (key: string, label: string) => (
        <div class="ad-form-field"><label class="ad-form-label">{t(label)}</label>
            <label class="ad-toggle-row"><span>{draft[key] ? t('Enabled') : t('Disabled')}</span><input type="checkbox" checked={draft[key] === true} onChange={e => patch(key, e.currentTarget.checked)} /></label>
        </div>
    );

    const missingEpisodeLibraries: any = Array.isArray(draft.EnabledMissingEpisodeLibraries)
        ? draft.EnabledMissingEpisodeLibraries
        : [];

    const num = (key: string, label: string, unit?: string) => (
        <div class="ad-form-field"><label class="ad-form-label">{t(label)}</label>
            <div class="ad-input-unit"><input type="number" min="0" class="ad-form-input" value={draft[key] ?? ''} onInput={e => patch(key, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} />{unit && <span class="ad-unit">{unit}</span>}</div>
        </div>
    );

    return <PluginPageShell name={plugin.Name || 'TMDb'} description={t('Movie database metadata provider')} status={plugin.Status} session={session} onSave={save} onDiscard={discard} modified={modified} loaded={canSavePluginDraft(loadedId, plugin.Id || '')} loadError={loadError}>
        <div class="ad-page-section ad-grid2">
            <Card title={t('Content filters')}>
                {bool('IncludeAdult', t('Include adult content'))}
                {num('MaxCastMembers', t('Max cast members'), 'people')}
                {num('MaxCrewMembers', t('Max crew members'), 'people')}
                {bool('HideMissingCastMembers', t('Hide cast members without images'))}
                {bool('HideMissingCrewMembers', t('Hide crew members without images'))}
                {bool('ExcludeTagsMovies', t('Exclude tags for movies'))}
                {bool('ExcludeTagsSeries', t('Exclude tags for series'))}
            </Card>
            <Card title={t('Episodes & seasons')}>
                {bool('ImportMissingEpisodes', t('Create missing episodes'))}
                {bool('ImportUnairedEpisodes', t('Create unaired episodes'))}
                {bool('ImportSpecials', t('Include specials'))}
                {bool('ImportSeasonName', t('Import season name'))}
                {num('UpcomingEpisodeGracePeriodDays', t('Retention for missing episodes'), 'days')}
                {num('MissingEpisodeRefreshIntervalDays', t('Scheduled re-check interval'), 'days')}
                <div class="ad-form-field"><label class="ad-form-label">{t('Libraries for missing and unaired episodes')}</label>
                    <select multiple size={Math.min(5, libraries.length || 1)} value={missingEpisodeLibraries} onChange={e => patch('EnabledMissingEpisodeLibraries', Array.from(e.currentTarget.selectedOptions).map(o => o.value))}>
                        {libraries.map(l => l.ItemId && <option key={l.ItemId} value={l.ItemId}>{l.Name || l.ItemId}</option>)}
                    </select>
                </div>
            </Card>
            <Card title={t('API access')}>
                <div class="ad-form-field"><label class="ad-form-label">{t('Custom TMDb API key')}</label>
                    <input type="password" autoComplete="off" class="ad-form-input" value={draft.TmdbApiKey ?? ''} onInput={e => patch('TmdbApiKey', e.currentTarget.value)} />
                    <span class="ad-note">{t('Leave empty to use the built-in key.')}</span>
                </div>
            </Card>
            <Card title={t('Image sizes')}>
                {[['PosterSize', 'Poster'], ['BackdropSize', 'Backdrop'], ['LogoSize', 'Logo'], ['ProfileSize', 'Profile'], ['StillSize', 'Episode still']].map(([key, label]) => (
                    <div class="ad-form-field" key={key}><label class="ad-form-label">{t('{0} size', label)}</label>
                        <input class="ad-form-input" placeholder={t('original')} value={draft[key] ?? ''} onInput={e => patch(key, e.currentTarget.value || null)} />
                    </div>
                ))}
                <p class="ad-note">{t('TMDb size names such as w500 or original. Empty uses the provider default.')}</p>
            </Card>
            <Card title={t('Similar items')}>
                {num('SimilarItemsCacheDays', t('Cache duration'), 'days')}
            </Card>
        </div>
        {message && <p role="status" class="ad-shell-message">{message}</p>}
    </PluginPageShell>;
}