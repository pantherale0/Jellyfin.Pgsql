using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Decorates <see cref="INextUpService"/> with PostgreSQL-optimised batch queries and
/// short-lived caching for home-screen NextUp loads.
/// </summary>
internal sealed class CachingNextUpService : INextUpService
{
    private static readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerDefaults.Web);

    private readonly INextUpService _inner;
    private readonly IQueryResultCache _cache;
    private readonly CachedItemLoader _loader;
    private readonly PgNextUpQuery _pgNextUp;
    private readonly QueryRuntimeStats _stats;
    private readonly TimeSpan _ttl;
    private readonly ILogger<CachingNextUpService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="CachingNextUpService"/> class.
    /// </summary>
    /// <param name="inner">The core next-up service.</param>
    /// <param name="cache">The query result cache.</param>
    /// <param name="loader">The cached item loader.</param>
    /// <param name="pgNextUp">The PostgreSQL NextUp optimiser.</param>
    /// <param name="stats">The runtime stats collector.</param>
    /// <param name="logger">The logger.</param>
    public CachingNextUpService(
        INextUpService inner,
        IQueryResultCache cache,
        CachedItemLoader loader,
        PgNextUpQuery pgNextUp,
        QueryRuntimeStats stats,
        ILogger<CachingNextUpService> logger)
    {
        _inner = inner;
        _cache = cache;
        _loader = loader;
        _pgNextUp = pgNextUp;
        _stats = stats;
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

        if (_cache.TryGetPayload(key, out var cachedPayload)
            && TryDeserializeStringArray(cachedPayload, out var cached))
        {
            _stats.RecordNextUpCacheLookup(hit: true);
            return cached;
        }

        _stats.RecordNextUpCacheLookup(hit: false);
        var result = _inner.GetNextUpSeriesKeys(filter, dateCutoff).ToArray();
        _cache.SetPayload(key, JsonSerializer.SerializeToUtf8Bytes(result, _jsonOptions), _ttl);
        return result;
    }

    /// <inheritdoc />
    public IReadOnlyDictionary<string, NextUpEpisodeBatchResult> GetNextUpEpisodesBatch(
        InternalItemsQuery filter,
        IReadOnlyList<string> seriesKeys,
        bool includeSpecials,
        bool includeWatchedForRewatching)
    {
        if (seriesKeys.Count == 0)
        {
            return new Dictionary<string, NextUpEpisodeBatchResult>();
        }

        var options = PgsqlQueryOptions.Current;
        var cacheEnabled = options.CacheActive && _ttl > TimeSpan.Zero;
        string? cacheKey = null;

        if (cacheEnabled)
        {
            cacheKey = QueryCacheKeyBuilder.BuildNextUpBatchKey(filter, seriesKeys, includeSpecials, includeWatchedForRewatching);
            if (cacheKey is not null
                && _cache.TryGetPayload(cacheKey, out var cachedPayload)
                && cachedPayload is not null
                && TryDeserializeBatch(cachedPayload, out var cachedEntries))
            {
                var rebuilt = RebuildBatchResults(cachedEntries, filter);
                if (rebuilt is not null)
                {
                    _stats.RecordNextUpCacheLookup(hit: true);
                    if (_logger.IsEnabled(LogLevel.Debug))
                    {
                        _logger.LogDebug("NextUp batch served from cache ({Count} series)", rebuilt.Count);
                    }

                    return rebuilt;
                }
            }

            if (cacheKey is not null)
            {
                _stats.RecordNextUpCacheLookup(hit: false);
            }
        }

        var result = _pgNextUp.TryGetBatch(filter, seriesKeys, includeSpecials, includeWatchedForRewatching)
            ?? _inner.GetNextUpEpisodesBatch(filter, seriesKeys, includeSpecials, includeWatchedForRewatching);

        if (cacheEnabled && cacheKey is not null)
        {
            _cache.SetPayload(cacheKey, SerializeBatch(result), _ttl);
        }

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

    private static bool TryDeserializeStringArray(byte[] payload, out string[] values)
    {
        values = Array.Empty<string>();
        try
        {
            var parsed = JsonSerializer.Deserialize<string[]>(payload, _jsonOptions);
            if (parsed is null)
            {
                return false;
            }

            values = parsed;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
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
