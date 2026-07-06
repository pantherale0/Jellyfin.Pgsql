using System;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.StackExchangeRedis;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Redis-backed <see cref="IQueryResultCache"/>. All Redis failures are swallowed and treated
/// as cache misses so that a Redis outage never breaks queries.
/// </summary>
internal sealed class RedisQueryResultCache : IQueryResultCache, IDisposable
{
    private const string KeyPrefix = "jf:pgsql:v1:";
    private static readonly TimeSpan _warningThrottle = TimeSpan.FromSeconds(60);

    private readonly RedisCache _cache;
    private readonly ILogger _logger;
    private readonly QueryRuntimeStats _stats;
    private DateTimeOffset _lastWarning = DateTimeOffset.MinValue;

    /// <summary>
    /// Initializes a new instance of the <see cref="RedisQueryResultCache"/> class.
    /// </summary>
    /// <param name="connectionString">The StackExchange.Redis connection string.</param>
    /// <param name="logger">The logger.</param>
    /// <param name="stats">The runtime stats collector.</param>
    public RedisQueryResultCache(string connectionString, ILogger logger, QueryRuntimeStats stats)
    {
        _logger = logger;
        _stats = stats;
        _cache = new RedisCache(Options.Create(new RedisCacheOptions
        {
            Configuration = connectionString,
            InstanceName = KeyPrefix,
        }));
    }

    /// <inheritdoc/>
    public bool TryGet(string key, out Guid[] ids)
    {
        ids = [];
        try
        {
            return QueryResultPayload.TryDeserialize(_cache.Get(key), out ids);
        }
#pragma warning disable CA1031 // Redis failures must degrade to cache misses.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            _stats.RecordRedisError("get");
            LogThrottled(ex, "get");
            return false;
        }
    }

    /// <inheritdoc/>
    public void Set(string key, Guid[] ids, TimeSpan timeToLive)
    {
        try
        {
            _cache.Set(key, QueryResultPayload.Serialize(ids), new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = timeToLive,
            });
        }
#pragma warning disable CA1031 // Redis failures must degrade to cache misses.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            _stats.RecordRedisError("set");
            LogThrottled(ex, "set");
        }
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        _cache.Dispose();
    }

    private void LogThrottled(Exception ex, string operation)
    {
        var now = DateTimeOffset.UtcNow;
        if (now - _lastWarning >= _warningThrottle)
        {
            _lastWarning = now;
            _logger.LogWarning(ex, "Redis query cache {Operation} failed; continuing without cache", operation);
        }
    }
}
