using System;
using System.IO;
using System.Linq;
using System.Threading;
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
/// When Redis is disconnected or the circuit is open, operations return immediately instead of
/// blocking on the default 5s backlog timeout (which previously made home APIs appear 5–10s slow).
/// </summary>
internal sealed class RedisQueryResultCache : IQueryResultCache, IDisposable
{
    private const string KeyPrefix = "jf:pgsql:v1:";
    private static readonly TimeSpan WarningThrottle = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan CircuitOpenDuration = TimeSpan.FromSeconds(30);

    private readonly RedisCache _cache;
    private readonly ConnectionMultiplexer _connection;
    private readonly ILogger _logger;
    private readonly QueryRuntimeStats _stats;
    private DateTimeOffset _lastWarning = DateTimeOffset.MinValue;
    private long _circuitOpenUntilTicks; // DateTimeOffset.UtcTicks; 0 = closed

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

        var configuration = ConfigurationOptions.Parse(connectionString);
        // Never fail server startup because Redis is briefly unreachable; the multiplexer
        // keeps retrying in the background and cache ops degrade to misses until then.
        configuration.AbortOnConnectFail = false;
        // Do not queue commands while disconnected — that backlog wait is a 5s tax on every
        // Latest/Resume/NextUp request when Redis is unreachable.
        configuration.BacklogPolicy = BacklogPolicy.FailFast;
        // Keep residual timeouts short so a race during reconnect cannot stall home APIs.
        configuration.ConnectTimeout = 1000;
        configuration.SyncTimeout = 250;
        configuration.AsyncTimeout = 250;

        _connection = ConnectionMultiplexer.Connect(configuration);
        _cache = new RedisCache(Options.Create(new RedisCacheOptions
        {
            ConnectionMultiplexerFactory = () => Task.FromResult<IConnectionMultiplexer>(_connection),
            InstanceName = KeyPrefix,
        }));
    }

    /// <inheritdoc/>
    public bool TryGet(string key, out Guid[] ids)
    {
        ids = [];
        if (!CanUseRedis())
        {
            return false;
        }

        try
        {
            return QueryResultPayload.TryDeserialize(_cache.Get(key), out ids);
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            return HandleCacheFailure(ex, "get");
        }
    }

    /// <inheritdoc/>
    public void Set(string key, Guid[] ids, TimeSpan timeToLive)
    {
        if (!CanUseRedis())
        {
            return;
        }

        try
        {
            _cache.Set(key, QueryResultPayload.Serialize(ids), new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = timeToLive,
            });
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
        if (!CanUseRedis())
        {
            return false;
        }

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
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            return HandlePayloadFailure(ex, "get");
        }
    }

    /// <inheritdoc/>
    public void SetPayload(string key, byte[] payload, TimeSpan timeToLive)
    {
        if (!CanUseRedis())
        {
            return;
        }

        try
        {
            _cache.Set(key, payload, new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = timeToLive,
            });
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            ReportCacheFailure(ex, "set");
        }
    }

    /// <inheritdoc/>
    public void InvalidateAll()
    {
        if (!CanUseRedis())
        {
            return;
        }

        try
        {
            foreach (var server in _connection.GetEndPoints().Select(endpoint => _connection.GetServer(endpoint)))
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
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            ReportCacheFailure(ex, "invalidate");
        }
    }

    /// <inheritdoc/>
    public void Remove(string key)
    {
        if (!CanUseRedis())
        {
            return;
        }

        try
        {
            _cache.Remove(key);
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
        _connection.Dispose();
    }

    private bool CanUseRedis()
    {
        var openUntil = Interlocked.Read(ref _circuitOpenUntilTicks);
        if (openUntil != 0 && DateTimeOffset.UtcNow.UtcTicks < openUntil)
        {
            return false;
        }

        if (!_connection.IsConnected)
        {
            return false;
        }

        return true;
    }

    private void OpenCircuit()
    {
        var until = DateTimeOffset.UtcNow.Add(CircuitOpenDuration).UtcTicks;
        Interlocked.Exchange(ref _circuitOpenUntilTicks, until);
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
        OpenCircuit();
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
                "Redis query cache {Operation} failed; continuing without cache for {CircuitSeconds}s",
                operation,
                CircuitOpenDuration.TotalSeconds);
        }
    }
}
