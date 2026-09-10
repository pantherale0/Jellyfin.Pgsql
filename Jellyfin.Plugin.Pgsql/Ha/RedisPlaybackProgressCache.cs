using System;
using System.Globalization;
using System.IO;
using Jellyfin.Plugin.Pgsql.Query;
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

    private readonly RedisConnectionHub _hub;
    private readonly ILogger _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="RedisPlaybackProgressCache"/> class.
    /// </summary>
    /// <param name="hub">Shared Redis connection hub.</param>
    /// <param name="logger">The logger.</param>
    public RedisPlaybackProgressCache(RedisConnectionHub hub, ILogger logger)
    {
        _hub = hub;
        _logger = logger;
    }

    /// <inheritdoc />
    public void Set(Guid userId, Guid itemId, long positionTicks)
    {
        if (!_hub.TryGetDatabase(out var db))
        {
            return;
        }

        try
        {
            db.StringSet(Key(userId, itemId), positionTicks.ToString(CultureInfo.InvariantCulture), Ttl);
            _hub.ReportSuccess();
        }
        catch (Exception ex) when (IsTransient(ex))
        {
            _hub.ReportFailure();
            _logger.LogDebug(ex, "Redis playback progress set failed");
        }
    }

    /// <inheritdoc />
    public bool TryGet(Guid userId, Guid itemId, out long positionTicks)
    {
        positionTicks = 0;
        if (!_hub.TryGetDatabase(out var db))
        {
            return false;
        }

        try
        {
            var value = db.StringGet(Key(userId, itemId));
            _hub.ReportSuccess();
            return value.HasValue
                && long.TryParse((string?)value, NumberStyles.Integer, CultureInfo.InvariantCulture, out positionTicks);
        }
        catch (Exception ex) when (IsTransient(ex))
        {
            _hub.ReportFailure();
            _logger.LogDebug(ex, "Redis playback progress get failed");
            return false;
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        // Hub lifetime is owned by DI.
    }

    private static string Key(Guid userId, Guid itemId)
        => string.Create(CultureInfo.InvariantCulture, $"jf:pgsql:progress:{userId:N}:{itemId:N}");

    private static bool IsTransient(Exception ex)
        => ex is RedisException or IOException or TimeoutException or ObjectDisposedException;
}
