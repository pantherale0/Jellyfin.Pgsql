using System;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// API response for plugin runtime stats.
/// </summary>
public sealed class PgsqlStatsResponse
{
    /// <summary>Gets or sets when current process counters started.</summary>
    public DateTimeOffset StartedAtUtc { get; set; }

    /// <summary>Gets or sets a value indicating whether caching is active.</summary>
    public bool CacheActive { get; set; }

    /// <summary>Gets or sets the effective cache backend.</summary>
    public string CacheBackend { get; set; } = string.Empty;

    /// <summary>Gets or sets latest cache TTL in seconds.</summary>
    public int LatestTtlSeconds { get; set; }

    /// <summary>Gets or sets resume cache TTL in seconds.</summary>
    public int ResumeTtlSeconds { get; set; }

    /// <summary>Gets or sets a value indicating whether movies latest optimization is enabled.</summary>
    public bool OptimizeMoviesLatest { get; set; }

    /// <summary>Gets or sets a value indicating whether TV latest optimization is enabled.</summary>
    public bool OptimizeTvLatest { get; set; }

    /// <summary>Gets or sets a value indicating whether music latest optimization is enabled.</summary>
    public bool OptimizeMusicLatest { get; set; }

    /// <summary>Gets or sets a value indicating whether NextUp batch optimization is enabled.</summary>
    public bool OptimizeNextUp { get; set; }

    /// <summary>Gets or sets latest cache hits.</summary>
    public long LatestCacheHits { get; set; }

    /// <summary>Gets or sets latest cache misses.</summary>
    public long LatestCacheMisses { get; set; }

    /// <summary>Gets or sets resume cache hits.</summary>
    public long ResumeCacheHits { get; set; }

    /// <summary>Gets or sets resume cache misses.</summary>
    public long ResumeCacheMisses { get; set; }

    /// <summary>Gets or sets next-up cache TTL in seconds.</summary>
    public int NextUpTtlSeconds { get; set; }

    /// <summary>Gets or sets next-up cache hits.</summary>
    public long NextUpCacheHits { get; set; }

    /// <summary>Gets or sets next-up cache misses.</summary>
    public long NextUpCacheMisses { get; set; }

    /// <summary>Gets or sets redis get errors.</summary>
    public long RedisGetErrors { get; set; }

    /// <summary>Gets or sets redis set errors.</summary>
    public long RedisSetErrors { get; set; }

    /// <summary>Gets or sets optimized latest attempts.</summary>
    public long OptimizedLatestRuns { get; set; }

    /// <summary>Gets or sets optimized latest failures.</summary>
    public long OptimizedLatestFailures { get; set; }

    /// <summary>Gets or sets optimized NextUp attempts.</summary>
    public long OptimizedNextUpRuns { get; set; }

    /// <summary>Gets or sets optimized NextUp failures.</summary>
    public long OptimizedNextUpFailures { get; set; }
}
