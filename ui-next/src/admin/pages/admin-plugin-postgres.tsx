import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { Card, InfoRow, StatusChip, Empty } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';
import { canSavePluginDraft, pgsqlEnvironmentOverrides, tasteRuntimeOverrides } from '../admin-state';
import { t } from '../../i18n';

export function AdminPluginPostgres({ adminApi: api, plugin, session }: {
    adminApi: AdminApi; plugin: PluginInfo; session: { server: string };
}) {
    const [stats, setStats] = useState<any>(null);
    const [config, setConfig] = useState<Record<string, any>>({});
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [modified, setModified] = useState(false);
    const [message, setMessage] = useState('');
    const [loadedId, setLoadedId] = useState('');
    const [loadError, setLoadError] = useState('');
    const [tasteStatus, setTasteStatus] = useState<Record<string, unknown> | null>(null);

    const load = useCallback(async () => {
        const id = plugin.Id || '';
        const [st, cfg, taste] = await Promise.all([
            api.getPgsqlStats().catch(() => null),
            id ? api.raw<Record<string, any>>(`/Plugins/${id}/Configuration`).catch(() => null) : null,
            api.getTasteShadowEval().catch(() => null),
        ]);
        if (id !== plugin.Id) return;
        setStats(st);
        setTasteStatus((taste?.Status as Record<string, unknown> | undefined) || null);
        if (cfg === null) { setLoadError(t('The plugin configuration could not be loaded, so it cannot be saved.')); return; }
        setLoadError('');
        setConfig(cfg);
        setDraft(JSON.parse(JSON.stringify(cfg)));
        setLoadedId(id);
        setModified(false);
    }, [api, plugin.Id]);

    useEffect(() => { load(); }, [load]);

    const patch = (key: string, value: any) => { setDraft(o => ({ ...o, [key]: value })); setModified(true); };
    const save = async () => {
        if (!plugin.Id) return;
        if (!canSavePluginDraft(loadedId, plugin.Id)) throw new Error(t('Configuration is still loading. Wait for it to load before saving.'));
        await api.putB(`/Plugins/${plugin.Id}/Configuration`, draft, true);
        setConfig(draft);
        setModified(false);
        setMessage(t('Settings saved.'));
    };

    const discard = () => { setDraft(JSON.parse(JSON.stringify(config))); setModified(false); };
    const overrides = pgsqlEnvironmentOverrides(config, stats);
    const tasteOverrides = tasteRuntimeOverrides(config, tasteStatus);
    const overrideNote = (key: string) => tasteOverrides[key]
        ? <span class="ad-note">{t('Effective at runtime:')}{' '}{tasteOverrides[key].effective ? t('Enabled') : t('Disabled')}{' '}{t('(an environment variable or a pending restart differs from the saved value)')}</span>
        : overrides[key] ? <span class="ad-note">{t('Overridden by {0} (effective: {1})', overrides[key].envVar, String(overrides[key].effective))}</span> : null;
    const hitRate = stats ? (((stats.BrowseCacheHits + stats.LatestCacheHits) / Math.max(1, stats.BrowseCacheHits + stats.LatestCacheHits + stats.BrowseCacheMisses + stats.LatestCacheMisses)) * 100).toFixed(1) : null;

    return <PluginPageShell name={plugin.Name || 'PostgreSQL Database'} description={t('Database provider and query cache')} status={plugin.Status} session={session} onSave={save} onDiscard={discard} modified={modified} loaded={canSavePluginDraft(loadedId, plugin.Id || '')} loadError={loadError}>
        <div class="ad-page-section">
            <Card title={t('Connection')}>
                <InfoRow k={t('Plugin status')} v={<StatusChip tone="green">{t('PostgreSQL active')}</StatusChip>} />
                {stats && <><InfoRow k={t('Cache backend')} v={stats.CacheBackend} /><InfoRow k={t('Cache active')} v={stats.CacheActive ? t('Yes') : t('No')} /><InfoRow k={t('Redis')} v={<StatusChip tone={stats.RedisAvailability === 'Ready' ? 'green' : 'amber'}>{stats.RedisAvailability}</StatusChip>} />{hitRate && <InfoRow k={t('Cache hit rate')} v={`${hitRate}%`} />}</>}
                {!stats && <Empty muted>{t('Runtime telemetry unavailable — check Infrastructure page.')}</Empty>}
            </Card>

            <Card title={t('Query cache backend')}>
                <div class="ad-form-grid">
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Query result cache')}</label>
                        <label class="ad-toggle-row"><span>{draft.EnableQueryCache === false ? t('Disabled') : t('Enabled')}</span><input type="checkbox" checked={draft.EnableQueryCache !== false} onChange={e => patch('EnableQueryCache', e.currentTarget.checked)} /></label>
                    </div>
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Backend')}</label>
                        <select class="ad-form-input" value={draft.CacheBackend ?? 'Redis'} onChange={e => patch('CacheBackend', e.currentTarget.value)}>{['Redis', 'Memory', 'Off'].map(v => <option key={v} value={v}>{t(v)}</option>)}</select>
                        {overrideNote('CacheBackend')}
                    </div>
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Redis connection string')}</label>
                        <input type="password" class="ad-form-input" value={draft.RedisConnectionString ?? ''} onInput={e => patch('RedisConnectionString', e.currentTarget.value)} />
                    </div>
                </div>
                <p class="ad-note">{t('Environment variables (Pgsql_CACHE_ENABLED, Pgsql_CACHE_BACKEND, REDIS_CONNECTION_STRING) take precedence over these saved values at runtime.')}</p>
            </Card>

            <Card title={t('Query cache TTLs')}>
                <div class="ad-form-grid">
                    {[['LatestCacheTtlSeconds', 'Latest'], ['ResumeCacheTtlSeconds', 'Resume'], ['NextUpCacheTtlSeconds', 'Next Up'], ['BrowseCacheTtlSeconds', 'Browse']].map(([key, label]) => (
                        <div class="ad-form-field" key={key}>
                            <label class="ad-form-label">{t('{0} TTL', label)}</label>
                            <div class="ad-input-unit"><input type="number" min="0" class="ad-form-input" value={draft[key] ?? ''} onInput={e => patch(key, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} /><span class="ad-unit">{t('seconds')}</span></div>
                            {overrideNote(key)}
                        </div>
                    ))}
                </div>
            </Card>

            <Card title={t('Query optimisations')}>
                <div class="ad-form-grid">
                    {[['OptimizeLatestQueries', 'Optimised Latest queries'], ['OptimizeNextUpQueries', 'Optimised Next Up queries']].map(([key, label]) => (
                        <div class="ad-form-field" key={key}>
                            <label class="ad-form-label">{t(label)}</label>
                            <label class="ad-toggle-row"><span>{draft[key] ? t('Enabled') : t('Disabled')}</span><input type="checkbox" checked={draft[key] === true} onChange={e => patch(key, e.currentTarget.checked)} /></label>
                            {overrideNote(key)}
                        </div>
                    ))}
                </div>
                <p class="ad-note">{t('Per-media Latest overrides are environment variables only (Pgsql_PG_OPTIMIZE_MOVIES_LATEST and similar).')}</p>
            </Card>

            <Card title={t('Taste profiles')}>
                <div class="ad-form-grid">
                    {[['EnableTasteProfiles', 'Taste profiles'], ['EnableNeuralShadowTraining', 'Neural shadow training'], ['UseNeuralForServing', 'Serve neural recommendations']].map(([key, label]) => (
                        <div class="ad-form-field" key={key}>
                            <label class="ad-form-label">{t(label)}</label>
                            <label class="ad-toggle-row"><span>{draft[key] ? t('Enabled') : t('Disabled')}</span><input type="checkbox" checked={draft[key] === true} onChange={e => patch(key, e.currentTarget.checked)} /></label>
                            {overrideNote(key)}
                        </div>
                    ))}
                    {[['TasteLookbackDays', 'Lookback', 'days'], ['TasteMinSamples', 'Minimum samples', 'plays'], ['MaxTasteBonus', 'Maximum taste bonus', 'points']].map(([key, label, unit]) => (
                        <div class="ad-form-field" key={key}>
                            <label class="ad-form-label">{t(label)}</label>
                            <div class="ad-input-unit"><input type="number" min="0" class="ad-form-input" value={draft[key] ?? ''} onInput={e => patch(key, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} /><span class="ad-unit">{unit}</span></div>
                        </div>
                    ))}
                </div>
            </Card>

            <Card title={t('Trailers')}>
                <div class="ad-form-field">
                    <label class="ad-form-label">{t('yt-dlp executable')}</label>
                    <input class="ad-form-input" value={draft.YtDlpPath ?? ''} onInput={e => patch('YtDlpPath', e.currentTarget.value)} />
                </div>
            </Card>

            {stats && <Card title={t('Performance')}>
                <div class="ad-form-grid">
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Optimised Latest runs')}</label>
                        <span class="ad-form-value">{t('{0} · {1} failures', stats.OptimizedLatestRuns, stats.OptimizedLatestFailures)}</span>
                    </div>
                    <div class="ad-form-field">
                        <label class="ad-form-label">{t('Optimised NextUp runs')}</label>
                        <span class="ad-form-value">{t('{0} · {1} failures', stats.OptimizedNextUpRuns, stats.OptimizedNextUpFailures)}</span>
                    </div>
                </div>
            </Card>}
        </div>
        {message && <p role="status" class="ad-shell-message">{message}</p>}
    </PluginPageShell>;
}