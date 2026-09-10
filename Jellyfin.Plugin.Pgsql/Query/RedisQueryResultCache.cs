using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.StackExchangeRedis;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Redis-backed <see cref="IQueryResultCache"/>. Recoverable Redis failures are swallowed and treated
/// as cache misses so that a Redis outage never breaks queries or server startup.
/// Uses <see cref="RedisConnectionHub"/> so Unknown/Unavailable skip immediately instead of waiting
/// on SyncTimeout (which previously made home APIs appear slow when Redis was half-dead).
/// </summary>
internal sealed class RedisQueryResultCache : IQueryResultCache, IDisposable
{
    private const string KeyPrefix = "jf:pgsql:v1:";
    private static readonly TimeSpan WarningThrottle = TimeSpan.FromSeconds(60);

    private readonly RedisCache _cache;
    private readonly RedisConnectionHub _hub;
    private readonly ILogger _logger;
    private readonly QueryRuntimeStats _stats;
    private DateTimeOffset _lastWarning = DateTimeOffset.MinValue;

    /// <summary>
    /// Initializes a new instance of the <see cref="RedisQueryResultCache"/> class.
    /// </summary>
    /// <param name="hub">Shared Redis connection hub.</param>
    /// <param name="logger">The logger.</param>
    /// <param name="stats">The runtime stats collector.</param>
    public RedisQueryResultCache(RedisConnectionHub hub, ILogger logger, QueryRuntimeStats stats)
    {
        _hub = hub;
        _logger = logger;
        _stats = stats;
        _cache = new RedisCache(Options.Create(new RedisCacheOptions
        {
            ConnectionMultiplexerFactory = () => Task.FromResult(_hub.Connection),
            InstanceName = KeyPrefix,
        }));
    }

    /// <inheritdoc/>
    public bool TryGet(string key, out Guid[] ids)
    {
        ids = [];
        if (!_hub.CanUse)
        {
            return false;
        }

        try
        {
            var hit = QueryResultPayload.TryDeserialize(_cache.Get(key), out ids);
            _hub.ReportSuccess();
            return hit;
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            return HandleCacheFailure(ex, "get");
        }
    }

    /// <inheritdoc/>
    public void Set(string key, Guid[] ids, TimeSpan timeToLive)
    {
        if (!_hub.CanUse)
        {
            return;
        }

        try
        {
            _cache.Set(key, QueryResultPayload.Serialize(ids), new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = timeToLive,
            });
            _hub.ReportSuccess();
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            ReportCacheFailure(ex, "set");
        }
    }

    /// <inheritdoc/>
    public bool TryGetPayload(string key, out byte[] payload)
    {
        payload = [];
        if (!_hub.CanUse)
        {
            return false;
        }

        try
        {
            var cached = _cache.Get(key);
            if (cached is null || cached.Length == 0)
            {
                _hub.ReportSuccess();
                return false;
            }

            payload = cached;
            _hub.ReportSuccess();
            return true;
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            return HandlePayloadFailure(ex, "get");
        }
    }

    /// <inheritdoc/>
    public void SetPayload(string key, byte[] payload, TimeSpan timeToLive)
    {
        if (!_hub.CanUse)
        {
            return;
        }

        try
        {
            _cache.Set(key, payload, new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = timeToLive,
            });
            _hub.ReportSuccess();
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            ReportCacheFailure(ex, "set");
        }
    }

    /// <inheritdoc/>
    public void InvalidateAll()
    {
        if (!_hub.CanUse)
        {
            return;
        }

        try
        {
            foreach (var server in _hub.Connection.GetEndPoints().Select(endpoint => _hub.Connection.GetServer(endpoint)))
            {
                if (!server.IsConnected || server.IsReplica)
                {
                    continue;
                }

                foreach (var key in server.Keys(pattern: KeyPrefix + "*"))
                {
                    _cache.Remove(key.ToString()[KeyPrefix.Length..]);
                }
            }

            _hub.ReportSuccess();
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            ReportCacheFailure(ex, "invalidate");
        }
    }

    /// <inheritdoc/>
    public void Remove(string key)
    {
        if (!_hub.CanUse)
        {
            return;
        }

        try
        {
            _cache.Remove(key);
            _hub.ReportSuccess();
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            ReportCacheFailure(ex, "remove");
        }
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        _cache.Dispose();
        // Hub lifetime is owned by DI; do not dispose it here.
    }

    private static bool IsTransientRedisFailure(Exception ex)
        => ex is RedisException or IOException or TimeoutException or ObjectDisposedException;

    private bool HandlePayloadFailure(Exception ex, string operation)
    {
        ReportCacheFailure(ex, operation);
        return false;
    }

    private bool HandleCacheFailure(Exception ex, string operation)
    {
        ReportCacheFailure(ex, operation);
        return false;
    }

    private void ReportCacheFailure(Exception ex, string operation)
    {
        _hub.ReportFailure();
        _stats.RecordRedisError(operation);
        LogThrottled(ex, operation);
    }

    private void LogThrottled(Exception ex, string operation)
    {
        var now = DateTimeOffset.UtcNow;
        if (now - _lastWarning >= WarningThrottle)
        {
            _lastWarning = now;
            _logger.LogWarning(
                ex,
                "Redis query cache {Operation} failed; continuing without cache until health probe recovers (status={Status})",
                operation,
                _hub.Status);
        }
    }
}
