using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// PostgreSQL-optimised NextUp batch query. Replaces core's "load all played/unplayed
/// candidates then pick in memory" with <c>DISTINCT ON</c> ID selection, then hydrates
/// only the winning episode IDs.
/// </summary>
internal sealed class PgNextUpQuery
{
    // Selects last-watched (by season/episode) and next-unplayed per series in one statement.
    // /*INNER*/ is the access-filtered episode projection (non-special episodes for seriesKeys).
    private const string BatchSqlTemplate = """
        WITH episodes AS (
            /*INNER*/
        ),
        played AS (
            SELECT e."Id", e."SeriesPresentationUniqueKey", e."ParentIndexNumber", e."IndexNumber", ud."LastPlayedDate"
            FROM episodes e
            INNER JOIN "UserData" ud
                ON ud."ItemId" = e."Id"
                AND ud."UserId" = @pgsql_user_id
                AND ud."Played"
                AND ud."ItemId" <> @pgsql_placeholder_id
        ),
        last_watched AS (
            SELECT DISTINCT ON ("SeriesPresentationUniqueKey")
                "SeriesPresentationUniqueKey",
                "Id",
                "ParentIndexNumber",
                "IndexNumber"
            FROM played
            ORDER BY "SeriesPresentationUniqueKey", "ParentIndexNumber" DESC NULLS LAST, "IndexNumber" DESC NULLS LAST
        ),
        unplayed AS (
            SELECT e."Id", e."SeriesPresentationUniqueKey", e."ParentIndexNumber", e."IndexNumber"
            FROM episodes e
            WHERE e."IsVirtualItem" = FALSE
              AND NOT EXISTS (
                  SELECT 1
                  FROM "UserData" ud
                  WHERE ud."ItemId" = e."Id"
                    AND ud."UserId" = @pgsql_user_id
                    AND ud."Played"
                    AND ud."ItemId" <> @pgsql_placeholder_id
              )
        ),
        next_up AS (
            SELECT DISTINCT ON (u."SeriesPresentationUniqueKey")
                u."SeriesPresentationUniqueKey",
                u."Id" AS "NextId"
            FROM unplayed u
            LEFT JOIN last_watched lw
                ON lw."SeriesPresentationUniqueKey" = u."SeriesPresentationUniqueKey"
            WHERE lw."Id" IS NULL
               OR lw."ParentIndexNumber" IS NULL
               OR lw."IndexNumber" IS NULL
               OR (u."ParentIndexNumber", COALESCE(u."IndexNumber", -1))
                    > (lw."ParentIndexNumber", COALESCE(lw."IndexNumber", -1))
            ORDER BY u."SeriesPresentationUniqueKey", u."ParentIndexNumber" ASC NULLS LAST, u."IndexNumber" ASC NULLS LAST
        )
        SELECT
            COALESCE(lw."SeriesPresentationUniqueKey", n."SeriesPresentationUniqueKey") AS "SeriesKey",
            lw."Id" AS "LastWatchedId",
            n."NextId" AS "NextUpId"
        FROM last_watched lw
        FULL OUTER JOIN next_up n
            ON n."SeriesPresentationUniqueKey" = lw."SeriesPresentationUniqueKey"
        """;

    private const string RewatchSqlTemplate = """
        WITH episodes AS (
            /*INNER*/
        ),
        played AS (
            SELECT e."Id", e."SeriesPresentationUniqueKey", e."ParentIndexNumber", e."IndexNumber", ud."LastPlayedDate"
            FROM episodes e
            INNER JOIN "UserData" ud
                ON ud."ItemId" = e."Id"
                AND ud."UserId" = @pgsql_user_id
                AND ud."Played"
                AND ud."ItemId" <> @pgsql_placeholder_id
            WHERE e."IsVirtualItem" = FALSE
        ),
        last_by_date AS (
            SELECT DISTINCT ON ("SeriesPresentationUniqueKey")
                "SeriesPresentationUniqueKey",
                "Id",
                "ParentIndexNumber",
                "IndexNumber"
            FROM played
            ORDER BY "SeriesPresentationUniqueKey", "LastPlayedDate" DESC NULLS LAST
        ),
        next_played AS (
            SELECT DISTINCT ON (p."SeriesPresentationUniqueKey")
                p."SeriesPresentationUniqueKey",
                p."Id" AS "NextPlayedId"
            FROM played p
            INNER JOIN last_by_date ld
                ON ld."SeriesPresentationUniqueKey" = p."SeriesPresentationUniqueKey"
            WHERE ld."ParentIndexNumber" IS NULL
               OR ld."IndexNumber" IS NULL
               OR (p."ParentIndexNumber", COALESCE(p."IndexNumber", -1))
                    > (ld."ParentIndexNumber", COALESCE(ld."IndexNumber", -1))
            ORDER BY p."SeriesPresentationUniqueKey", p."ParentIndexNumber" ASC NULLS LAST, p."IndexNumber" ASC NULLS LAST
        )
        SELECT
            ld."SeriesPresentationUniqueKey" AS "SeriesKey",
            ld."Id" AS "LastWatchedForRewatchingId",
            np."NextPlayedId" AS "NextPlayedForRewatchingId"
        FROM last_by_date ld
        LEFT JOIN next_played np
            ON np."SeriesPresentationUniqueKey" = ld."SeriesPresentationUniqueKey"
        """;

    /// <summary>
    /// Placeholder UserData item id used by core repositories for detached rows.
    /// </summary>
    private static readonly Guid PlaceholderId = Guid.Parse("00000000-0000-0000-0000-000000000001");

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IItemQueryHelpers _queryHelpers;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly CachedItemLoader _loader;
    private readonly QueryRuntimeStats _stats;
    private readonly ILogger _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgNextUpQuery"/> class.
    /// </summary>
    /// <param name="dbProvider">The db context factory.</param>
    /// <param name="queryHelpers">The core query helpers.</param>
    /// <param name="itemTypeLookup">The item type lookup.</param>
    /// <param name="loader">The item loader used to materialize winners.</param>
    /// <param name="stats">The runtime stats collector.</param>
    /// <param name="logger">The logger.</param>
    public PgNextUpQuery(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IItemQueryHelpers queryHelpers,
        IItemTypeLookup itemTypeLookup,
        CachedItemLoader loader,
        QueryRuntimeStats stats,
        ILogger logger)
    {
        _dbProvider = dbProvider;
        _queryHelpers = queryHelpers;
        _itemTypeLookup = itemTypeLookup;
        _loader = loader;
        _stats = stats;
        _logger = logger;
    }

    /// <summary>
    /// Attempts a PostgreSQL-optimised NextUp batch. Returns <c>null</c> when disabled or on failure.
    /// </summary>
    /// <param name="filter">The query filter.</param>
    /// <param name="seriesKeys">Series presentation keys to resolve.</param>
    /// <param name="includeSpecials">Whether to include specials.</param>
    /// <param name="includeWatchedForRewatching">Whether to include rewatch candidates.</param>
    /// <returns>The batch result, or <c>null</c> to fall back to core.</returns>
    public IReadOnlyDictionary<string, NextUpEpisodeBatchResult>? TryGetBatch(
        InternalItemsQuery filter,
        IReadOnlyList<string> seriesKeys,
        bool includeSpecials,
        bool includeWatchedForRewatching)
    {
        if (!PgsqlQueryOptions.Current.OptimizeNextUp || seriesKeys.Count == 0 || filter.User is null)
        {
            return null;
        }

        return QueryFallback.TryDatabase(
            () => ExecuteBatch(filter, seriesKeys, includeSpecials, includeWatchedForRewatching),
            _logger,
            "PostgreSQL-optimised NextUp batch failed; falling back to core implementation",
            onFailure: _stats.RecordOptimizedNextUpFailure);
    }

    private Dictionary<string, NextUpEpisodeBatchResult> ExecuteBatch(
        InternalItemsQuery filter,
        IReadOnlyList<string> seriesKeys,
        bool includeSpecials,
        bool includeWatchedForRewatching)
    {
        _stats.RecordOptimizedNextUpRun();
        _queryHelpers.PrepareFilterQuery(filter);

        using var context = _dbProvider.CreateDbContext();
        var userId = filter.User!.Id;
        var episodeTypeName = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Episode];

        var episodesBase = context.BaseItems
            .AsNoTracking()
            .Where(e => e.Type == episodeTypeName)
            .Where(e => e.SeriesPresentationUniqueKey != null && seriesKeys.Contains(e.SeriesPresentationUniqueKey))
            .Where(e => e.ParentIndexNumber != 0);
        episodesBase = _queryHelpers.ApplyAccessFiltering(context, episodesBase, filter);

        var episodesInner = episodesBase.Select(e => new
        {
            e.Id,
            e.SeriesPresentationUniqueKey,
            e.ParentIndexNumber,
            e.IndexNumber,
            e.IsVirtualItem
        });

        var extraParameters = new Dictionary<string, object>
        {
            ["pgsql_user_id"] = userId,
            ["pgsql_placeholder_id"] = PlaceholderId,
        };

        var batchRows = PgQuerySqlBuilder.ExecuteWrapped(
            context,
            episodesInner,
            BatchSqlTemplate,
            extraParameters,
            reader => (
                SeriesKey: reader.GetString(0),
                LastWatchedId: reader.IsDBNull(1) ? (Guid?)null : reader.GetGuid(1),
                NextUpId: reader.IsDBNull(2) ? (Guid?)null : reader.GetGuid(2)));

        Dictionary<string, (Guid? LastRewatchId, Guid? NextPlayedId)> rewatchByKey = new(StringComparer.Ordinal);
        if (includeWatchedForRewatching)
        {
            var rewatchRows = PgQuerySqlBuilder.ExecuteWrapped(
                context,
                episodesInner,
                RewatchSqlTemplate,
                extraParameters,
                reader => (
                    SeriesKey: reader.GetString(0),
                    LastRewatchId: reader.IsDBNull(1) ? (Guid?)null : reader.GetGuid(1),
                    NextPlayedId: reader.IsDBNull(2) ? (Guid?)null : reader.GetGuid(2)));

            foreach (var row in rewatchRows)
            {
                rewatchByKey[row.SeriesKey] = (row.LastRewatchId, row.NextPlayedId);
            }
        }

        Dictionary<string, List<Guid>> specialIdsByKey = new(StringComparer.Ordinal);
        if (includeSpecials)
        {
            var specialsQuery = context.BaseItems
                .AsNoTracking()
                .Where(e => e.Type == episodeTypeName)
                .Where(e => e.SeriesPresentationUniqueKey != null && seriesKeys.Contains(e.SeriesPresentationUniqueKey))
                .Where(e => e.ParentIndexNumber == 0)
                .Where(e => !e.IsVirtualItem);
            specialsQuery = _queryHelpers.ApplyAccessFiltering(context, specialsQuery, filter);

            foreach (var row in specialsQuery.Select(e => new { e.Id, e.SeriesPresentationUniqueKey }))
            {
                var key = row.SeriesPresentationUniqueKey!;
                if (!specialIdsByKey.TryGetValue(key, out var list))
                {
                    list = [];
                    specialIdsByKey[key] = list;
                }

                list.Add(row.Id);
            }
        }

        var batchByKey = batchRows.ToDictionary(r => r.SeriesKey, StringComparer.Ordinal);

        var allIds = new HashSet<Guid>();
        foreach (var seriesKey in seriesKeys)
        {
            if (batchByKey.TryGetValue(seriesKey, out var row))
            {
                if (row.LastWatchedId.HasValue)
                {
                    allIds.Add(row.LastWatchedId.Value);
                }

                if (row.NextUpId.HasValue)
                {
                    allIds.Add(row.NextUpId.Value);
                }
            }

            if (rewatchByKey.TryGetValue(seriesKey, out var rewatch))
            {
                if (rewatch.LastRewatchId.HasValue)
                {
                    allIds.Add(rewatch.LastRewatchId.Value);
                }

                if (rewatch.NextPlayedId.HasValue)
                {
                    allIds.Add(rewatch.NextPlayedId.Value);
                }
            }

            if (specialIdsByKey.TryGetValue(seriesKey, out var specialIds))
            {
                foreach (var id in specialIds)
                {
                    allIds.Add(id);
                }
            }
        }

        var loaded = _loader.LoadByIds(allIds.ToArray(), filter)
            ?? throw new InvalidOperationException("Failed to hydrate NextUp episode IDs.");
        var itemsById = loaded.ToDictionary(i => i.Id);

        var result = new Dictionary<string, NextUpEpisodeBatchResult>(seriesKeys.Count, StringComparer.Ordinal);
        foreach (var seriesKey in seriesKeys)
        {
            var batch = new NextUpEpisodeBatchResult();

            if (batchByKey.TryGetValue(seriesKey, out var row))
            {
                if (row.LastWatchedId.HasValue && itemsById.TryGetValue(row.LastWatchedId.Value, out var lastWatched))
                {
                    batch.LastWatched = lastWatched;
                }

                if (row.NextUpId.HasValue && itemsById.TryGetValue(row.NextUpId.Value, out var nextUp))
                {
                    batch.NextUp = nextUp;
                }
            }

            if (includeSpecials && specialIdsByKey.TryGetValue(seriesKey, out var specialIds))
            {
                batch.Specials = specialIds
                    .Where(itemsById.ContainsKey)
                    .Select(id => itemsById[id])
                    .ToList();
            }
            else
            {
                batch.Specials = Array.Empty<BaseItem>();
            }

            if (includeWatchedForRewatching && rewatchByKey.TryGetValue(seriesKey, out var rewatch))
            {
                if (rewatch.LastRewatchId.HasValue
                    && itemsById.TryGetValue(rewatch.LastRewatchId.Value, out var lastRewatch))
                {
                    batch.LastWatchedForRewatching = lastRewatch;
                }

                if (rewatch.NextPlayedId.HasValue
                    && itemsById.TryGetValue(rewatch.NextPlayedId.Value, out var nextPlayed))
                {
                    batch.NextPlayedForRewatching = nextPlayed;
                }
            }

            result[seriesKey] = batch;
        }

        return result;
    }
}
