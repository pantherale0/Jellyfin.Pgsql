using System;
using System.Collections.Generic;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Routes Latest item queries to PostgreSQL-optimised implementations per collection type.
/// Any failure falls back to the core repository (callers receive <c>null</c>).
/// </summary>
internal sealed class PgLatestQueryService
{
    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IItemQueryHelpers _queryHelpers;
    private readonly PgLatestMoviesQuery _moviesQuery;
    private readonly PgLatestTvShowsQuery _tvShowsQuery;
    private readonly PgLatestMusicQuery _musicQuery;
    private readonly QueryRuntimeStats _stats;
    private readonly ILogger _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgLatestQueryService"/> class.
    /// </summary>
    /// <param name="dbProvider">The db context factory.</param>
    /// <param name="queryHelpers">The core query helpers.</param>
    /// <param name="moviesQuery">The movies optimiser.</param>
    /// <param name="tvShowsQuery">The TV optimiser.</param>
    /// <param name="musicQuery">The music optimiser.</param>
    /// <param name="stats">The runtime stats collector.</param>
    /// <param name="logger">The logger.</param>
    public PgLatestQueryService(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IItemQueryHelpers queryHelpers,
        PgLatestMoviesQuery moviesQuery,
        PgLatestTvShowsQuery tvShowsQuery,
        PgLatestMusicQuery musicQuery,
        QueryRuntimeStats stats,
        ILogger logger)
    {
        _dbProvider = dbProvider;
        _queryHelpers = queryHelpers;
        _moviesQuery = moviesQuery;
        _tvShowsQuery = tvShowsQuery;
        _musicQuery = musicQuery;
        _stats = stats;
        _logger = logger;
    }

    /// <summary>
    /// Attempts to execute a PostgreSQL-optimised Latest query.
    /// </summary>
    /// <param name="filter">The query filter.</param>
    /// <param name="collectionType">The collection type.</param>
    /// <returns>The result list, or <c>null</c> when the optimiser is disabled or failed
    /// and the caller should use the core implementation.</returns>
    public IReadOnlyList<BaseItem>? TryGetLatest(InternalItemsQuery filter, CollectionType collectionType)
    {
        var options = PgsqlQueryOptions.Current;
        var enabled = collectionType switch
        {
            CollectionType.movies => options.OptimizeMoviesLatest,
            CollectionType.tvshows => options.OptimizeTvLatest,
            CollectionType.music => options.OptimizeMusicLatest,
            _ => false,
        };

        if (!enabled)
        {
            return null;
        }

        try
        {
            _stats.RecordOptimizedLatestRun();
            _queryHelpers.PrepareFilterQuery(filter);

            using var context = _dbProvider.CreateDbContext();
            var baseQuery = _queryHelpers.PrepareItemQuery(context, filter);
            baseQuery = _queryHelpers.TranslateQuery(baseQuery, context, filter);

            return collectionType switch
            {
                CollectionType.movies => _moviesQuery.GetLatest(context, baseQuery, filter),
                CollectionType.tvshows => _tvShowsQuery.GetLatest(context, baseQuery, filter),
                CollectionType.music => _musicQuery.GetLatest(context, baseQuery, filter),
                _ => null,
            };
        }
#pragma warning disable CA1031 // Optimiser failures must fall back to the core query.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            _stats.RecordOptimizedLatestFailure();
            _logger.LogWarning(ex, "PostgreSQL-optimised {CollectionType} Latest query failed; falling back to core implementation", collectionType);
            return null;
        }
    }
}
