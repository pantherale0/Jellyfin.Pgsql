using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Loads items for a cached ID list, preserving the cached order. Uses the same
/// navigation/deserialization pipeline as the core repository so DTO options behave identically.
/// </summary>
internal sealed class CachedItemLoader
{
    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IItemQueryHelpers _queryHelpers;
    private readonly ILogger _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="CachedItemLoader"/> class.
    /// </summary>
    /// <param name="dbProvider">The db context factory.</param>
    /// <param name="queryHelpers">The core query helpers.</param>
    /// <param name="logger">The logger.</param>
    public CachedItemLoader(IDbContextFactory<JellyfinDbContext> dbProvider, IItemQueryHelpers queryHelpers, ILogger logger)
    {
        _dbProvider = dbProvider;
        _queryHelpers = queryHelpers;
        _logger = logger;
    }

    /// <summary>
    /// Loads the given items in cached order. Items that no longer exist are skipped.
    /// </summary>
    /// <param name="ids">The cached IDs in result order.</param>
    /// <param name="filter">The live query filter (used for DTO/navigation options).</param>
    /// <returns>The loaded items, or <c>null</c> when loading failed and the caller should fall back.</returns>
    public IReadOnlyList<BaseItem>? LoadByIds(Guid[] ids, InternalItemsQuery filter)
    {
        if (ids.Length == 0)
        {
            return [];
        }

        return QueryFallback.TryDatabase(
            () => LoadByIdsCore(ids, filter),
            _logger,
            "Failed to load cached items; falling back to live query");
    }

    private List<BaseItem> LoadByIdsCore(Guid[] ids, InternalItemsQuery filter)
    {
        using var context = _dbProvider.CreateDbContext();
        var itemsById = _queryHelpers
            .ApplyNavigations(context.BaseItems.AsNoTracking().Where(e => ids.Contains(e.Id)), filter)
            .AsSplitQuery()
            .AsEnumerable()
            .Select(e => _queryHelpers.DeserializeBaseItem(e, filter.SkipDeserialization))
            .Where(item => item is not null)
            .ToDictionary(item => item!.Id);

        return ids
            .Where(itemsById.ContainsKey)
            .Select(id => itemsById[id]!)
            .ToList();
    }
}
