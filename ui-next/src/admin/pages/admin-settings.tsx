import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';

interface SettingsProps { api: AdminApi }

export function AdminSettings({ api }: SettingsProps) {
    const [stats, setStats] = useState<{
        CacheActive: boolean; CacheBackend: string; LatestTtlSeconds: number; ResumeTtlSeconds: number; NextUpTtlSeconds: number; BrowseTtlSeconds: number;
        OptimizeMoviesLatest: boolean; OptimizeTvLatest: boolean; OptimizeMusicLatest: boolean; OptimizeNextUp: boolean;
        LatestCacheHits: number; LatestCacheMisses: number; BrowseCacheHits: number; BrowseCacheMisses: number;
        RedisAvailability: string; RedisConnected: boolean; RedisGetErrors: number; RedisSetErrors: number;
        OptimizedLatestRuns: number; OptimizedLatestFailures: number; OptimizedNextUpRuns: number; OptimizedNextUpFailures: number;
    } | null>(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        try { const data = await api.getPgsqlStats(); setStats(data); setError(''); }
        catch { setError('Could not load plugin stats.'); }
    }, [api]);

    useEffect(() => { load(); }, [load]);

    return <div class="admin-page">
        <header class="admin-page-header"><h1>Infrastructure</h1></header>
        {error && <div class="home-section-error" role="alert"><p>{error}</p><button class="button secondary" onClick={load}>Retry</button></div>}

        {stats && <><section class="admin-section">
            <h2>Cache</h2>
            <div class="admin-settings-grid">
                <div class="admin-setting-row"><label>Backend</label><span>{stats.CacheBackend}</span></div>
                <div class="admin-setting-row"><label>Active</label><span>{stats.CacheActive ? 'Yes' : 'No'}</span></div>
                <div class="admin-setting-row"><label>Latest TTL</label><span>{stats.LatestTtlSeconds}s</span></div>
                <div class="admin-setting-row"><label>Resume TTL</label><span>{stats.ResumeTtlSeconds}s</span></div>
                <div class="admin-setting-row"><label>NextUp TTL</label><span>{stats.NextUpTtlSeconds}s</span></div>
                <div class="admin-setting-row"><label>Browse TTL</label><span>{stats.BrowseTtlSeconds}s</span></div>
            </div>
        </section><section class="admin-section">
            <h2>PostgreSQL optimised queries</h2>
            <div class="admin-settings-grid">
                <div class="admin-setting-row"><label>Movies latest</label><span>{stats.OptimizeMoviesLatest ? 'Enabled' : 'Disabled'}</span></div>
                <div class="admin-setting-row"><label>TV latest</label><span>{stats.OptimizeTvLatest ? 'Enabled' : 'Disabled'}</span></div>
                <div class="admin-setting-row"><label>Music latest</label><span>{stats.OptimizeMusicLatest ? 'Enabled' : 'Disabled'}</span></div>
                <div class="admin-setting-row"><label>NextUp batch</label><span>{stats.OptimizeNextUp ? 'Enabled' : 'Disabled'}</span></div>
            </div>
        </section><section class="admin-section">
            <h2>Redis</h2>
            <div class="admin-settings-grid">
                <div class="admin-setting-row"><label>Availability</label><span>{stats.RedisAvailability}</span></div>
                <div class="admin-setting-row"><label>Connected</label><span>{stats.RedisConnected ? 'Yes' : 'No'}</span></div>
                <div class="admin-setting-row"><label>Get errors</label><span>{stats.RedisGetErrors}</span></div>
                <div class="admin-setting-row"><label>Set errors</label><span>{stats.RedisSetErrors}</span></div>
            </div>
        </section><section class="admin-section">
            <h2>Cache hit rates</h2>
            <div class="admin-settings-grid">
                <div class="admin-setting-row"><label>Latest</label><span>{rate(stats.LatestCacheHits, stats.LatestCacheMisses)}</span></div>
                <div class="admin-setting-row"><label>Browse</label><span>{rate(stats.BrowseCacheHits, stats.BrowseCacheMisses)}</span></div>
            </div>
        </section><section class="admin-section">
            <h2>Optimised queries</h2>
            <div class="admin-settings-grid">
                <div class="admin-setting-row"><label>Latest runs</label><span>{stats.OptimizedLatestRuns}</span></div>
                <div class="admin-setting-row"><label>Latest failures</label><span>{stats.OptimizedLatestFailures}</span></div>
                <div class="admin-setting-row"><label>NextUp runs</label><span>{stats.OptimizedNextUpRuns}</span></div>
                <div class="admin-setting-row"><label>NextUp failures</label><span>{stats.OptimizedNextUpFailures}</span></div>
            </div>
        </section></>}
        {!stats && !error && <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />Loading infrastructure…</div>}
    </div>;
}

function rate(hits: number, misses: number): string { const total = hits + misses; if (!total) return '—'; return `${(hits / total * 100).toFixed(1)}% (${hits}/${total})`; }