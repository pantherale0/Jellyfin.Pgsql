using System;
using System.Globalization;
using System.IO;
using System.Threading;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Jellyfin.Plugin.Pgsql.Ha;

/// <summary>
/// Redis overlay of coalesced playback progress so a new leader can recover unflushed ticks.
/// </summary>
internal sealed class RedisPlaybackProgressCache : IPlaybackProgressCache, IDisposable
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan CircuitOpenDuration = TimeSpan.FromSeconds(30);

    private readonly ConnectionMultiplexer _connection;
    private readonly ILogger _logger;
    private long _circuitOpenUntilTicks;

    /// <summary>
    /// Initializes a new instance of the <see cref="RedisPlaybackProgressCache"/> class.
    /// </summary>
    /// <param name="connectionString">The Redis connection string.</param>
    /// <param name="logger">The logger.</param>
    public RedisPlaybackProgressCache(string connectionString, ILogger logger)
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
    public void Set(Guid userId, Guid itemId, long positionTicks)
    {
        if (!CanUseRedis())
        {
            return;
        }

        try
        {
            _connection.GetDatabase().StringSet(Key(userId, itemId), positionTicks.ToString(CultureInfo.InvariantCulture), Ttl);
        }
        catch (Exception ex) when (IsTransient(ex))
        {
            OpenCircuit();
            _logger.LogDebug(ex, "Redis playback progress set failed");
        }
    }

    /// <inheritdoc />
    public bool TryGet(Guid userId, Guid itemId, out long positionTicks)
    {
        positionTicks = 0;
        if (!CanUseRedis())
        {
            return false;
        }

        try
        {
            var value = _connection.GetDatabase().StringGet(Key(userId, itemId));
            return value.HasValue
                && long.TryParse((string?)value, NumberStyles.Integer, CultureInfo.InvariantCulture, out positionTicks);
        }
        catch (Exception ex) when (IsTransient(ex))
        {
            OpenCircuit();
            _logger.LogDebug(ex, "Redis playback progress get failed");
            return false;
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        _connection.Dispose();
    }

    private static string Key(Guid userId, Guid itemId)
        => string.Create(CultureInfo.InvariantCulture, $"jf:pgsql:progress:{userId:N}:{itemId:N}");

    private bool CanUseRedis()
        => Interlocked.Read(ref _circuitOpenUntilTicks) <= DateTimeOffset.UtcNow.UtcTicks;

    private void OpenCircuit()
        => Interlocked.Exchange(ref _circuitOpenUntilTicks, DateTimeOffset.UtcNow.Add(CircuitOpenDuration).UtcTicks);

    private static bool IsTransient(Exception ex)
        => ex is RedisException or IOException or TimeoutException or ObjectDisposedException;
}
