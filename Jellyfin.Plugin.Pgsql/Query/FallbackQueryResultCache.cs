using System;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Tries a primary cache first, then falls back to a secondary (typically in-process memory).
/// Writes go to both so home APIs keep local hits when Redis is unavailable.
/// </summary>
internal sealed class FallbackQueryResultCache : IQueryResultCache, IDisposable
{
    private readonly IQueryResultCache _primary;
    private readonly IQueryResultCache _fallback;

    /// <summary>
    /// Initializes a new instance of the <see cref="FallbackQueryResultCache"/> class.
    /// </summary>
    /// <param name="primary">Preferred cache (e.g. Redis).</param>
    /// <param name="fallback">Secondary cache used on miss / primary skip (e.g. memory).</param>
    public FallbackQueryResultCache(IQueryResultCache primary, IQueryResultCache fallback)
    {
        _primary = primary;
        _fallback = fallback;
    }

    /// <inheritdoc/>
    public bool TryGet(string key, out Guid[] ids)
    {
        if (_primary.TryGet(key, out ids))
        {
            return true;
        }

        return _fallback.TryGet(key, out ids);
    }

    /// <inheritdoc/>
    public void Set(string key, Guid[] ids, TimeSpan timeToLive)
    {
        _fallback.Set(key, ids, timeToLive);
        _primary.Set(key, ids, timeToLive);
    }

    /// <inheritdoc/>
    public bool TryGetPayload(string key, out byte[] payload)
    {
        if (_primary.TryGetPayload(key, out payload))
        {
            return true;
        }

        return _fallback.TryGetPayload(key, out payload);
    }

    /// <inheritdoc/>
    public void SetPayload(string key, byte[] payload, TimeSpan timeToLive)
    {
        _fallback.SetPayload(key, payload, timeToLive);
        _primary.SetPayload(key, payload, timeToLive);
    }

    /// <inheritdoc/>
    public void InvalidateAll()
    {
        _fallback.InvalidateAll();
        _primary.InvalidateAll();
    }

    /// <inheritdoc/>
    public void Remove(string key)
    {
        _fallback.Remove(key);
        _primary.Remove(key);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        if (_primary is IDisposable primaryDisposable)
        {
            primaryDisposable.Dispose();
        }

        if (_fallback is IDisposable fallbackDisposable)
        {
            fallbackDisposable.Dispose();
        }
    }
}
