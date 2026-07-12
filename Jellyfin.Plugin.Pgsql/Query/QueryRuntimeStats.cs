using System;
using System.Threading;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Process-local counters for cache and query optimization behavior.
/// </summary>
public sealed class QueryRuntimeStats
{
    private readonly DateTimeOffset _startedAt = DateTimeOffset.UtcNow;
    private long _latestCacheHits;
    private long _latestCacheMisses;
    private long _resumeCacheHits;
    private long _resumeCacheMisses;
    private long _redisGetErrors;
    private long _redisSetErrors;
    private long _optimizedLatestRuns;
    private long _optimizedLatestFailures;
    private long _nextUpCacheHits;
    private long _nextUpCacheMisses;

    /// <summary>
    /// Marks a Latest cache lookup outcome.
    /// </summary>
    /// <param name="hit">True when served from cache.</param>
    public void RecordLatestCacheLookup(bool hit)
    {
        if (hit)
        {
            Interlocked.Increment(ref _latestCacheHits);
            return;
        }

        Interlocked.Increment(ref _latestCacheMisses);
    }

    /// <summary>
    /// Marks a Resume cache lookup outcome.
    /// </summary>
    /// <param name="hit">True when served from cache.</param>
    public void RecordResumeCacheLookup(bool hit)
    {
        if (hit)
        {
            Interlocked.Increment(ref _resumeCacheHits);
            return;
        }

        Interlocked.Increment(ref _resumeCacheMisses);
    }

    /// <summary>
    /// Marks a Redis cache operation error.
    /// </summary>
    /// <param name="operation">The operation name ('get' or 'set').</param>
    public void RecordRedisError(string operation)
    {
        if (operation.Equals("get", StringComparison.OrdinalIgnoreCase))
        {
            Interlocked.Increment(ref _redisGetErrors);
            return;
        }

        Interlocked.Increment(ref _redisSetErrors);
    }

    /// <summary>
    /// Marks one attempted optimized Latest query execution.
    /// </summary>
    public void RecordOptimizedLatestRun()
    {
        Interlocked.Increment(ref _optimizedLatestRuns);
    }

    /// <summary>
    /// Marks one optimized Latest query failure.
    /// </summary>
    public void RecordOptimizedLatestFailure()
    {
        Interlocked.Increment(ref _optimizedLatestFailures);
    }

    /// <summary>
    /// Marks a NextUp cache lookup outcome.
    /// </summary>
    /// <param name="hit">True when served from cache.</param>
    public void RecordNextUpCacheLookup(bool hit)
    {
        if (hit)
        {
            Interlocked.Increment(ref _nextUpCacheHits);
            return;
        }

        Interlocked.Increment(ref _nextUpCacheMisses);
    }

    /// <summary>
    /// Creates an immutable snapshot of current counters.
    /// </summary>
    /// <returns>The stats snapshot.</returns>
    public QueryRuntimeStatsSnapshot Snapshot()
    {
        return new QueryRuntimeStatsSnapshot(
            _startedAt,
            Interlocked.Read(ref _latestCacheHits),
            Interlocked.Read(ref _latestCacheMisses),
            Interlocked.Read(ref _resumeCacheHits),
            Interlocked.Read(ref _resumeCacheMisses),
            Interlocked.Read(ref _nextUpCacheHits),
            Interlocked.Read(ref _nextUpCacheMisses),
            Interlocked.Read(ref _redisGetErrors),
            Interlocked.Read(ref _redisSetErrors),
            Interlocked.Read(ref _optimizedLatestRuns),
            Interlocked.Read(ref _optimizedLatestFailures));
    }
}
