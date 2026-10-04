export type AdminSection = 'overview' | 'users' | 'libraries' | 'playback' | 'live-tv' | 'recommendations' | 'infrastructure' | 'activity' | 'system';

export type ServerHealth = 'healthy' | 'degraded' | 'critical';

export interface HealthIssue { severity: 'degraded' | 'critical'; message: string; link?: AdminSection; }

export interface PgsqlStatsSnapshot {
    CacheActive: boolean; CacheBackend: string; RedisAvailability: string; RedisConnected: boolean;
    RedisGetErrors: number; RedisSetErrors: number;
    BrowseCacheHits: number; BrowseCacheMisses: number; LatestCacheHits: number; LatestCacheMisses: number;
    BrowseTtlSeconds: number; LatestTtlSeconds: number; ResumeTtlSeconds: number; NextUpTtlSeconds: number;
    OptimizeMoviesLatest: boolean; OptimizeTvLatest: boolean; OptimizeMusicLatest: boolean; OptimizeNextUp: boolean;
    OptimizedLatestRuns: number; OptimizedLatestFailures: number; OptimizedNextUpRuns: number; OptimizedNextUpFailures: number;
}

export interface ServerActivityEntry {
    Id: string; Name?: string; Overview?: string; ShortOverview?: string; Type?: string; ItemId?: string;
    Date?: string; UserId?: string; UserPrimaryImageTag?: string; Severity?: string;
}

export interface JellyfinSession {
    Id: string; UserName?: string; Client?: string; DeviceName?: string; UserId?: string; RemoteEndPoint?: string;
    UserPrimaryImageTag?: string; LastActivityDate?: string; PlayState?: { PositionTicks?: number; PlayMethod?: string | number; IsPaused?: boolean };
    NowPlayingItem?: { Name?: string; Type?: string; Id?: string; RunTimeTicks?: number; ProductionYear?: number };
    TranscodingInfo?: { IsVideoDirect?: boolean; IsAudioDirect?: boolean; Container?: string; BitRate?: number; Width?: number; Height?: number; VideoCodec?: string; AudioCodec?: string };
}

export interface ScheduledTask {
    Id: string; Key?: string; Name?: string; State?: string; CurrentProgressPercentage?: number;
    LastExecutionResult?: { Status?: string; EndTimeUtc?: string; StartTimeUtc?: string };
}

export interface JellyfinUserInfo {
    Id: string; Name: string; DisplayName?: string; HasPassword?: boolean; LastLoginDate?: string;
    LastActivityDate?: string; IsAdministrator?: boolean; IsDisabled?: boolean;
    Policy?: Record<string, any>; Configuration?: Record<string, any>;
    PrimaryImageTag?: string;
}

export interface LibraryInfo {
    ItemId?: string; Name?: string; Path?: string; PrimaryImageItemId?: string; CollectionType?: string;
    ItemCountOfMovies?: number; ItemCountOfSeries?: number; ItemCountOfEpisodes?: number; ItemCount?: number;
    Options?: { [k: string]: any; Path?: string[] };
    RefreshProgress?: number;
    RefreshStatus?: string;
}

export interface SystemInfo {
    ServerName?: string; Version?: string; OperatingSystem?: string; RunTimeTicks?: number;
    SystemUpdateLevel?: string; InternalHttpPort?: number; PublicHttpPort?: number; HttpsPort?: number;
    WebSocketPort?: number; HasUpdateAvailable?: boolean; OperatingSystemDisplayName?: string;
    WebSocketPortNumber?: number;
}

export interface PluginInfo {
    Name?: string; Version?: string; Guid?: string; ConfigurationFileName?: string; Description?: string;
    Id?: string; Status?: string; CanUninstall?: boolean;
}

export interface ForkStatus {
    cache?: { backend: string; status: string; hitRate?: string; ttl?: string };
    taste?: { refreshed: string | null; healthy: boolean; precisionAt10?: number; engageRate?: number; serving?: boolean };
    sso?: { synced: string | null; enabled: boolean };
    seerr?: { openRequests: number; enabled: boolean };
}

export interface PlaybackStats {
    direct?: number; transcode?: number; remux?: number;
    total?: number; todayDirect?: number; todayTranscode?: number;
}

export interface DeviceInfo {
    Id?: string; Name?: string; LastUserId?: string; AppName?: string; AppVersion?: string;
    LastUserName?: string; DateLastActivity?: string;
}

export interface ApiKey {
    AccessToken?: string; AppName?: string; UserId?: string;
}

export interface ChannelInfo {
    Id?: string; Name?: string; Number?: string; Type?: string; MediaSourceName?: string;
    ViewLimit?: number; CollectionType?: string; DateLastEnabled?: string;
}

export interface FolderStorage {
    Path: string;
    FreeSpace: number;
    UsedSpace: number;
    StorageType?: string;
    DeviceId?: string;
}

export interface SystemStorage {
    ProgramDataFolder: FolderStorage;
    WebFolder: FolderStorage;
    ImageCacheFolder: FolderStorage;
    CacheFolder: FolderStorage;
    LogFolder: FolderStorage;
    InternalMetadataFolder: FolderStorage;
    TranscodingTempFolder: FolderStorage;
    Libraries: Array<{ Id: string; Name: string; Folders: FolderStorage[] }>;
}

export interface VirtualFolder {
    Name: string;
    Locations: string[];
    CollectionType?: string;
    ItemId?: string;
    RefreshProgress?: number;
    RefreshStatus?: string;
}

export interface TasteShadowEval {
    Status?: { TasteEnabled?: boolean; ShadowTrainingEnabled?: boolean; NeuralServingEnabled?: boolean; NeuralModelLoaded?: boolean; ForYouEngageRate?: number };
    Latest?: { CreatedAt?: string; PrecisionAt10?: number; MeanPrecisionAt10?: number; Succeeded?: boolean };
}
