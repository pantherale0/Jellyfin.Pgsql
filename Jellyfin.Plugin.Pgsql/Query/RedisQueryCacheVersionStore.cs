using System;
using System.Globalization;
using System.IO;
using System.Threading;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Redis-backed version stamps with an in-process mirror. Redis is the source of truth when
/// reachable so multiple Jellyfin instances share invalidation; failures degrade to memory.
/// </summary>
internal sealed class RedisQueryCacheVersionStore : IQueryCacheVersionStore, IDisposable
{
    private const string LibraryKey = "jf:pgsql:v1:cachever:library";
    private static readonly TimeSpan CircuitOpenDuration = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan WarningThrottle = TimeSpan.FromSeconds(60);

    private readonly ConnectionMultiplexer _connection;
    private readonly ILogger _logger;
    private readonly MemoryQueryCacheVersionStore _memory = new();
    private long _circuitOpenUntilTicks;
    private DateTimeOffset _lastWarning = DateTimeOffset.MinValue;

    /// <summary>
    /// Initializes a new instance of the <see cref="RedisQueryCacheVersionStore"/> class.
    /// </summary>
    /// <param name="connectionString">The StackExchange.Redis connection string.</param>
    /// <param name="logger">The logger.</param>
    public RedisQueryCacheVersionStore(string connectionString, ILogger logger)
    {
        _logger = logger;

        var configuration = ConfigurationOptions.Parse(connectionString);
        configuration.AbortOnConnectFail = false;
        configuration.BacklogPolicy = BacklogPolicy.FailFast;
        configuration.ConnectTimeout = 1000;
        configuration.SyncTimeout = 250;
        configuration.AsyncTimeout = 250;

        _connection = ConnectionMultiplexer.Connect(configuration);
    }

    /// <inheritdoc />
    public long GetLibraryVersion()
    {
        if (!TryGetRedis(out var db))
        {
            return _memory.GetLibraryVersion();
        }

        try
        {
            var value = db.StringGet(LibraryKey);
            if (value.HasValue
                && long.TryParse((string)value!, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }

            return _memory.GetLibraryVersion();
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            OpenCircuit();
            LogThrottled(ex, "get-library");
            return _memory.GetLibraryVersion();
        }
    }

    /// <inheritdoc />
    public long GetUserVersion(Guid userId)
    {
        if (!TryGetRedis(out var db))
        {
            return _memory.GetUserVersion(userId);
        }

        try
        {
            var value = db.StringGet(UserKey(userId));
            if (value.HasValue
                && long.TryParse((string)value!, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }

            return _memory.GetUserVersion(userId);
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            OpenCircuit();
            LogThrottled(ex, "get-user");
            return _memory.GetUserVersion(userId);
        }
    }

    /// <inheritdoc />
    public void BumpUser(Guid userId)
    {
        _memory.BumpUser(userId);

        if (!TryGetRedis(out var db))
        {
            return;
        }

        try
        {
            db.StringIncrement(UserKey(userId));
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            OpenCircuit();
            LogThrottled(ex, "bump-user");
        }
    }

    /// <inheritdoc />
    public void BumpLibrary()
    {
        _memory.BumpLibrary();

        if (!TryGetRedis(out var db))
        {
            return;
        }

        try
        {
            db.StringIncrement(LibraryKey);
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            OpenCircuit();
            LogThrottled(ex, "bump-library");
        }
    }

    /// <inheritdoc />
    public void Dispose() => _connection.Dispose();

    private static string UserKey(Guid userId)
        => string.Create(CultureInfo.InvariantCulture, $"jf:pgsql:v1:cachever:user:{userId:N}");

    private bool TryGetRedis(out IDatabase db)
    {
        db = null!;
        var openUntil = Interlocked.Read(ref _circuitOpenUntilTicks);
        if (openUntil != 0 && DateTimeOffset.UtcNow.UtcTicks < openUntil)
        {
            return false;
        }

        if (!_connection.IsConnected)
        {
            return false;
        }

        db = _connection.GetDatabase();
        return true;
    }

    private void OpenCircuit()
    {
        var until = DateTimeOffset.UtcNow.Add(CircuitOpenDuration).UtcTicks;
        Interlocked.Exchange(ref _circuitOpenUntilTicks, until);
    }

    private static bool IsTransientRedisFailure(Exception ex)
        => ex is RedisException or IOException or TimeoutException or ObjectDisposedException;

    private void LogThrottled(Exception ex, string operation)
    {
        var now = DateTimeOffset.UtcNow;
        if (now - _lastWarning < WarningThrottle)
        {
            return;
        }

        _lastWarning = now;
        _logger.LogWarning(
            ex,
            "Redis query cache version {Operation} failed; using in-process versions for {CircuitSeconds}s",
            operation,
            CircuitOpenDuration.TotalSeconds);
    }
}
