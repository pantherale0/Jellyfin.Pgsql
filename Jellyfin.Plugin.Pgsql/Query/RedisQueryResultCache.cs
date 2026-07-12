using System;
using System.IO;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.StackExchangeRedis;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Redis-backed <see cref="IQueryResultCache"/>. Recoverable Redis failures are swallowed and treated
/// as cache misses so that a Redis outage never breaks queries.
/// </summary>
internal sealed class RedisQueryResultCache : IQueryResultCache, IDisposable
{
    private const string KeyPrefix = "jf:pgsql:v1:";
    private static readonly TimeSpan _warningThrottle = TimeSpan.FromSeconds(60);

    private readonly RedisCache _cache;
    private readonly ConnectionMultiplexer _connection;
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
        _connection = ConnectionMultiplexer.Connect(connectionString);
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
        catch (RedisException ex)
        {
            return HandleCacheFailure(ex, "get");
        }
        catch (IOException ex)
        {
            return HandleCacheFailure(ex, "get");
        }
        catch (TimeoutException ex)
        {
            return HandleCacheFailure(ex, "get");
        }
        catch (ObjectDisposedException ex)
        {
            return HandleCacheFailure(ex, "get");
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
        catch (RedisException ex)
        {
            ReportCacheFailure(ex, "set");
        }
        catch (IOException ex)
        {
            ReportCacheFailure(ex, "set");
        }
        catch (TimeoutException ex)
        {
            ReportCacheFailure(ex, "set");
        }
        catch (ObjectDisposedException ex)
        {
            ReportCacheFailure(ex, "set");
        }
    }

    /// <inheritdoc/>
    public bool TryGetPayload(string key, out byte[] payload)
    {
        payload = [];
        try
        {
            var cached = _cache.Get(key);
            if (cached is null || cached.Length == 0)
            {
                return false;
            }

            payload = cached;
            return true;
        }
        catch (RedisException ex)
        {
            return HandlePayloadFailure(ex, "get");
        }
        catch (IOException ex)
        {
            return HandlePayloadFailure(ex, "get");
        }
        catch (TimeoutException ex)
        {
            return HandlePayloadFailure(ex, "get");
        }
        catch (ObjectDisposedException ex)
        {
            return HandlePayloadFailure(ex, "get");
        }
    }

    /// <inheritdoc/>
    public void SetPayload(string key, byte[] payload, TimeSpan timeToLive)
    {
        try
        {
            _cache.Set(key, payload, new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = timeToLive,
            });
        }
        catch (RedisException ex)
        {
            ReportCacheFailure(ex, "set");
        }
        catch (IOException ex)
        {
            ReportCacheFailure(ex, "set");
        }
        catch (TimeoutException ex)
        {
            ReportCacheFailure(ex, "set");
        }
        catch (ObjectDisposedException ex)
        {
            ReportCacheFailure(ex, "set");
        }
    }

    /// <inheritdoc/>
    public void InvalidateAll()
    {
        try
        {
            foreach (var endpoint in _connection.GetEndPoints())
            {
                var server = _connection.GetServer(endpoint);
                if (!server.IsConnected || server.IsReplica)
                {
                    continue;
                }

                foreach (var key in server.Keys(pattern: KeyPrefix + "*"))
                {
                    _cache.Remove(key.ToString()[KeyPrefix.Length..]);
                }
            }
        }
        catch (RedisException ex)
        {
            ReportCacheFailure(ex, "invalidate");
        }
        catch (IOException ex)
        {
            ReportCacheFailure(ex, "invalidate");
        }
        catch (TimeoutException ex)
        {
            ReportCacheFailure(ex, "invalidate");
        }
        catch (ObjectDisposedException ex)
        {
            ReportCacheFailure(ex, "invalidate");
        }
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        _cache.Dispose();
        _connection.Dispose();
    }

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
        _stats.RecordRedisError(operation);
        LogThrottled(ex, operation);
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
