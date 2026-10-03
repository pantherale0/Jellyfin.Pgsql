import type { JellyfinApi } from '../api';
import type {
    PgsqlStatsSnapshot, LibraryTotals, SystemInfo, ServerActivityEntry,
    JellyfinSession, ScheduledTask, JellyfinUserInfo, ForkStatus,
} from './types';

export function createAdminApi(api: JellyfinApi) {
    const get = <T>(path: string, priority = 1): Promise<T> =>
        api.request<T>(path, {}, false, priority);
    const post = (path: string): Promise<void> =>
        api.request<void>(path, { method: 'POST' }, true, 2);
    const del = (path: string): Promise<void> =>
        api.request<void>(path, { method: 'DELETE' }, true, 2);
    const s = api.session;

    const getUsers = (): Promise<JellyfinUserInfo[]> =>
        get<{ Items?: JellyfinUserInfo[] }>('/Users?IsHidden=false').then(r => r.Items || []);

    const getSystemInfo = (): Promise<SystemInfo> => get<SystemInfo>('/System/Info');
    const getPgsqlStats = (): Promise<PgsqlStatsSnapshot> => get<PgsqlStatsSnapshot>('/Pgsql/Stats');

    const getLibraryTotals = (): Promise<LibraryTotals> => {
        const c = (t: string) => get<{ TotalRecordCount?: number }>(`/Items?Recursive=true&IncludeItemTypes=${t}&Limit=0&UserId=${s.user.Id}&Fields=`).then(r => r.TotalRecordCount ?? 0);
        return Promise.all([c('Movie'), c('Episode'), c('Series'), c('BoxSet')])
            .then(([Movies, Episodes, Series, Collections]) => ({ Movies, Episodes, Series, Collections }));
    };

    const getSessions = (): Promise<JellyfinSession[]> => get<JellyfinSession[]>('/Sessions', 2);
    const getScheduledTasks = (): Promise<ScheduledTask[]> => get<ScheduledTask[]>('/ScheduledTasks');

    const getActivityLog = (start = 0, limit = 50): Promise<{ Items: ServerActivityEntry[]; TotalRecordCount?: number }> =>
        get<{ Items: ServerActivityEntry[]; TotalRecordCount?: number }>(`/System/ActivityLog/Entries?StartIndex=${start}&Limit=${limit}`);

    const getForkStatus = async (): Promise<ForkStatus> => {
        const [stats, taste] = await Promise.all([
            getPgsqlStats().catch(() => null),
            api.getTasteProfile().then(p => ({ refreshed: p.UpdatedAt || null, healthy: p.HasProfile === true })).catch(() => ({ refreshed: null, healthy: false })),
        ]);
        const cache = {
            backend: stats?.CacheBackend || '—',
            status: stats?.RedisAvailability === 'Ready' ? 'Ready' : stats?.RedisAvailability || 'Unknown',
            hitRate: stats && (stats.BrowseCacheHits + stats.LatestCacheHits + stats.BrowseCacheMisses + stats.LatestCacheMisses) > 0
                ? (((stats.BrowseCacheHits + stats.LatestCacheHits) / (stats.BrowseCacheHits + stats.LatestCacheMisses + stats.BrowseCacheHits + stats.LatestCacheMisses)) * 100).toFixed(1) + '%'
                : '—',
            ttl: `${stats?.BrowseTtlSeconds || '—'}s`,
        };
        return { cache, taste };
    };

    const scanAllLibraries = (): Promise<void> => post('/Library/Refresh');
    const restartServer = (): Promise<void> => post('/System/Restart');
    const shutdownServer = (): Promise<void> => post('/System/Shutdown');
    const kickSession = (id: string): Promise<void> => del(`/Sessions/${encodeURIComponent(id)}`);

    return {
        getUsers, getSystemInfo, getPgsqlStats, getLibraryTotals,
        getSessions, getScheduledTasks, getActivityLog, getForkStatus,
        scanAllLibraries, restartServer, shutdownServer, kickSession,
    };
}

export type AdminApi = ReturnType<typeof createAdminApi>;