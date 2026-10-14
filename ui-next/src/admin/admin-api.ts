import type { JellyfinApi } from '../api';
import type {
    PgsqlStatsSnapshot, SystemInfo, ServerActivityEntry, JellyfinSession, ScheduledTask,
    JellyfinUserInfo, LibraryInfo, PluginInfo, ForkStatus, DeviceInfo, ApiKey,
    SystemStorage, VirtualFolder, TasteShadowEval,
    LiveTvConfiguration, TunerHostInfo, ListingsProviderInfo, ChannelMappingOptions, TunerChannelMapping,
} from './types';
import type { AvailableLibraryOptions, LibraryOptions } from './library-options';
import { applyPatch, type TaskTrigger } from './server-settings';

const CAMEL_CASE = { Accept: 'application/json; profile="CamelCase"' };

export interface PlaybackStatsFilter { startDate?: string; endDate?: string }
export interface RecentPlayback { Id?: string; UserId?: string; ItemId?: string; ItemName?: string; SeriesName?: string; MediaType?: string; PlayedTicks?: number; DatePlayed?: string; PlaybackMethod?: string; TranscodeReasons?: string; ClientName?: string; DeviceName?: string }
export interface BackupManifest { ServerVersion?: string; BackupEngineVersion?: string; DateCreated?: string; Path?: string; Options?: Record<string, boolean> }

export function createAdminApi(api: JellyfinApi) {
    const get = <T>(path: string, priority = 1): Promise<T> => api.request<T>(path, {}, false, priority);
    const post = (path: string): Promise<void> => api.request<void>(path, { method: 'POST' }, true, 2);
    const postB = <T>(path: string, body?: unknown): Promise<T> => api.request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, false, 2);
    const putB = <T>(path: string, body: unknown, emptyOk = false): Promise<T> => api.request<T>(path, { method: 'POST', body: JSON.stringify(body) }, emptyOk, 2);
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
        get<{ Items: ServerActivityEntry[]; TotalRecordCount?: number }>(`/System/ActivityLog/Entries?${new URLSearchParams({ StartIndex: String(start), Limit: String(limit), SortBy: 'DateCreated', SortOrder: 'Descending', ...filters })}`);
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
                precisionAt10: shadow.Latest?.PrecisionAt10 ?? undefined,
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
    const updateTaskTriggers = (id: string, triggers: TaskTrigger[]): Promise<void> =>
        api.request<void>(`/ScheduledTasks/${encodeURIComponent(id)}/Triggers`, { method: 'POST', body: JSON.stringify(triggers) }, true, 2);
    const getDeviceOptions = (id: string): Promise<{ customName?: string; playbackOptions?: Record<string, unknown> }> =>
        api.request(`/Devices/Options?${new URLSearchParams({ id })}`, { headers: CAMEL_CASE }, false, 2);
    const saveDeviceName = (id: string, customName: string): Promise<void> =>
        api.request<void>(`/Devices/Options?${new URLSearchParams({ id })}`, { method: 'POST', body: JSON.stringify({ CustomName: customName || null }) }, true, 2);
    const saveDevicePlaybackOptions = (id: string, options: Record<string, unknown>): Promise<void> =>
        api.request<void>(`/Devices/Options/Playback?${new URLSearchParams({ id })}`, { method: 'PUT', headers: CAMEL_CASE, body: JSON.stringify(options) }, true, 2);
    const getAuthProviders = (): Promise<{ auth: Array<[string, string]>; reset: Array<[string, string]> }> => {
        const pairs = (path: string) => get<Array<{ Id?: string; Name?: string }>>(path).then(list => list.filter(p => p.Id).map(p => [ p.Id as string, p.Name || (p.Id as string) ] as [string, string])).catch(() => []);
        return Promise.all([ pairs('/Auth/Providers'), pairs('/Auth/PasswordResetProviders') ]).then(([ auth, reset ]) => ({ auth, reset }));
    };
    const getContentChannels = (): Promise<Array<{ Id: string; Name?: string }>> => get<{ Items?: Array<{ Id: string; Name?: string }> }>(`/Channels?${new URLSearchParams({ userId: s.user.Id })}`).then(r => r.Items || []).catch(() => []);

    const getUser = (id: string): Promise<JellyfinUserInfo> => get<JellyfinUserInfo>(`/Users/${encodeURIComponent(id)}`).then(normalizeUser);
    const deleteUser = (id: string): Promise<void> => del(`/Users/${encodeURIComponent(id)}`);
    const createUser = (name: string, password: string): Promise<JellyfinUserInfo> => postB<JellyfinUserInfo>('/Users/New', { Name: name, Password: password }).then(normalizeUser);
    const resetUserPassword = (id: string): Promise<void> => api.request<void>(`/Users/Password?userId=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ ResetPassword: true }) }, true, 2);
    const setUserPassword = (id: string, newPassword: string): Promise<void> => api.request<void>(`/Users/Password?userId=${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ NewPw: newPassword }) }, true, 2);
    const mergeUsers = (sourceUserId: string, targetUserId: string, preview = true): Promise<{ counts: Record<string, number>; warning?: string }> => api.request(`/Pgsql/Admin/Users/Merge${preview ? '/Preview' : ''}`, { method: 'POST', headers: { Accept: 'application/json; profile="CamelCase"' }, body: JSON.stringify({ sourceUserId, targetUserId }) });
    const moveUserData = (sourceUserId: string, targetUserId: string, preview = true): Promise<{ counts: Record<string, number>; warning?: string }> => api.request(`/Pgsql/Admin/Users/MoveUserData${preview ? '/Preview' : ''}`, { method: 'POST', headers: { Accept: 'application/json; profile="CamelCase"' }, body: JSON.stringify({ sourceUserId, targetUserId }) });
    const renameUser = async (id: string, name: string): Promise<void> => {
        const fresh = await get<Record<string, unknown>>(`/Users/${encodeURIComponent(id)}`, 2);
        await api.request<void>(`/Users/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ ...fresh, Name: name }) }, true, 2);
    };
    const updateUserPolicy = (id: string, policy: Record<string, unknown>): Promise<void> =>
        api.request<void>(`/Users/${encodeURIComponent(id)}/Policy`, { method: 'POST', body: JSON.stringify(policy) }, true, 2);
    const getApiKeys = (): Promise<ApiKey[]> => get<{ Items?: ApiKey[] }>('/Auth/Keys').then(r => r.Items || []);
    const createApiKey = (appName: string): Promise<void> => post(`/Auth/Keys?app=${encodeURIComponent(appName)}`);
    const getBackups = (): Promise<Array<{ Path: string; ServerVersion: string; DateCreated: string }> | null> => get<Array<{ Path: string; ServerVersion: string; DateCreated: string }>>('/Backup').catch(() => null);
    const createBackup = (options: { Metadata?: boolean; Trickplay?: boolean; Subtitles?: boolean } = {}): Promise<unknown> =>
        postB('/Backup/Create', { Database: true, Metadata: options.Metadata === true, Trickplay: options.Trickplay === true, Subtitles: options.Subtitles === true });
    const getBackupManifest = (path: string): Promise<BackupManifest> => get<BackupManifest>(`/Backup/Manifest?${new URLSearchParams({ path })}`, 2);
    const restoreBackup = (path: string): Promise<void> => api.request<void>('/Backup/Restore', { method: 'POST', body: JSON.stringify({ ArchiveFileName: path }) }, true);

    /* Named configuration documents: saves merge only changed fields onto a fresh copy. */
    const getConfig = <T extends Record<string, unknown> = Record<string, any>>(path: string): Promise<T> => get<T>(path, 2);
    const saveConfigPatch = async (path: string, patch: Record<string, unknown>): Promise<Record<string, any>> => {
        const fresh = await get<Record<string, unknown>>(path, 2);
        const next = applyPatch(fresh, patch);
        await api.request<void>(path, { method: 'POST', body: JSON.stringify(next) }, true, 2);
        return next;
    };
    const getLocalizationOptions = (): Promise<Array<{ Name?: string; Value?: string }>> => get('/Localization/Options');
    const getPublicSystemInfo = (): Promise<{ Version?: string; StartupWizardCompleted?: boolean }> => api.request('/System/Info/Public', {}, false, 2);

    /* Playback statistics (fork) */
    const getPlaybackOverview = async (): Promise<Record<string, any> | null> =>
        get<Record<string, any>>('/PlaybackStats/Overview').catch(() => null);

    const getDailyPlayback = async (startDate?: string, endDate?: string): Promise<Array<{ Date?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>> => {
        const query = new URLSearchParams({ groupBy: 'MediaType' });
        if (startDate) query.set('startDate', startDate);
        if (endDate) query.set('endDate', endDate);
        return get<Array<{ Date?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>>(`/PlaybackStats/Daily?${query}`).catch(() => []);
    };

    const statsQuery = ({ startDate, endDate }: PlaybackStatsFilter, extra: Record<string, string> = {}) => {
        const query = new URLSearchParams(extra);
        if (startDate) query.set('startDate', startDate);
        if (endDate) query.set('endDate', endDate);
        return query;
    };
    const getPlaybackByUser = (filter: PlaybackStatsFilter): Promise<Array<{ UserId?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>> => get(`/PlaybackStats/Users?${statsQuery(filter)}`);
    const getPlaybackHourly = (filter: PlaybackStatsFilter): Promise<Array<{ DayOfWeek?: number; Hour?: number; PlayCount?: number; TotalTicks?: number }>> => get(`/PlaybackStats/Hourly?${statsQuery(filter)}`);
    const getPlaybackItems = (filter: PlaybackStatsFilter, groupBy: 'Item' | 'Series', limit = 10): Promise<Array<{ MediaType?: string; ItemId?: string; ItemName?: string; PlayCount?: number; TotalTicks?: number }>> =>
        get(`/PlaybackStats/Items?${statsQuery(filter, { groupBy, limit: String(limit), includeOther: 'false' })}`);
    const getRecentPlayback = (filter: PlaybackStatsFilter, startIndex = 0, limit = 25): Promise<{ Items?: RecentPlayback[]; TotalRecordCount?: number }> =>
        get(`/PlaybackStats/Recent?${statsQuery(filter, { startIndex: String(startIndex), limit: String(limit) })}`);

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
    const getLibraryCounts = async (parentId: string): Promise<{ Movies: number; Series: number; Episodes: number; Audio: number; Books: number; Videos: number }> => {
        const count = (type: string) => get<{ TotalRecordCount?: number }>(`/Items?ParentId=${encodeURIComponent(parentId)}&Recursive=true&IncludeItemTypes=${type}&Limit=0&EnableTotalRecordCount=true&UserId=${encodeURIComponent(s.user.Id)}&Fields=`).then(r => r.TotalRecordCount || 0);
        const [Movies, Series, Episodes, Songs, Albums, Books, MusicVideos, HomeVideos] = await Promise.all([count('Movie'), count('Series'), count('Episode'), count('Audio'), count('MusicAlbum'), count('Book'), count('MusicVideo'), count('HomeVideo,Photo')]);
        return { Movies, Series, Episodes, Audio: Songs + Albums, Books, Videos: MusicVideos + HomeVideos };
    };
    const getVirtualFolders = (): Promise<VirtualFolder[]> => get<VirtualFolder[]>('/Library/VirtualFolders');
    const getSystemStorage = (): Promise<SystemStorage> => get<SystemStorage>('/System/Info/Storage');
    const getMediaEncoderCapabilities = async (): Promise<Record<string, any> | null> => raw<Record<string, any>>('/System/MediaEncoder/Capabilities').catch(() => null);
    const refreshLibrary = (itemId: string, metadataRefreshMode = 'Default', imageRefreshMode = 'Default'): Promise<void> => post(`/Items/${encodeURIComponent(itemId)}/Refresh?${new URLSearchParams({ metadataRefreshMode, imageRefreshMode })}`);
    const addLibrary = (name: string, collectionType: string, paths: string[]): Promise<void> => api.request<void>(`/Library/VirtualFolders?${new URLSearchParams({ name, ...(collectionType ? { collectionType } : {}), refreshLibrary: 'false' })}`, { method: 'POST', body: JSON.stringify({ LibraryOptions: { PathInfos: paths.map(Path => ({ Path })) } }) }, true);
    const removeLibrary = (name: string): Promise<void> => del(`/Library/VirtualFolders?${new URLSearchParams({ name, refreshLibrary: 'false' })}`);
    const renameLibrary = (name: string, newName: string): Promise<void> => post(`/Library/VirtualFolders/Name?${new URLSearchParams({ name, newName, refreshLibrary: 'false' })}`);
    const addLibraryPath = (name: string, path: string): Promise<void> => api.request<void>('/Library/VirtualFolders/Paths?refreshLibrary=false', { method: 'POST', body: JSON.stringify({ Name: name, PathInfo: { Path: path } }) }, true, 2);
    const removeLibraryPath = (name: string, path: string): Promise<void> => del(`/Library/VirtualFolders/Paths?${new URLSearchParams({ name, path, refreshLibrary: 'false' })}`);
    const updateLibraryOptions = (id: string, options: LibraryOptions): Promise<void> => api.request<void>('/Library/VirtualFolders/LibraryOptions', { method: 'POST', body: JSON.stringify({ Id: id, LibraryOptions: options }) }, true, 2);
    const getAvailableLibraryOptions = (collectionType?: string): Promise<AvailableLibraryOptions> =>
        get<AvailableLibraryOptions>(`/Libraries/AvailableOptions?${new URLSearchParams({ ...(collectionType && collectionType !== 'mixed' ? { libraryContentType: collectionType } : {}), isNewLibrary: 'false' })}`);
    const getCultures = (): Promise<Array<{ DisplayName?: string; TwoLetterISOLanguageName?: string; ThreeLetterISOLanguageName?: string }>> => get('/Localization/Cultures');
    const getCountries = (): Promise<Array<{ DisplayName?: string; TwoLetterISORegionName?: string }>> => get('/Localization/Countries');

    /* Plugins */
    const getPlugins = (): Promise<PluginInfo[]> => get<PluginInfo[]>('/Plugins');
    const enablePlugin = (pluginId: string, version: string): Promise<void> => post(`/Plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/Enable`);
    const disablePlugin = (pluginId: string, version: string): Promise<void> => post(`/Plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/Disable`);

    /* Logs */
    const getLogs = async (): Promise<Array<{ Name?: string; Size?: number; DateModified?: string }>> => get<Array<{ Name?: string; Size?: number; DateModified?: string }>>('/System/Logs');
    const getLogText = (name: string): Promise<string> => api.requestText(`/System/Logs/Log?name=${encodeURIComponent(name)}`);

    /* Seerr */
    const getSeerrStatus = async (): Promise<{ enabled: boolean } | null> => get<{ Enabled?: boolean; enabled?: boolean }>('/Seerr/Status').then(status => ({ enabled: status.Enabled === true || status.enabled === true })).catch(() => null);
    const testSeerrConnection = (): Promise<{ Version?: string; Message?: string; message?: string }> => postB('/Seerr/Test', {});
    const getTasteShadowEval = async (): Promise<TasteShadowEval | null> => get<TasteShadowEval>('/Pgsql/Admin/Taste/ShadowEval').catch(() => null);
    const getSsoConfig = async (): Promise<unknown | null> => raw<unknown>('/SSO/rbac/config').catch(() => null);
    const getSsoStatus = (): Promise<{ enabled: boolean } | null> => get<{ enabled: boolean }>('/SSO/config').catch(() => null);
    const saveSsoConfig = (config: unknown): Promise<void> => api.request<void>('/SSO/rbac/config', { method: 'POST', body: JSON.stringify(config) }, true, 2);
    const getTunerHostTypes = async (): Promise<Array<{ Name?: string; Id?: string }>> => raw<Array<{ Name?: string; Id?: string }>>('/LiveTv/TunerHosts/Types');
    const getLiveTvInfo = async (): Promise<Record<string, unknown> | null> => raw<Record<string, unknown>>('/LiveTv/Info');
    const getLiveTvChannels = async (startIndex = 0, limit = 100): Promise<{ Items?: Array<{ Id?: string; Name?: string; Number?: string; Type?: string }>; TotalRecordCount?: number }> => raw<{ Items?: Array<{ Id?: string; Name?: string; Number?: string; Type?: string }>; TotalRecordCount?: number }>(`/LiveTv/Channels?${new URLSearchParams({ StartIndex: String(startIndex), Limit: String(limit), EnableTotalRecordCount: 'true' })}`);
    const cancelTimer = (id: string): Promise<void> => del(`/LiveTv/Timers/${encodeURIComponent(id)}`);
    const getSeriesTimers = (): Promise<Array<{ Id: string; Name?: string; ChannelName?: string; RecordAnyChannel?: boolean; RecordAnyTime?: boolean; RecordNewOnly?: boolean; KeepUpTo?: number }>> =>
        get<{ Items?: Array<{ Id: string; Name?: string }> }>('/LiveTv/SeriesTimers', 2).then(r => r.Items || []);
    const cancelSeriesTimer = (id: string): Promise<void> => del(`/LiveTv/SeriesTimers/${encodeURIComponent(id)}`);
    const getActiveRecordings = (): Promise<Array<{ Id: string; Name?: string; ChannelName?: string; EndDate?: string }>> =>
        get<{ Items?: Array<{ Id: string; Name?: string }> }>(`/LiveTv/Recordings?${new URLSearchParams({ IsInProgress: 'true', UserId: s.user.Id, Fields: 'ChannelInfo' })}`, 2).then(r => r.Items || []);
    const deleteItem = (id: string): Promise<void> => del(`/Items/${encodeURIComponent(id)}`);
    const getLiveTvConfig = (): Promise<LiveTvConfiguration> => get<LiveTvConfiguration>('/System/Configuration/livetv');
    const discoverTuners = (newDevicesOnly = true): Promise<TunerHostInfo[]> => get<TunerHostInfo[]>(`/LiveTv/Tuners/Discover?newDevicesOnly=${newDevicesOnly}`, 2);
    const saveTunerHost = (info: TunerHostInfo): Promise<TunerHostInfo> => postB<TunerHostInfo>('/LiveTv/TunerHosts', info);
    const deleteTunerHost = (id: string): Promise<void> => del(`/LiveTv/TunerHosts?${new URLSearchParams({ id })}`);
    const getDefaultListingProvider = (): Promise<ListingsProviderInfo> => get<ListingsProviderInfo>('/LiveTv/ListingProviders/Default');
    const saveListingProvider = (info: ListingsProviderInfo, { validateLogin = false, validateListings = false }: { validateLogin?: boolean; validateListings?: boolean } = {}): Promise<ListingsProviderInfo> =>
        postB<ListingsProviderInfo>(`/LiveTv/ListingProviders?${new URLSearchParams({ validateLogin: String(validateLogin), validateListings: String(validateListings) })}`, info);
    const deleteListingProvider = (id: string): Promise<void> => del(`/LiveTv/ListingProviders?${new URLSearchParams({ id })}`);
    const getLineups = (provider: { Id?: string; Type?: string; ZipCode?: string; Country?: string }): Promise<Array<{ Id?: string; Name?: string }>> => {
        const query = new URLSearchParams();
        if (provider.Id) query.set('id', provider.Id);
        if (provider.Type) query.set('type', provider.Type);
        if (provider.ZipCode) query.set('location', provider.ZipCode);
        if (provider.Country) query.set('country', provider.Country);
        return get<Array<{ Id?: string; Name?: string }>>(`/LiveTv/ListingProviders/Lineups?${query}`, 2);
    };
    const getSchedulesDirectCountries = (): Promise<Record<string, Array<{ fullName?: string; shortName?: string; postalCodeExample?: string }>>> => get('/LiveTv/ListingProviders/SchedulesDirect/Countries');
    const getChannelMappingOptions = (providerId: string): Promise<ChannelMappingOptions> => get<ChannelMappingOptions>(`/LiveTv/ChannelMappingOptions?${new URLSearchParams({ providerId })}`, 2);
    const setChannelMapping = (providerId: string, tunerChannelId: string, providerChannelId: string): Promise<TunerChannelMapping> =>
        postB<TunerChannelMapping>('/LiveTv/ChannelMappings', { ProviderId: providerId, TunerChannelId: tunerChannelId, ProviderChannelId: providerChannelId });

    /* System actions */
    const scanAllLibraries = (): Promise<void> => post('/Library/Refresh');
    const restartServer = (): Promise<void> => post('/System/Restart');
    const shutdownServer = (): Promise<void> => post('/System/Shutdown');
    const stopPlayback = (id: string): Promise<void> => post(`/Sessions/${encodeURIComponent(id)}/Playing/Stop`);
    const pausePlayback = (id: string): Promise<void> => post(`/Sessions/${encodeURIComponent(id)}/Playing/Pause`);
    const resumePlayback = (id: string): Promise<void> => post(`/Sessions/${encodeURIComponent(id)}/Playing/Unpause`);
    const sendSessionMessage = (id: string, text: string): Promise<void> =>
        api.request<void>(`/Sessions/${encodeURIComponent(id)}/Message`, { method: 'POST', body: JSON.stringify({ Header: 'Message from administrator', Text: text, TimeoutMs: 10000 }) }, true, 2);
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
        getUser, createUser, resetUserPassword, mergeUsers, moveUserData, deleteUser, updateUserPolicy, getApiKeys, createApiKey, getBackups, createBackup, restoreBackup, getPlaybackOverview, getLibraries, getLibraryCounts, getVirtualFolders,
        getSystemStorage, getMediaEncoderCapabilities, refreshLibrary, addLibrary, removeLibrary, renameLibrary, addLibraryPath, removeLibraryPath, updateLibraryOptions, getAvailableLibraryOptions, getCultures, getCountries, getDailyPlayback, getPlaybackDimensions, getPlugins, enablePlugin, disablePlugin, getLogs, getLogText, getSeerrStatus, testSeerrConnection,
        getTasteShadowEval, getSsoConfig, getSsoStatus, saveSsoConfig, getTunerHostTypes, getLiveTvInfo, getLiveTvChannels, cancelTimer,
        getLiveTvConfig, discoverTuners, saveTunerHost, deleteTunerHost, getDefaultListingProvider, saveListingProvider, deleteListingProvider,
        getLineups, getSchedulesDirectCountries, getChannelMappingOptions, setChannelMapping,
        scanAllLibraries, restartServer, shutdownServer, stopPlayback, pausePlayback, resumePlayback, sendSessionMessage, setUserPassword, revokeKey, sendSystemCommand, deleteDevice, raw, putB,
        initEmbyUpload, uploadEmbyChunks, completeEmbyUpload, previewEmbyImport, executeEmbyImport, discardEmbyImport,
        getConfig, saveConfigPatch, getLocalizationOptions, getPublicSystemInfo, getPlaybackByUser, getPlaybackHourly, getPlaybackItems, getRecentPlayback,
        updateTaskTriggers, getAuthProviders, getDeviceOptions, saveDeviceName, saveDevicePlaybackOptions, getContentChannels, renameUser, getBackupManifest,
        getSeriesTimers, cancelSeriesTimer, getActiveRecordings, deleteItem,
    };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
