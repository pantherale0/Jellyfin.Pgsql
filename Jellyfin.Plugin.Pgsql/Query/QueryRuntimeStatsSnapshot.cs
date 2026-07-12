using System;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Immutable runtime stats payload for dashboard/API responses.
/// </summary>
/// <param name="StartedAtUtc">When the plugin process counters started.</param>
/// <param name="LatestCacheHits">Latest cache hits.</param>
/// <param name="LatestCacheMisses">Latest cache misses.</param>
/// <param name="ResumeCacheHits">Resume cache hits.</param>
/// <param name="ResumeCacheMisses">Resume cache misses.</param>
/// <param name="NextUpCacheHits">NextUp cache hits.</param>
/// <param name="NextUpCacheMisses">NextUp cache misses.</param>
/// <param name="RedisGetErrors">Redis get failures.</param>
/// <param name="RedisSetErrors">Redis set failures.</param>
/// <param name="OptimizedLatestRuns">Attempted optimized latest query runs.</param>
/// <param name="OptimizedLatestFailures">Failed optimized latest query runs.</param>
public sealed record QueryRuntimeStatsSnapshot(
    DateTimeOffset StartedAtUtc,
    long LatestCacheHits,
    long LatestCacheMisses,
    long ResumeCacheHits,
    long ResumeCacheMisses,
    long NextUpCacheHits,
    long NextUpCacheMisses,
    long RedisGetErrors,
    long RedisSetErrors,
    long OptimizedLatestRuns,
    long OptimizedLatestFailures);
