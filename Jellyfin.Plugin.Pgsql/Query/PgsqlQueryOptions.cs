using System;
using System.Globalization;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// The cache backend used for query result caching.
/// </summary>
internal enum QueryCacheBackend
{
    /// <summary>Caching disabled.</summary>
    Off,

    /// <summary>In-process memory cache.</summary>
    Memory,

    /// <summary>Redis distributed cache.</summary>
    Redis,
}

/// <summary>
/// Resolved cache and query optimisation options. Environment variables take precedence
/// over plugin configuration; values are resolved once on first use, so changes require
/// a server restart.
/// </summary>
internal sealed class PgsqlQueryOptions
{
    private static readonly Lazy<PgsqlQueryOptions> _lazyCurrent = new(Resolve);

    /// <summary>
    /// Gets the resolved options for the current process.
    /// </summary>
    public static PgsqlQueryOptions Current => _lazyCurrent.Value;

    /// <summary>
    /// Gets a value indicating whether query result caching is enabled.
    /// </summary>
    public bool CacheEnabled { get; private init; }

    /// <summary>
    /// Gets a value indicating whether caching is effectively active
    /// (enabled and not configured to the <see cref="QueryCacheBackend.Off"/> backend).
    /// </summary>
    public bool CacheActive => CacheEnabled && CacheBackend != QueryCacheBackend.Off;

    /// <summary>
    /// Gets the configured cache backend.
    /// </summary>
    public QueryCacheBackend CacheBackend { get; private init; }

    /// <summary>
    /// Gets the Redis connection string (StackExchange.Redis format).
    /// </summary>
    public string RedisConnectionString { get; private init; } = string.Empty;

    /// <summary>
    /// Gets the time-to-live for cached Latest results.
    /// </summary>
    public TimeSpan LatestTtl { get; private init; }

    /// <summary>
    /// Gets the time-to-live for cached Resume results. Zero or negative disables Resume caching.
    /// </summary>
    public TimeSpan ResumeTtl { get; private init; }

    /// <summary>
    /// Gets the time-to-live for cached NextUp batch results. Zero or negative disables NextUp caching.
    /// </summary>
    public TimeSpan NextUpTtl { get; private init; }

    /// <summary>
    /// Gets a value indicating whether the PostgreSQL-optimised Movies Latest query is enabled.
    /// </summary>
    public bool OptimizeMoviesLatest { get; private init; }

    /// <summary>
    /// Gets a value indicating whether the PostgreSQL-optimised TV Latest query is enabled.
    /// </summary>
    public bool OptimizeTvLatest { get; private init; }

    /// <summary>
    /// Gets a value indicating whether the PostgreSQL-optimised Music Latest query is enabled.
    /// </summary>
    public bool OptimizeMusicLatest { get; private init; }

    /// <summary>
    /// Gets a value indicating whether the PostgreSQL-optimised NextUp batch query is enabled.
    /// </summary>
    public bool OptimizeNextUp { get; private init; }

    private static PgsqlQueryOptions Resolve()
    {
        var config = Plugin.Instance?.Configuration;

        var backendText = Environment.GetEnvironmentVariable("Pgsql_CACHE_BACKEND") ?? config?.CacheBackend;
        if (!Enum.TryParse<QueryCacheBackend>(backendText, ignoreCase: true, out var backend))
        {
            backend = QueryCacheBackend.Redis;
        }

        var optimizeLatest = GetBool("Pgsql_PG_OPTIMIZE_LATEST", config?.OptimizeLatestQueries ?? true);

        return new PgsqlQueryOptions
        {
            CacheEnabled = GetBool("Pgsql_CACHE_ENABLED", config?.EnableQueryCache ?? true),
            CacheBackend = backend,
            RedisConnectionString = Environment.GetEnvironmentVariable("REDIS_CONNECTION_STRING")
                ?? config?.RedisConnectionString
                ?? string.Empty,
            LatestTtl = TimeSpan.FromSeconds(GetInt("Pgsql_CACHE_LATEST_TTL", config?.LatestCacheTtlSeconds ?? 120)),
            ResumeTtl = TimeSpan.FromSeconds(GetInt("Pgsql_CACHE_RESUME_TTL", config?.ResumeCacheTtlSeconds ?? 30)),
            NextUpTtl = TimeSpan.FromSeconds(GetInt("Pgsql_CACHE_NEXTUP_TTL", config?.NextUpCacheTtlSeconds ?? 45)),
            OptimizeMoviesLatest = GetBool("Pgsql_PG_OPTIMIZE_MOVIES_LATEST", optimizeLatest),
            OptimizeTvLatest = GetBool("Pgsql_PG_OPTIMIZE_TV_LATEST", optimizeLatest),
            OptimizeMusicLatest = GetBool("Pgsql_PG_OPTIMIZE_MUSIC_LATEST", optimizeLatest),
            OptimizeNextUp = GetBool("Pgsql_PG_OPTIMIZE_NEXTUP", config?.OptimizeNextUpQueries ?? true),
        };
    }

    private static bool GetBool(string variable, bool defaultValue)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        return value is null ? defaultValue : value.Equals(bool.TrueString, StringComparison.OrdinalIgnoreCase);
    }

    private static int GetInt(string variable, int defaultValue)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        return value is not null && int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : defaultValue;
    }
}
