import type { JellyfinApi } from '../api';
import type {
    PgsqlStatsSnapshot, SystemInfo, ServerActivityEntry, JellyfinSession, ScheduledTask,
    JellyfinUserInfo, LibraryInfo, PluginInfo, ForkStatus, DeviceInfo, ApiKey,
    SystemStorage, VirtualFolder, TasteShadowEval,
} from './types';

export function createAdminApi(api: JellyfinApi) {
    const get = <T>(path: string, priority = 1): Promise<T> => api.request<T>(path, {}, false, priority);
    const post = (path: string): Promise<void> => api.request<void>(path, { method: 'POST' }, true, 2);
    const postB = <T>(path: string, body?: unknown): Promise<T> => api.request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, false, 2);
    const putB = <T>(path: string, body: unknown): Promise<T> => api.request<T>(path, { method: 'POST', body: JSON.stringify(body) }, false, 2);
    const del = (path: string): Promise<void> => api.request<void>(path, { method: 'DELETE' }, true, 2);
    const raw = <T>(path: string, priority = 1): Promise<T> => get<T>(path, priority);
    const s = api.session;

    /* Overview / shared */
    const normalizeUser = (user: JellyfinUserInfo): JellyfinUserInfo => ({ ...user, IsAdministrator: user.Policy?.IsAdministrator === true, IsDisabled: user.Policy?.IsDisabled === true });
    const getUsers = (): Promise<JellyfinUserInfo[]> => get<JellyfinUserInfo[]>('/Users').then(users => users.map(normalizeUser));
    const getSystemInfo = (): Promise<SystemInfo> => get<SystemInfo>('/System/Info');
    const getNetworkConfig = (): Promise<Record<string, any>> => get('/System/Configuration/network');
    const saveNetworkConfig = async (patch: Record<string, unknown>): Promise<void> => {
        const current = await getNetworkConfig();
        await api.request<void>('/System/Configuration/network', { method: 'POST', body: JSON.stringify({ ...current, ...patch }) }, true);
    };
    const saveServerName = async (name: string): Promise<void> => {
        const current = await get<Record<string, unknown>>('/System/Configuration');
        await api.request<void>('/System/Configuration', { method: 'POST', body: JSON.stringify({ ...current, ServerName: name }) }, true);
    };
    const getPgsqlStats = (): Promise<PgsqlStatsSnapshot> => get<PgsqlStatsSnapshot>('/Pgsql/Stats');
    const getSessions = (): Promise<JellyfinSession[]> => get<JellyfinSession[]>('/Sessions', 2);
    const getScheduledTasks = (): Promise<ScheduledTask[]> => get<ScheduledTask[]>('/ScheduledTasks');
    const getActivityLog = (start = 0, limit = 50, filters: Record<string, string> = {}): Promise<{ Items: ServerActivityEntry[]; TotalRecordCount?: number }> =>
        get<{ Items: ServerActivityEntry[]; TotalRecordCount?: number }>(`/System/ActivityLog/Entries?${new URLSearchParams({ StartIndex: String(start), Limit: String(limit), SortBy: 'Date', SortOrder: 'Descending', ...filters })}`);
    const getLibraryTotals = async (): Promise<{ Movies: number; Episodes: number; Series: number; Collections: number; TotalItems: number }> => {
        const result = await get<Record<string, number>>(`/Items/Counts?UserId=${encodeURIComponent(s.user.Id)}`);
        const total = ['MovieCount', 'EpisodeCount', 'SeriesCount', 'ArtistCount', 'SongCount', 'AlbumCount', 'MusicVideoCount', 'BoxSetCount', 'BookCount'].reduce((n, key) => n + (result[key] || 0), 0);
        return { Movies: result.MovieCount || 0, Episodes: result.EpisodeCount || 0, Series: result.SeriesCount || 0, Collections: result.BoxSetCount || 0, TotalItems: total };
    };

    const getForkStatus = async (): Promise<ForkStatus> => {
        const [stats, shadow] = await Promise.all([
            getPgsqlStats().catch(() => null),
            get<TasteShadowEval>('/Pgsql/Admin/Taste/ShadowEval').catch(() => null),
        ]);
        const hc = stats ? (stats.BrowseCacheHits + stats.LatestCacheHits + stats.BrowseCacheMisses + stats.LatestCacheMisses) : 0;
        return {
            cache: stats ? {
                backend: stats.CacheBackend,
                status: stats.RedisAvailability === 'Ready' ? 'Ready' : stats.RedisAvailability,
                hitRate: hc > 0 ? (((stats.BrowseCacheHits + stats.LatestCacheHits) / hc) * 100).toFixed(1) + '%' : undefined,
                ttl: stats.BrowseTtlSeconds > 0 ? `${stats.BrowseTtlSeconds}s` : undefined,
            } : undefined,
            taste: shadow ? {
                refreshed: shadow.Latest?.CreatedAt || null,
                healthy: shadow.Status?.NeuralModelLoaded === true || shadow.Status?.TasteEnabled === true,
                precisionAt10: shadow.Latest?.PrecisionAt10,
                engageRate: shadow.Status?.ForYouEngageRate,
                serving: shadow.Status?.NeuralServingEnabled,
            } : undefined,
        };
    };

    /* Infrastructure */
    const getDevices = (): Promise<{ Items?: DeviceInfo[]; TotalRecordCount?: number }> => get<{ Items?: DeviceInfo[]; TotalRecordCount?: number }>(`/Devices?userId=${encodeURIComponent(s.user.Id)}`);
    const getScheduledTask = (id: string): Promise<ScheduledTask> => get<ScheduledTask>(`/ScheduledTasks/${encodeURIComponent(id)}`);
    const startTask = (id: string): Promise<void> => post(`/ScheduledTasks/Running/${encodeURIComponent(id)}`);
    const stopTask = (id: string): Promise<void> => del(`/ScheduledTasks/Running/${encodeURIComponent(id)}`);

    /* Users & access */
    const getUser = (id: string): Promise<JellyfinUserInfo> => get<JellyfinUserInfo>(`/Users/${encodeURIComponent(id)}`).then(normalizeUser);
    const deleteUser = (id: string): Promise<void> => del(`/Users/${encodeURIComponent(id)}`);
    const createUser = (name: string, password: string): Promise<JellyfinUserInfo> => postB<JellyfinUserInfo>('/Users/New', { Name: name, Password: password }).then(normalizeUser);
    const resetUserPassword = (id: string): Promise<void> => api.request<void>(`/Users/Password?userId=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ ResetPassword: true }) }, true, 2);
    const mergeUsers = (sourceUserId: string, targetUserId: string, preview = true): Promise<{ counts: Record<string, number>; warning?: string }> => api.request(`/Pgsql/Admin/Users/Merge${preview ? '/Preview' : ''}`, { method: 'POST', headers: { Accept: 'application/json; profile="CamelCase"' }, body: JSON.stringify({ sourceUserId, targetUserId }) });
    const updateUserPolicy = (id: string, policy: Record<string, unknown>): Promise<void> =>
        api.request<void>(`/Users/${encodeURIComponent(id)}/Policy`, { method: 'POST', body: JSON.stringify(policy) }, true, 2);
    const getApiKeys = (): Promise<ApiKey[]> => get<{ Items?: ApiKey[] }>('/Auth/Keys').then(r => r.Items || []);
    const createApiKey = (appName: string): Promise<void> => post(`/Auth/Keys?app=${encodeURIComponent(appName)}`);
    const getBackups = (): Promise<Array<{ Path: string; ServerVersion: string; DateCreated: string }> | null> => get<Array<{ Path: string; ServerVersion: string; DateCreated: string }>>('/Backup').catch(() => null);
    const createBackup = (): Promise<unknown> => postB('/Backup/Create', { Database: true, Metadata: false, Trickplay: false, Subtitles: false });
    const restoreBackup = (path: string): Promise<void> => api.request<void>('/Backup/Restore', { method: 'POST', body: JSON.stringify({ ArchiveFileName: path }) }, true);

    /* Playback statistics (fork) */
    const getPlaybackOverview = async (): Promise<Record<string, any> | null> =>
        get<Record<string, any>>('/PlaybackStats/Overview').catch(() => null);

    const getDailyPlayback = async (startDate?: string, endDate?: string): Promise<Array<{ Date?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>> => {
        const query = new URLSearchParams({ groupBy: 'MediaType' });
        if (startDate) query.set('startDate', startDate);
        if (endDate) query.set('endDate', endDate);
        return get<Array<{ Date?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>>(`/PlaybackStats/Daily?${query}`).catch(() => []);
    };

    const getPlaybackDimensions = async (dimension: string, startDate?: string, endDate?: string): Promise<Array<{ Key?: string; PlayCount?: number; TotalTicks?: number }>> => {
        const query = new URLSearchParams({ dimension });
        if (startDate) query.set('startDate', startDate);
        if (endDate) query.set('endDate', endDate);
        return get<Array<{ Key?: string; PlayCount?: number; TotalTicks?: number }>>(`/PlaybackStats/Dimensions?${query}`).catch(() => []);
    };

    /* Libraries */
    const getLibraries = (): Promise<LibraryInfo[]> => get<VirtualFolder[]>('/Library/VirtualFolders').then(rows => rows.map(row => ({
        ItemId: row.ItemId,
        Name: row.Name,
        Path: row.Locations?.join(', '),
        CollectionType: row.CollectionType,
        Options: { Path: row.Locations },
        RefreshProgress: row.RefreshProgress,
        RefreshStatus: row.RefreshStatus,
    })));
    const getLibraryCounts = async (parentId: string): Promise<{ Movies: number; Series: number; Episodes: number }> => {
        const count = (type: string) => get<{ TotalRecordCount?: number }>(`/Items?ParentId=${encodeURIComponent(parentId)}&Recursive=true&IncludeItemTypes=${type}&Limit=0&EnableTotalRecordCount=true&UserId=${encodeURIComponent(s.user.Id)}&Fields=`).then(r => r.TotalRecordCount || 0);
        const [Movies, Series, Episodes] = await Promise.all([count('Movie'), count('Series'), count('Episode')]);
        return { Movies, Series, Episodes };
    };
    const getVirtualFolders = (): Promise<VirtualFolder[]> => get<VirtualFolder[]>('/Library/VirtualFolders');
    const getSystemStorage = (): Promise<SystemStorage> => get<SystemStorage>('/System/Info/Storage');
    const getMediaEncoderCapabilities = async (): Promise<Record<string, any> | null> => raw<Record<string, any>>('/System/MediaEncoder/Capabilities').catch(() => null);
    const refreshLibrary = (itemId: string): Promise<void> => post(`/Items/${encodeURIComponent(itemId)}/Refresh`);
    const addLibrary = (name: string, collectionType: string, paths: string[]): Promise<void> => api.request<void>(`/Library/VirtualFolders?${new URLSearchParams({ name, ...(collectionType ? { collectionType } : {}), paths: paths.join(','), refreshLibrary: 'false' })}`, { method: 'POST', body: JSON.stringify({ LibraryOptions: { PathInfos: paths.map(Path => ({ Path })) } }) }, true);
    const removeLibrary = (name: string): Promise<void> => del(`/Library/VirtualFolders?${new URLSearchParams({ name, refreshLibrary: 'false' })}`);

    /* Plugins */
    const getPlugins = (): Promise<PluginInfo[]> => get<PluginInfo[]>('/Plugins').catch(() => []);
    const enablePlugin = (pluginId: string, version: string): Promise<void> => post(`/Plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/Enable`);
    const disablePlugin = (pluginId: string, version: string): Promise<void> => post(`/Plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/Disable`);

    /* Logs */
    const getLogs = async (): Promise<Array<{ Name?: string; Size?: number; DateModified?: string }>> => get<Array<{ Name?: string; Size?: number; DateModified?: string }>>('/System/Logs').catch(() => []);
    const getLogText = (name: string): Promise<string> => api.requestText(`/System/Logs/Log?name=${encodeURIComponent(name)}`);

    /* Seerr */
    const getSeerrStatus = async (): Promise<{ Enabled: boolean } | null> => get<{ Enabled: boolean }>('/Seerr/Status').catch(() => null);
    const getTasteShadowEval = async (): Promise<TasteShadowEval | null> => get<TasteShadowEval>('/Pgsql/Admin/Taste/ShadowEval').catch(() => null);
    const getSsoConfig = async (): Promise<unknown | null> => raw<unknown>('/SSO/rbac/config').catch(() => null);
    const getSsoStatus = (): Promise<{ enabled: boolean } | null> => get<{ enabled: boolean }>('/SSO/config').catch(() => null);
    const saveSsoConfig = (config: unknown): Promise<void> => api.request<void>('/SSO/rbac/config', { method: 'POST', body: JSON.stringify(config) }, true, 2);
    const getTunerHostTypes = async (): Promise<Array<{ Name?: string; Id?: string }>> => raw<Array<{ Name?: string; Id?: string }>>('/LiveTv/TunerHosts/Types').catch(() => []);
    const getLiveTvInfo = async (): Promise<Record<string, unknown> | null> => raw<Record<string, unknown>>('/LiveTv/Info').catch(() => null);
    const getLiveTvChannels = async (): Promise<{ Items?: Array<{ Id?: string; Name?: string; Number?: string; Type?: string }> }> => raw<{ Items?: Array<{ Id?: string; Name?: string; Number?: string; Type?: string }> }>('/LiveTv/Channels?Limit=100').catch(() => ({}));
    const cancelTimer = (id: string): Promise<void> => del(`/LiveTv/Timers/${encodeURIComponent(id)}`);

    /* System actions */
    const scanAllLibraries = (): Promise<void> => post('/Library/Refresh');
    const restartServer = (): Promise<void> => post('/System/Restart');
    const shutdownServer = (): Promise<void> => post('/System/Shutdown');
    const stopPlayback = (id: string): Promise<void> => post(`/Sessions/${encodeURIComponent(id)}/Playing/Stop`);
    const revokeKey = (key: string): Promise<void> => del(`/Auth/Keys/${encodeURIComponent(key)}`);
    const sendSystemCommand = (sessionId: string, command: string): Promise<void> =>
        post(`/Sessions/${encodeURIComponent(sessionId)}/System/${encodeURIComponent(command)}`);
    const deleteDevice = (id: string): Promise<void> => del(`/Devices?id=${encodeURIComponent(id)}`);
    const initEmbyUpload = (libraryDbBytes: number, usersDbBytes: number): Promise<{ sessionId: string; chunkSizeBytes: number }> =>
        postB<{ sessionId: string; chunkSizeBytes: number }>('/Pgsql/Admin/EmbyImport/Upload/Init', { libraryDbBytes, usersDbBytes });
    const uploadEmbyChunks = async (sessionId: string, fileName: 'libraryDb' | 'usersDb', file: File, chunkSize: number, progress?: (value: number) => void, signal?: AbortSignal): Promise<void> => {
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 64 * 1024 * 1024) throw new Error('The server returned an invalid upload chunk size.');
        const count = Math.ceil(file.size / chunkSize);
        for (let index = 0; index < count; index += 1) {
            const form = new FormData();
            form.append('sessionId', sessionId);
            form.append('file', fileName);
            form.append('chunkIndex', String(index));
            form.append('chunk', file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize)), file.name);
            await api.request<void>('/Pgsql/Admin/EmbyImport/Upload/Chunk', { method: 'PUT', body: form, signal }, true, 2);
            progress?.(Math.round(((index + 1) / count) * 100));
        }
    };
    const completeEmbyUpload = (sessionId: string): Promise<{ sessionId: string; users: Array<{ id: number; name: string; userDataCount: number }> }> =>
        postB('/Pgsql/Admin/EmbyImport/Upload/Complete', { sessionId });
    const previewEmbyImport = (sessionId: string, embyUserIds: number[], targetUserId: string): Promise<any> =>
        postB('/Pgsql/Admin/EmbyImport/Preview', { sessionId, embyUserIds, targetUserId });
    const executeEmbyImport = (sessionId: string, embyUserIds: number[], targetUserId: string): Promise<any> =>
        postB('/Pgsql/Admin/EmbyImport/Execute', { sessionId, embyUserIds, targetUserId });
    const discardEmbyImport = (sessionId: string): Promise<void> => del(`/Pgsql/Admin/EmbyImport/${encodeURIComponent(sessionId)}`);

    return {
        getUsers, getSystemInfo, getNetworkConfig, saveNetworkConfig, saveServerName, getPgsqlStats, getSessions, getScheduledTasks, getActivityLog,
        getLibraryTotals, getForkStatus, getDevices, getScheduledTask, startTask, stopTask,
        getUser, createUser, resetUserPassword, mergeUsers, deleteUser, updateUserPolicy, getApiKeys, createApiKey, getBackups, createBackup, restoreBackup, getPlaybackOverview, getLibraries, getLibraryCounts, getVirtualFolders,
        getSystemStorage, getMediaEncoderCapabilities, refreshLibrary, addLibrary, removeLibrary, getDailyPlayback, getPlaybackDimensions, getPlugins, enablePlugin, disablePlugin, getLogs, getLogText, getSeerrStatus,
        getTasteShadowEval, getSsoConfig, getSsoStatus, saveSsoConfig, getTunerHostTypes, getLiveTvInfo, getLiveTvChannels, cancelTimer,
        scanAllLibraries, restartServer, shutdownServer, stopPlayback, revokeKey, sendSystemCommand, deleteDevice, raw, putB,
        initEmbyUpload, uploadEmbyChunks, completeEmbyUpload, previewEmbyImport, executeEmbyImport, discardEmbyImport,
    };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
