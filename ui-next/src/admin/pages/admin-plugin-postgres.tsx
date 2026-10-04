import { useCallback, useEffect, useState } from 'preact/hooks';
import { PluginPageShell } from '../plugin-shell';
import { Card, InfoRow, StatusChip, Empty } from '../ui';
import type { AdminApi } from '../admin-api';
import type { PluginInfo } from '../types';

export function AdminPluginPostgres({ adminApi: api, plugin, session }: {
    adminApi: AdminApi; plugin: PluginInfo; session: { server: string };
}) {
    const [stats, setStats] = useState<any>(null);
    const [config, setConfig] = useState<Record<string, any>>({});
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [modified, setModified] = useState(false);
    const [message, setMessage] = useState('');

    const load = useCallback(async () => {
        const [st, cfg] = await Promise.all([
            api.getPgsqlStats().catch(() => null),
            plugin.Id ? api.raw<Record<string, any>>(`/Plugins/${plugin.Id}/Configuration`).catch(() => ({})) : {},
        ]);
        setStats(st);
        setConfig(cfg);
        setDraft(JSON.parse(JSON.stringify(cfg)));
        setModified(false);
    }, [api, plugin.Id]);

    useEffect(() => { load(); }, [load]);

    const patch = (key: string, value: any) => { setDraft(o => ({ ...o, [key]: value })); setModified(true); };
    const save = async () => {
        if (!plugin.Id) return;
        await api.putB(`/Plugins/${plugin.Id}/Configuration`, draft);
        setModified(false);
        setMessage('Settings saved.');
    };

    const hitRate = stats ? (((stats.BrowseCacheHits + stats.LatestCacheHits) / Math.max(1, stats.BrowseCacheHits + stats.LatestCacheHits + stats.BrowseCacheMisses + stats.LatestCacheMisses)) * 100).toFixed(1) : null;

    return <PluginPageShell name={plugin.Name || 'PostgreSQL Database'} description="Database provider and query cache" status={plugin.Status} session={session} onSave={save} modified={modified}>
        <div class="ad-page-section">
            <Card title="Connection">
                <InfoRow k="Plugin status" v={<StatusChip tone="green">PostgreSQL active</StatusChip>} />
                {stats && <><InfoRow k="Cache backend" v={stats.CacheBackend} /><InfoRow k="Cache active" v={stats.CacheActive ? 'Yes' : 'No'} /><InfoRow k="Redis" v={<StatusChip tone={stats.RedisAvailability === 'Ready' ? 'green' : 'amber'}>{stats.RedisAvailability}</StatusChip>} />{hitRate && <InfoRow k="Cache hit rate" v={`${hitRate}%`} />}</>}
                {!stats && <Empty muted>Runtime telemetry unavailable — check Infrastructure page.</Empty>}
            </Card>

            <Card title="Query cache TTLs">
                <div class="ad-form-grid">
                    {['LatestTtlSeconds', 'ResumeTtlSeconds', 'BrowseTtlSeconds', 'NextUpTtlSeconds'].map(key => (
                        <div class="ad-form-field" key={key}>
                            <label class="ad-form-label">{key.replace('Seconds', '').replace('Ttl', ' TTL')}</label>
                            <div class="ad-input-unit"><input type="number" min="0" class="ad-form-input" value={draft[key] ?? ''} onInput={e => patch(key, e.currentTarget.value === '' ? '' : Number(e.currentTarget.value))} /><span class="ad-unit">seconds</span></div>
                        </div>
                    ))}
                </div>
            </Card>

            <Card title="Query optimisations">
                <div class="ad-form-grid">
                    {['OptimizeMoviesLatest', 'OptimizeTvLatest', 'OptimizeMusicLatest', 'OptimizeNextUp'].map(key => (
                        <div class="ad-form-field" key={key}>
                            <label class="ad-form-label">{key.replace('Optimize', '').replace('Latest', ' Latest').replace(/([A-Z])/g, ' $1').trim()}</label>
                            <label class="ad-toggle-row"><span>{draft[key] ? 'Enabled' : 'Disabled'}</span><input type="checkbox" checked={draft[key] === true} onChange={e => patch(key, e.currentTarget.checked)} /></label>
                        </div>
                    ))}
                </div>
            </Card>

            {stats && <Card title="Performance">
                <div class="ad-form-grid">
                    <div class="ad-form-field">
                        <label class="ad-form-label">Optimised Latest runs</label>
                        <span class="ad-form-value">{stats.OptimizedLatestRuns} · {stats.OptimizedLatestFailures} failures</span>
                    </div>
                    <div class="ad-form-field">
                        <label class="ad-form-label">Optimised NextUp runs</label>
                        <span class="ad-form-value">{stats.OptimizedNextUpRuns} · {stats.OptimizedNextUpFailures} failures</span>
                    </div>
                </div>
            </Card>}
        </div>
        {message && <p role="status" class="ad-shell-message">{message}</p>}
    </PluginPageShell>;
}