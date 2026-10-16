import type { LibraryOptions } from './library-options';

export type AdminSection = 'overview' | 'users' | 'libraries' | 'playback' | 'live-tv' | 'metadata' | 'recommendations' | 'infrastructure' | 'activity' | 'system';

export type ServerHealth = 'healthy' | 'degraded' | 'critical';

export interface HealthIssue { severity: 'degraded' | 'critical'; message: string; link?: AdminSection; }

export interface PgsqlStatsSnapshot {
    CacheActive: boolean; CacheBackend: string; RedisAvailability: string; RedisConnected: boolean;
    RedisGetErrors: number; RedisSetErrors: number;
    BrowseCacheHits: number; BrowseCacheMisses: number; LatestCacheHits: number; LatestCacheMisses: number;
    BrowseTtlSeconds: number; LatestTtlSeconds: number; ResumeTtlSeconds: number; NextUpTtlSeconds: number;
    OptimizeMoviesLatest: boolean; OptimizeTvLatest: boolean; OptimizeMusicLatest: boolean; OptimizeNextUp: boolean;
    OptimizedLatestRuns: number; OptimizedLatestFailures: number; OptimizedNextUpRuns: number; OptimizedNextUpFailures: number;
    /** Older plugin builds omit the HA block. */
    StartedAtUtc?: string; HaEnabled?: boolean; HaRole?: string; LeaderEpoch?: number; LeaderSinceUtc?: string | null;
    HaHeartbeatSeconds?: number | null; InstanceName?: string;
}

export interface ServerActivityEntry {
    Id: string; Name?: string; Overview?: string; ShortOverview?: string; Type?: string; ItemId?: string;
    Date?: string; UserId?: string; UserPrimaryImageTag?: string; Severity?: string;
}

export interface JellyfinSession {
    Id: string; UserName?: string; Client?: string; DeviceName?: string; UserId?: string; RemoteEndPoint?: string; SupportsRemoteControl?: boolean;
    UserPrimaryImageTag?: string; LastActivityDate?: string; ApplicationVersion?: string; SupportedCommands?: string[];
    PlayState?: { PositionTicks?: number; PlayMethod?: string | number; IsPaused?: boolean; IsMuted?: boolean; MediaSourceId?: string; AudioStreamIndex?: number; SubtitleStreamIndex?: number };
    NowPlayingItem?: { Name?: string; Type?: string; Id?: string; RunTimeTicks?: number; ProductionYear?: number };
    TranscodingInfo?: { IsVideoDirect?: boolean; IsAudioDirect?: boolean; Container?: string; BitRate?: number; Width?: number; Height?: number; VideoCodec?: string; AudioCodec?: string;
        AudioChannels?: number; Framerate?: number; CompletionPercentage?: number; HardwareAccelerationType?: string; TranscodeReasons?: string[] };
}

export interface ScheduledTask {
    Id: string; Key?: string; Name?: string; State?: string; CurrentProgressPercentage?: number;
    Description?: string; Category?: string; IsHidden?: boolean;
    Triggers?: import('./server-settings').TaskTrigger[];
    LastExecutionResult?: { Status?: string; EndTimeUtc?: string; StartTimeUtc?: string; ErrorMessage?: string };
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
    ServerName?: string; Version?: string; ProductName?: string; Id?: string;
    HasUpdateAvailable?: boolean; HasPendingRestart?: boolean; IsShuttingDown?: boolean;
    PackageName?: string; SystemArchitecture?: string; EncoderLocation?: string; SupportsLibraryMonitor?: boolean;
}

export interface PluginInfo {
    Name?: string; Version?: string; Guid?: string; ConfigurationFileName?: string; Description?: string;
    Id?: string; Status?: string; CanUninstall?: boolean; HasImage?: boolean;
}

/** One release of a catalog package (`/Packages` is always camelCase). */
export interface PackageVersion {
    version: string; changelog?: string; targetAbi?: string; timestamp?: string; repositoryName: string; repositoryUrl: string;
}

export interface PackageInfo {
    guid: string; name: string; description?: string; overview?: string; owner?: string; category?: string; imageUrl?: string;
    /** Newest first. */
    versions: PackageVersion[];
}

/** `/Repositories` uses Jellyfin's default PascalCase. */
export interface RepositoryInfo {
    Name: string; Url: string; Enabled: boolean;
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
    Id?: string; Name?: string; CustomName?: string; LastUserId?: string; AppName?: string; AppVersion?: string;
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
    ProgramDataFolder?: FolderStorage;
    WebFolder?: FolderStorage;
    ImageCacheFolder?: FolderStorage;
    CacheFolder?: FolderStorage;
    LogFolder?: FolderStorage;
    InternalMetadataFolder?: FolderStorage;
    TranscodingTempFolder?: FolderStorage;
    Libraries: Array<{ Id: string; Name: string; Folders: FolderStorage[] }>;
}

export interface VirtualFolder {
    Name: string;
    Locations: string[];
    CollectionType?: string;
    ItemId?: string;
    RefreshProgress?: number;
    RefreshStatus?: string;
    LibraryOptions?: LibraryOptions;
}

export interface TunerHostInfo {
    [key: string]: unknown;
    Id?: string; Url?: string; Type?: string; DeviceId?: string; FriendlyName?: string;
    ImportFavoritesOnly?: boolean; AllowHWTranscoding?: boolean; AllowFmp4TranscodingContainer?: boolean; AllowStreamSharing?: boolean;
    FallbackMaxStreamingBitrate?: number; EnableStreamLooping?: boolean; Source?: string; TunerCount?: number; UserAgent?: string;
    IgnoreDts?: boolean; ReadAtNativeFramerate?: boolean;
}

export interface ListingsProviderInfo {
    [key: string]: unknown;
    Id?: string; Type?: string; Username?: string; Password?: string; ListingsId?: string; ZipCode?: string; Country?: string; Path?: string;
    EnabledTuners?: string[]; EnableAllTuners?: boolean;
    NewsCategories?: string[]; SportsCategories?: string[]; KidsCategories?: string[]; MovieCategories?: string[];
    ChannelMappings?: Array<{ Name?: string; Value?: string }>; MoviePrefix?: string; PreferredLanguage?: string; UserAgent?: string;
}

export interface LiveTvConfiguration {
    [key: string]: unknown;
    TunerHosts?: TunerHostInfo[];
    ListingProviders?: ListingsProviderInfo[];
}

export interface TunerChannelMapping { Id?: string; Name?: string; ProviderChannelId?: string; ProviderChannelName?: string }

export interface ChannelMappingOptions {
    TunerChannels?: TunerChannelMapping[];
    ProviderChannels?: Array<{ Id?: string; Name?: string }>;
    Mappings?: Array<{ Name?: string; Value?: string }>;
    ProviderName?: string;
}

export interface TasteEvalRun {
    Id?: string; CreatedAt?: string; TrainDurationMs?: number; PositiveCount?: number; NegativeCount?: number; HoldoutCount?: number; TrainCount?: number;
    Accuracy?: number | null; Auc?: number | null; PrecisionAt10?: number | null; MeanPrecisionAt10?: number | null;
    SplitType?: string | null; HoldoutFraction?: number | null; HoldoutWindowStart?: string | null; HoldoutWindowEnd?: string | null;
    ForYouEngageRate?: number | null; ForYouEngageWindowDays?: number | null; ForYouImpressionCount?: number | null; ForYouEngageCount?: number | null;
    Notes?: string | null; Succeeded?: boolean;
}

export interface TasteShadowEval {
    Status?: { TasteEnabled?: boolean; ShadowTrainingEnabled?: boolean; NeuralServingEnabled?: boolean; NeuralModelLoaded?: boolean; ForYouEngageRate?: number;
        ForYouEngageWindowDays?: number; ForYouImpressionCount?: number; ForYouEngageCount?: number };
    Latest?: TasteEvalRun;
    Runs?: TasteEvalRun[];
}
