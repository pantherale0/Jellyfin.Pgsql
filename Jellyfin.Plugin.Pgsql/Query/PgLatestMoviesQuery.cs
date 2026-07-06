using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// PostgreSQL-optimised Movies Latest query. Replaces the core EF pattern
/// (GroupBy(PresentationUniqueKey) + nested Max/OrderBy/First, which EF translates to
/// correlated subqueries per group) with a single <c>DISTINCT ON</c> statement.
/// Mirrors the movies branch of BaseItemRepository.GetLatestItemList.
/// </summary>
internal sealed class PgLatestMoviesQuery
{
    // DISTINCT ON picks the newest row per presentation key (matching the core
    // OrderByDescending(DateCreated).ThenByDescending(Id).First() selection), then the
    // outer query orders groups by that row's DateCreated (== the group's max date).
    private const string OuterSqlTemplate = """
        SELECT x."Id"
        FROM (
            SELECT DISTINCT ON (t."PresentationUniqueKey") t."Id", t."DateCreated"
            FROM ( /*INNER*/ ) t
            ORDER BY t."PresentationUniqueKey", t."DateCreated" DESC, t."Id" DESC
        ) x
        ORDER BY x."DateCreated" DESC, x."Id" DESC
        """;

    private readonly CachedItemLoader _loader;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgLatestMoviesQuery"/> class.
    /// </summary>
    /// <param name="loader">The item loader used to materialize results.</param>
    public PgLatestMoviesQuery(CachedItemLoader loader)
    {
        _loader = loader;
    }

    /// <summary>
    /// Executes the optimised movies latest query.
    /// </summary>
    /// <param name="context">The database context.</param>
    /// <param name="baseQuery">The filtered base query (PrepareItemQuery + TranslateQuery already applied).</param>
    /// <param name="filter">The query filter.</param>
    /// <returns>The latest movie items, or <c>null</c> when loading failed.</returns>
    public IReadOnlyList<BaseItem>? GetLatest(JellyfinDbContext context, IQueryable<BaseItemEntity> baseQuery, InternalItemsQuery filter)
    {
        var innerQuery = baseQuery
            .Where(e => e.PresentationUniqueKey != null)
            .Select(e => new { e.Id, e.PresentationUniqueKey, e.DateCreated });

        var sql = OuterSqlTemplate;
        var extraParameters = new Dictionary<string, object>();
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
