using System;
using System.Globalization;
using System.IO;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Redis-backed version stamps with an in-process mirror. Redis is the source of truth when
/// Ready so multiple Jellyfin instances share invalidation; Unknown/Unavailable degrade to memory.
/// </summary>
internal sealed class RedisQueryCacheVersionStore : IQueryCacheVersionStore, IDisposable
{
    private const string LibraryKey = "jf:pgsql:v1:cachever:library";
    private static readonly TimeSpan WarningThrottle = TimeSpan.FromSeconds(60);

    private readonly RedisConnectionHub _hub;
    private readonly ILogger _logger;
    private readonly MemoryQueryCacheVersionStore _memory = new();
    private DateTimeOffset _lastWarning = DateTimeOffset.MinValue;

    /// <summary>
    /// Initializes a new instance of the <see cref="RedisQueryCacheVersionStore"/> class.
    /// </summary>
    /// <param name="hub">Shared Redis connection hub.</param>
    /// <param name="logger">The logger.</param>
    public RedisQueryCacheVersionStore(RedisConnectionHub hub, ILogger logger)
    {
        _hub = hub;
        _logger = logger;
    }

    /// <inheritdoc />
    public long GetLibraryVersion()
    {
        if (!_hub.TryGetDatabase(out var db))
        {
            return _memory.GetLibraryVersion();
        }

        try
        {
            var value = db.StringGet(LibraryKey);
            _hub.ReportSuccess();
            if (value.HasValue
                && long.TryParse((string)value!, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }

            return _memory.GetLibraryVersion();
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            _hub.ReportFailure();
            LogThrottled(ex, "get-library");
            return _memory.GetLibraryVersion();
        }
    }

    /// <inheritdoc />
    public long GetUserVersion(Guid userId)
    {
        if (!_hub.TryGetDatabase(out var db))
        {
            return _memory.GetUserVersion(userId);
        }

        try
        {
            var value = db.StringGet(UserKey(userId));
            _hub.ReportSuccess();
            if (value.HasValue
                && long.TryParse((string)value!, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }

            return _memory.GetUserVersion(userId);
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            _hub.ReportFailure();
            LogThrottled(ex, "get-user");
            return _memory.GetUserVersion(userId);
        }
    }

    /// <inheritdoc />
    public void BumpUser(Guid userId)
    {
        _memory.BumpUser(userId);

        if (!_hub.TryGetDatabase(out var db))
        {
            return;
        }

        try
        {
            db.StringIncrement(UserKey(userId));
            _hub.ReportSuccess();
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            _hub.ReportFailure();
            LogThrottled(ex, "bump-user");
        }
    }

    /// <inheritdoc />
    public void BumpLibrary()
    {
        _memory.BumpLibrary();

        if (!_hub.TryGetDatabase(out var db))
        {
            return;
        }

        try
        {
            db.StringIncrement(LibraryKey);
            _hub.ReportSuccess();
        }
        catch (Exception ex) when (IsTransientRedisFailure(ex))
        {
            _hub.ReportFailure();
            LogThrottled(ex, "bump-library");
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        // Hub lifetime is owned by DI.
    }

    private static string UserKey(Guid userId)
        => string.Create(CultureInfo.InvariantCulture, $"jf:pgsql:v1:cachever:user:{userId:N}");

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
            "Redis query cache version {Operation} failed; using in-process versions until health probe recovers (status={Status})",
            operation,
            _hub.Status);
    }
}
