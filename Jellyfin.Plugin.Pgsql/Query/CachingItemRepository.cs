using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Decorates the core <see cref="IItemRepository"/> with result caching for the hot
/// home-screen paths (Latest, Resume) and PostgreSQL-optimised Latest queries.
/// All other members delegate to the core repository unchanged.
/// </summary>
internal sealed class CachingItemRepository : IItemRepository
{
    private readonly IItemRepository _inner;
    private readonly IQueryResultCache _cache;
    private readonly CachedItemLoader _loader;
    private readonly PgLatestQueryService _latestQueries;
    private readonly QueryRuntimeStats _stats;
    private readonly ILogger<CachingItemRepository> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="CachingItemRepository"/> class.
    /// </summary>
    /// <param name="inner">The core item repository.</param>
    /// <param name="cache">The query result cache.</param>
    /// <param name="loader">The cached item loader.</param>
    /// <param name="latestQueries">The PostgreSQL Latest query optimisers.</param>
    /// <param name="stats">The runtime stats collector.</param>
    /// <param name="logger">The logger.</param>
    public CachingItemRepository(
        IItemRepository inner,
        IQueryResultCache cache,
        CachedItemLoader loader,
        PgLatestQueryService latestQueries,
        QueryRuntimeStats stats,
        ILogger<CachingItemRepository> logger)
    {
        _inner = inner;
        _cache = cache;
        _loader = loader;
        _latestQueries = latestQueries;
        _stats = stats;
        _logger = logger;
    }

    /// <inheritdoc/>
    public IReadOnlyList<BaseItem> GetLatestItemList(InternalItemsQuery filter, CollectionType collectionType)
    {
        var options = PgsqlQueryOptions.Current;
        if (!options.CacheActive || options.LatestTtl <= TimeSpan.Zero)
        {
            return GetLatestUncached(filter, collectionType);
        }

        var key = QueryCacheKeyBuilder.BuildLatestKey(filter, collectionType);
        if (key is null)
        {
            return GetLatestUncached(filter, collectionType);
        }

        if (_cache.TryGet(key, out var cachedIds))
        {
            var cached = _loader.LoadByIds(cachedIds, filter);
            if (cached is not null)
            {
                _stats.RecordLatestCacheLookup(hit: true);
                if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug("Latest {CollectionType} served from cache ({Count} items)", collectionType, cached.Count);
                }

                return cached;
            }
        }

        _stats.RecordLatestCacheLookup(hit: false);
        var result = GetLatestUncached(filter, collectionType);
        _cache.Set(key, result.Select(i => i.Id).ToArray(), options.LatestTtl);
        return result;
    }

    /// <inheritdoc/>
    public IReadOnlyList<BaseItem> GetItemList(InternalItemsQuery filter)
    {
        var options = PgsqlQueryOptions.Current;
        if (filter.IsResumable != true || !options.CacheActive || options.ResumeTtl <= TimeSpan.Zero)
        {
            return _inner.GetItemList(filter);
        }

        var key = QueryCacheKeyBuilder.BuildResumeKey(filter);
        if (key is null)
        {
            return _inner.GetItemList(filter);
        }

        if (_cache.TryGet(key, out var cachedIds))
        {
            var cached = _loader.LoadByIds(cachedIds, filter);
            if (cached is not null)
            {
                _stats.RecordResumeCacheLookup(hit: true);
                if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug("Resume list served from cache ({Count} items)", cached.Count);
                }

                return cached;
            }
        }

        _stats.RecordResumeCacheLookup(hit: false);
        var result = _inner.GetItemList(filter);
        _cache.Set(key, result.Select(i => i.Id).ToArray(), options.ResumeTtl);
        return result;
    }

    private IReadOnlyList<BaseItem> GetLatestUncached(InternalItemsQuery filter, CollectionType collectionType)
    {
        return _latestQueries.TryGetLatest(filter, collectionType)
            ?? _inner.GetLatestItemList(filter, collectionType);
    }

    /// <inheritdoc/>
    public BaseItem RetrieveItem(Guid id) => _inner.RetrieveItem(id);

    /// <inheritdoc/>
    public QueryResult<BaseItem> GetItems(InternalItemsQuery filter) => _inner.GetItems(filter);

    /// <inheritdoc/>
    public IReadOnlyList<Guid> GetItemIdsList(InternalItemsQuery filter) => _inner.GetItemIdsList(filter);

    /// <inheritdoc/>
    public Task<bool> ItemExistsAsync(Guid id) => _inner.ItemExistsAsync(id);

    /// <inheritdoc/>
    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetGenres(InternalItemsQuery filter) => _inner.GetGenres(filter);

    /// <inheritdoc/>
    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetMusicGenres(InternalItemsQuery filter) => _inner.GetMusicGenres(filter);

    /// <inheritdoc/>
    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetStudios(InternalItemsQuery filter) => _inner.GetStudios(filter);

    /// <inheritdoc/>
    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetArtists(InternalItemsQuery filter) => _inner.GetArtists(filter);

    /// <inheritdoc/>
    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetAlbumArtists(InternalItemsQuery filter) => _inner.GetAlbumArtists(filter);

    /// <inheritdoc/>
    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetAllArtists(InternalItemsQuery filter) => _inner.GetAllArtists(filter);

    /// <inheritdoc/>
    public IReadOnlyList<string> GetMusicGenreNames() => _inner.GetMusicGenreNames();

    /// <inheritdoc/>
    public IReadOnlyList<string> GetStudioNames() => _inner.GetStudioNames();

    /// <inheritdoc/>
    public IReadOnlyList<string> GetGenreNames() => _inner.GetGenreNames();

    /// <inheritdoc/>
    public IReadOnlyList<string> GetAllArtistNames() => _inner.GetAllArtistNames();

    /// <inheritdoc/>
    public QueryFiltersLegacy GetQueryFiltersLegacy(InternalItemsQuery filter) => _inner.GetQueryFiltersLegacy(filter);

    /// <inheritdoc/>
    public bool GetIsPlayed(User user, Guid id, bool recursive) => _inner.GetIsPlayed(user, id, recursive);
}
