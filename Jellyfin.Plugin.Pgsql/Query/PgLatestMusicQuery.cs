using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// PostgreSQL-optimised Music Latest query. Replaces the core EF join of AncestorIds
/// against the full filtered track query with a flattened subquery join, letting the
/// planner deduplicate album IDs before ranking. Mirrors the music branch of
/// BaseItemRepository.GetLatestItemList: albums that contain any track matching the
/// user's filter, newest first.
/// </summary>
internal sealed class PgLatestMusicQuery
{
    private const string OuterSqlTemplate = """
        SELECT b."Id"
        FROM "BaseItems" b
        WHERE b."Type" = @pgsql_albumType
          AND b."Id" IN (
              SELECT DISTINCT ai."ParentItemId"
              FROM "AncestorIds" ai
              INNER JOIN ( /*INNER*/ ) f ON f."Id" = ai."ItemId"
          )
        ORDER BY b."DateCreated" DESC, b."Id" DESC
        """;

    private readonly CachedItemLoader _loader;
    private readonly IItemTypeLookup _itemTypeLookup;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgLatestMusicQuery"/> class.
    /// </summary>
    /// <param name="loader">The item loader used to materialize results.</param>
    /// <param name="itemTypeLookup">The item type lookup.</param>
    public PgLatestMusicQuery(CachedItemLoader loader, IItemTypeLookup itemTypeLookup)
    {
        _loader = loader;
        _itemTypeLookup = itemTypeLookup;
    }

    /// <summary>
    /// Executes the optimised music latest query.
    /// </summary>
    /// <param name="context">The database context.</param>
    /// <param name="baseQuery">The filtered base query (PrepareItemQuery + TranslateQuery already applied).</param>
    /// <param name="filter">The query filter.</param>
    /// <returns>The latest music albums, or <c>null</c> when loading failed.</returns>
    public IReadOnlyList<BaseItem>? GetLatest(JellyfinDbContext context, IQueryable<BaseItemEntity> baseQuery, InternalItemsQuery filter)
    {
        var innerQuery = baseQuery.Select(e => new { e.Id });

        var sql = OuterSqlTemplate;
        var extraParameters = new Dictionary<string, object>
        {
            ["pgsql_albumType"] = _itemTypeLookup.BaseItemKindNames[BaseItemKind.MusicAlbum]!,
        };

        if (filter.Limit.HasValue)
        {
            sql += "\nLIMIT @pgsql_limit";
            extraParameters["pgsql_limit"] = filter.Limit.Value;
        }

        var ids = PgQuerySqlBuilder.ExecuteWrapped(
            context,
            innerQuery,
            sql,
            extraParameters,
            reader => reader.GetGuid(0));

        return _loader.LoadByIds(ids.ToArray(), filter);
    }
}
