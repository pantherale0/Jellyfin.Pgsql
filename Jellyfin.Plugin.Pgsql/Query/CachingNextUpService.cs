using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Decorates <see cref="INextUpService"/> with short-lived caching for home-screen NextUp loads.
/// </summary>
internal sealed class CachingNextUpService : INextUpService, IDisposable
{
    private static readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web);

    private readonly INextUpService _inner;
    private readonly CachedItemLoader _loader;
    private readonly MemoryCache _cache = new(new MemoryCacheOptions());
    private readonly TimeSpan _ttl;
    private readonly ILogger<CachingNextUpService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="CachingNextUpService"/> class.
    /// </summary>
    /// <param name="inner">The core next-up service.</param>
    /// <param name="loader">The cached item loader.</param>
    /// <param name="logger">The logger.</param>
    public CachingNextUpService(INextUpService inner, CachedItemLoader loader, ILogger<CachingNextUpService> logger)
    {
        _inner = inner;
        _loader = loader;
        _logger = logger;
        _ttl = PgsqlQueryOptions.Current.NextUpTtl;
    }

    /// <inheritdoc />
    public IReadOnlyList<string> GetNextUpSeriesKeys(InternalItemsQuery filter, DateTime dateCutoff)
    {
        var options = PgsqlQueryOptions.Current;
        if (!options.CacheActive || _ttl <= TimeSpan.Zero)
        {
            return _inner.GetNextUpSeriesKeys(filter, dateCutoff);
        }

        var key = QueryCacheKeyBuilder.BuildNextUpSeriesKeysKey(filter, dateCutoff);
        if (key is null)
        {
            return _inner.GetNextUpSeriesKeys(filter, dateCutoff);
        }

        if (_cache.TryGetValue(key, out string[]? cached) && cached is not null)
        {
            return cached;
        }

        var result = _inner.GetNextUpSeriesKeys(filter, dateCutoff).ToArray();
        _cache.Set(key, result, _ttl);
        return result;
    }

    /// <inheritdoc />
    public IReadOnlyDictionary<string, NextUpEpisodeBatchResult> GetNextUpEpisodesBatch(
        InternalItemsQuery filter,
        IReadOnlyList<string> seriesKeys,
        bool includeSpecials,
        bool includeWatchedForRewatching)
    {
        var options = PgsqlQueryOptions.Current;
        if (!options.CacheActive || _ttl <= TimeSpan.Zero || seriesKeys.Count == 0)
        {
            return _inner.GetNextUpEpisodesBatch(filter, seriesKeys, includeSpecials, includeWatchedForRewatching);
        }

        var key = QueryCacheKeyBuilder.BuildNextUpBatchKey(filter, seriesKeys, includeSpecials, includeWatchedForRewatching);
        if (key is null)
        {
            return _inner.GetNextUpEpisodesBatch(filter, seriesKeys, includeSpecials, includeWatchedForRewatching);
        }

        if (_cache.TryGetValue(key, out byte[]? cachedPayload)
            && cachedPayload is not null
            && TryDeserializeBatch(cachedPayload, out var cachedEntries))
        {
            var rebuilt = RebuildBatchResults(cachedEntries, filter);
            if (rebuilt is not null)
            {
                if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug("NextUp batch served from cache ({Count} series)", rebuilt.Count);
                }

                return rebuilt;
            }
        }

        var result = _inner.GetNextUpEpisodesBatch(filter, seriesKeys, includeSpecials, includeWatchedForRewatching);
        var payload = SerializeBatch(result);
        _cache.Set(key, payload, _ttl);
        return result;
    }

    private Dictionary<string, NextUpEpisodeBatchResult>? RebuildBatchResults(
        Dictionary<string, NextUpBatchCacheEntry> cachedEntries,
        InternalItemsQuery filter)
    {
        var ids = cachedEntries.Values
            .SelectMany(static e =>
            {
                IEnumerable<Guid?> values = new Guid?[]
                {
                    e.LastWatchedId,
                    e.NextUpId,
                    e.LastWatchedForRewatchingId,
                    e.NextPlayedForRewatchingId
                };
                return values.Concat(e.SpecialIds.Select(id => (Guid?)id));
            })
            .Where(id => id.HasValue && !id.Value.Equals(default))
            .Select(id => id!.Value)
            .Distinct()
            .ToArray();

        var loaded = _loader.LoadByIds(ids, filter);
        if (loaded is null)
        {
            return null;
        }

        var itemsById = loaded.ToDictionary(i => i.Id);
        var rebuilt = new Dictionary<string, NextUpEpisodeBatchResult>(cachedEntries.Count, StringComparer.Ordinal);

        foreach (var (seriesKey, entry) in cachedEntries)
        {
            var batch = new NextUpEpisodeBatchResult();
            if (entry.LastWatchedId.HasValue && itemsById.TryGetValue(entry.LastWatchedId.Value, out var lastWatched))
            {
                batch.LastWatched = lastWatched;
            }

            if (entry.NextUpId.HasValue && itemsById.TryGetValue(entry.NextUpId.Value, out var nextUp))
            {
                batch.NextUp = nextUp;
            }

            batch.Specials = entry.SpecialIds
                .Where(itemsById.ContainsKey)
                .Select(id => itemsById[id])
                .ToList();

            if (entry.LastWatchedForRewatchingId.HasValue
                && itemsById.TryGetValue(entry.LastWatchedForRewatchingId.Value, out var lastRewatch))
            {
                batch.LastWatchedForRewatching = lastRewatch;
            }

            if (entry.NextPlayedForRewatchingId.HasValue
                && itemsById.TryGetValue(entry.NextPlayedForRewatchingId.Value, out var nextPlayed))
            {
                batch.NextPlayedForRewatching = nextPlayed;
            }

            rebuilt[seriesKey] = batch;
        }

        return rebuilt;
    }

    private static byte[] SerializeBatch(IReadOnlyDictionary<string, NextUpEpisodeBatchResult> result)
    {
        var payload = result.ToDictionary(
            kvp => kvp.Key,
            kvp => new NextUpBatchCacheEntry
            {
                LastWatchedId = kvp.Value.LastWatched?.Id,
                NextUpId = kvp.Value.NextUp?.Id,
                SpecialIds = kvp.Value.Specials?.Select(s => s.Id).ToArray() ?? Array.Empty<Guid>(),
                LastWatchedForRewatchingId = kvp.Value.LastWatchedForRewatching?.Id,
                NextPlayedForRewatchingId = kvp.Value.NextPlayedForRewatching?.Id
            },
            StringComparer.Ordinal);

        return JsonSerializer.SerializeToUtf8Bytes(payload, _jsonOptions);
    }

    private static bool TryDeserializeBatch(byte[] payload, out Dictionary<string, NextUpBatchCacheEntry> entries)
    {
        entries = new Dictionary<string, NextUpBatchCacheEntry>(StringComparer.Ordinal);
        try
        {
            var parsed = JsonSerializer.Deserialize<Dictionary<string, NextUpBatchCacheEntry>>(payload, _jsonOptions);
            if (parsed is null)
            {
                return false;
            }

            entries = parsed;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        _cache.Dispose();
    }

    private sealed class NextUpBatchCacheEntry
    {
        public Guid? LastWatchedId { get; set; }

        public Guid? NextUpId { get; set; }

        public Guid[] SpecialIds { get; set; } = Array.Empty<Guid>();

        public Guid? LastWatchedForRewatchingId { get; set; }

        public Guid? NextPlayedForRewatchingId { get; set; }
    }
}
