export type AdminSection = 'overview' | 'users' | 'libraries' | 'playback' | 'live-tv' | 'recommendations' | 'infrastructure' | 'activity' | 'system';

export type ServerHealth = 'healthy' | 'degraded' | 'critical';

export interface HealthIssue {
    severity: 'degraded' | 'critical';
    message: string;
    link?: AdminSection;
}

export interface PgsqlStatsSnapshot {
    CacheActive: boolean;
    CacheBackend: string;
    RedisAvailability: string;
    RedisConnected: boolean;
    RedisGetErrors: number;
    RedisSetErrors: number;
    BrowseCacheHits: number;
    BrowseCacheMisses: number;
    LatestCacheHits: number;
    LatestCacheMisses: number;
    BrowseTtlSeconds: number;
    LatestTtlSeconds: number;
    ResumeTtlSeconds: number;
    NextUpTtlSeconds: number;
    OptimizeMoviesLatest: boolean;
    OptimizeTvLatest: boolean;
    OptimizeMusicLatest: boolean;
    OptimizeNextUp: boolean;
    OptimizedLatestRuns: number;
    OptimizedLatestFailures: number;
    OptimizedNextUpRuns: number;
    OptimizedNextUpFailures: number;
}

export interface ServerActivityEntry {
    Id: string;
    Name?: string;
    Overview?: string;
    ShortOverview?: string;
    Type?: string;
    ItemId?: string;
    Date?: string;
    UserId?: string;
    UserPrimaryImageTag?: string;
    Severity?: string;
}

export interface JellyfinSession {
    Id: string;
    UserName?: string;
    Client?: string;
    DeviceName?: string;
    UserId?: string;
    RemoteEndPoint?: string;
    UserPrimaryImageTag?: string;
    LastActivityDate?: string;
    NowPlayingItem?: { Name?: string; Type?: string; Id?: string; RunTimeTicks?: number };
    PlayState?: { PositionTicks?: number };
    TranscodingInfo?: { IsVideoDirect?: boolean; IsAudioDirect?: boolean; Container?: string; BitRate?: number; Width?: number; Height?: number };
}

export interface ScheduledTask {
    Id: string;
    Name?: string;
    State?: string;
    CurrentProgressPercentage?: number;
    LastExecutionResult?: { Status?: string; EndTimeUtc?: string };
}

export interface LibraryTotals {
    Movies: number; Episodes: number; Series: number; Collections: number;
}

export interface SystemInfo {
    ServerName?: string; Version?: string; OperatingSystem?: string; RunTimeTicks?: number; SystemUpdateLevel?: string;
}

export interface JellyfinUserInfo {
    Id: string; Name: string; HasPassword?: boolean; LastLoginDate?: string;
    LastActivityDate?: string; IsAdministrator?: boolean; IsDisabled?: boolean;
}

export interface ForkStatus {
    cache: { backend: string; status: string; hitRate: string; ttl: string };
    taste: { refreshed: string | null; healthy: boolean };
    sso?: { synced: string | null };
    seerr?: { openRequests: number };
    playbackMix?: { direct: number; transcode: number; remux: number; total: number };
}