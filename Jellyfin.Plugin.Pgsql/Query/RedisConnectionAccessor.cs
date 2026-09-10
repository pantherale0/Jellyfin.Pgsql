using System;
using Jellyfin.Plugin.Pgsql.Ha;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Optional DI holder for <see cref="RedisConnectionHub"/>. When Redis is not configured or
/// construction fails, <see cref="Hub"/> is <c>null</c> and callers use memory / no-op paths.
/// </summary>
public sealed class RedisConnectionAccessor : IDisposable
{
    /// <summary>
    /// Initializes a new instance of the <see cref="RedisConnectionAccessor"/> class.
    /// </summary>
    /// <param name="loggerFactory">Logger factory.</param>
    public RedisConnectionAccessor(ILoggerFactory loggerFactory)
    {
        var connectionString = PgsqlQueryOptions.Current.RedisConnectionString;
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            return;
        }

        var needsRedis = PgsqlQueryOptions.Current.CacheBackend == QueryCacheBackend.Redis
            || HaOptions.Current.Enabled;
        if (!needsRedis)
        {
            return;
        }

        Hub = RedisConnectionHub.TryCreate(
            connectionString,
            loggerFactory.CreateLogger<RedisConnectionHub>());
    }

    /// <summary>Gets the shared hub when Redis is active; otherwise <c>null</c>.</summary>
    public RedisConnectionHub? Hub { get; }

    /// <inheritdoc />
    public void Dispose() => Hub?.Dispose();
}
