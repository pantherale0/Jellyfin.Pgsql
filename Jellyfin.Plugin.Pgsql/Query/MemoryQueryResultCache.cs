using System;
using Microsoft.Extensions.Caching.Memory;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// In-process <see cref="IQueryResultCache"/> backed by a private <see cref="MemoryCache"/>.
/// </summary>
internal sealed class MemoryQueryResultCache : IQueryResultCache, IDisposable
{
    private readonly MemoryCache _cache = new(new MemoryCacheOptions());

    /// <inheritdoc/>
    public bool TryGet(string key, out Guid[] ids)
    {
        if (_cache.TryGetValue(key, out Guid[]? cached) && cached is not null)
        {
            ids = cached;
            return true;
        }

        ids = [];
        return false;
    }

    /// <inheritdoc/>
    public void Set(string key, Guid[] ids, TimeSpan timeToLive)
    {
        _cache.Set(key, ids, timeToLive);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        _cache.Dispose();
    }
}
