using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// PostgreSQL-optimised TV Latest query. Replaces the core "top series" selection
/// (EF GroupBy(SeriesName) + Max(DateCreated)) with a <c>DISTINCT ON</c> statement and then
/// ports the core container-selection logic (Season vs Series vs Episode) unchanged.
/// </summary>
/// <remarks>
/// The container-selection steps are a direct port of
/// <c>BaseItemRepository.GetLatestTvShowItems</c> (Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs).
/// Review this class whenever the core method changes during a Jellyfin sync.
/// </remarks>
internal sealed class PgLatestTvShowsQuery
{
    /// <summary>Episodes added within this window are considered "recently added together".</summary>
    private const double RecentAdditionWindowHours = 24.0;

    // DISTINCT ON picks the newest episode row per series (== the series' max DateCreated),
    // the outer query then ranks series by that date and applies the limit.
    private const string TopSeriesSqlTemplate = """
        SELECT x."SeriesName", x."DateCreated"
        FROM (
            SELECT DISTINCT ON (t."SeriesName") t."SeriesName", t."DateCreated"
            FROM ( /*INNER*/ ) t
            ORDER BY t."SeriesName", t."DateCreated" DESC NULLS LAST
        ) x
        ORDER BY x."DateCreated" DESC NULLS LAST
        """;

    private readonly IItemQueryHelpers _queryHelpers;
    private readonly IItemTypeLookup _itemTypeLookup;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgLatestTvShowsQuery"/> class.
    /// </summary>
    /// <param name="queryHelpers">The core query helpers.</param>
    /// <param name="itemTypeLookup">The item type lookup.</param>
    public PgLatestTvShowsQuery(IItemQueryHelpers queryHelpers, IItemTypeLookup itemTypeLookup)
    {
        _queryHelpers = queryHelpers;
        _itemTypeLookup = itemTypeLookup;
    }

    /// <summary>
    /// Executes the optimised TV latest query.
    /// </summary>
    /// <param name="context">The database context.</param>
    /// <param name="baseQuery">The filtered base query (PrepareItemQuery + TranslateQuery already applied).</param>
    /// <param name="filter">The query filter.</param>
    /// <returns>The latest TV items (Season/Series/Episode containers).</returns>
    public IReadOnlyList<BaseItem> GetLatest(JellyfinDbContext context, IQueryable<BaseItemEntity> baseQuery, InternalItemsQuery filter)
    {
        var limit = filter.Limit;

        // Step 1 (PG-optimised): top N series with recently added content, newest first.
        var topSeriesInner = baseQuery
            .Where(e => e.SeriesName != null)
            .Select(e => new { e.SeriesName, e.DateCreated });

        var topSeriesSql = TopSeriesSqlTemplate;
        var extraParameters = new Dictionary<string, object>();
        if (limit.HasValue)
        {
            topSeriesSql += "\nLIMIT @pgsql_limit";
            extraParameters["pgsql_limit"] = limit.Value;
        }

        var topSeriesData = PgQuerySqlBuilder.ExecuteWrapped(
            context,
            topSeriesInner,
            topSeriesSql,
            extraParameters,
            reader => (SeriesName: reader.GetString(0), MaxDate: reader.IsDBNull(1) ? (DateTime?)null : reader.GetDateTime(1)));

        if (topSeriesData.Count == 0)
        {
            return [];
        }

        var topSeriesNames = topSeriesData.ConvertAll(g => g.SeriesName);

        // Episodes before this cutoff cannot be in any series' "recent additions" window.
        var globalCutoff = topSeriesData.Min(g => g.MaxDate)?.AddHours(-RecentAdditionWindowHours);

        // Step 2: fetch candidate episodes for the top series (EF translates Contains to = ANY(@)).
        var episodeQuery = baseQuery.Where(e => e.SeriesName != null && topSeriesNames.Contains(e.SeriesName));
        if (globalCutoff is not null)
        {
            episodeQuery = episodeQuery.Where(e => e.DateCreated >= globalCutoff);
        }

        var allEpisodes = episodeQuery
            .OrderByDescending(e => e.DateCreated)
            .ThenByDescending(e => e.Id)
            .Select(e => new { e.Id, e.SeriesName, e.DateCreated, e.SeasonId, e.SeriesId })
            .AsEnumerable();

        var allSeasonIds = new HashSet<Guid>();
        var allSeriesIds = new HashSet<Guid>();

        var analysisData = new List<(
            int RecentEpisodeCount,
            List<Guid> SeasonIds,
            Guid? FirstRecentSeriesId,
            DateTime MaxDate,
            Guid MostRecentEpisodeId)>();

        // Step 3: analyze each series to identify recent additions within the time window.
        foreach (var episodes in allEpisodes.GroupBy(e => e.SeriesName).Select(group => group.ToList()))
        {
            var mostRecentDate = episodes[0].DateCreated ?? DateTime.MinValue;
            var recentCutoff = mostRecentDate.AddHours(-RecentAdditionWindowHours);

            var recentEpisodes = episodes.Where(ep => ep.DateCreated >= recentCutoff).ToList();
            var recentEpisodeCount = recentEpisodes.Count;
            var seasonIdSet = recentEpisodes
                .Where(ep => ep.SeasonId.HasValue)
                .Select(ep => ep.SeasonId!.Value)
                .ToHashSet();
            Guid? firstRecentSeriesId = recentEpisodes.Count > 0 ? recentEpisodes[0].SeriesId : null;

            var seasonIds = seasonIdSet.ToList();
            analysisData.Add((recentEpisodeCount, seasonIds, firstRecentSeriesId, mostRecentDate, episodes[0].Id));

            allSeasonIds.UnionWith(seasonIds);

            if (firstRecentSeriesId.HasValue)
            {
                allSeriesIds.Add(firstRecentSeriesId.Value);
            }
        }

        // Step 4: batch fetch counts (bounded ID sets after top-N selection).
        var episodeType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Episode];
        var seasonType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Season];
        var seasonEpisodeCounts = allSeasonIds.Count > 0
            ? context.BaseItems
                .AsNoTracking()
                .Where(e => e.SeasonId.HasValue && allSeasonIds.Contains(e.SeasonId.Value) && e.Type == episodeType)
                .GroupBy(e => e.SeasonId!.Value)
                .Select(g => new { SeasonId = g.Key, Count = g.Count() })
                .ToDictionary(x => x.SeasonId, x => x.Count)
            : [];

        var seriesSeasonCounts = allSeriesIds.Count > 0
            ? context.BaseItems
                .AsNoTracking()
                .Where(e => e.SeriesId.HasValue && allSeriesIds.Contains(e.SeriesId.Value) && e.Type == seasonType)
                .GroupBy(e => e.SeriesId!.Value)
                .Select(g => new { SeriesId = g.Key, Count = g.Count() })
                .ToDictionary(x => x.SeriesId, x => x.Count)
            : [];

        // Step 5: container selection per series (Season > Series > Episode).
        var entitiesToFetch = new HashSet<Guid>();
        var seriesResults = new List<(Guid? SeasonId, Guid? SeriesId, DateTime MaxDate, Guid MostRecentEpisodeId)>(analysisData.Count);

        foreach (var (recentEpisodeCount, seasonIds, firstRecentSeriesId, maxDate, mostRecentEpisodeId) in analysisData)
        {
            Guid? seasonId = null;
            Guid? seriesId = null;

            if (seasonIds.Count == 1)
            {
                var sid = seasonIds[0];
                var totalEpisodes = seasonEpisodeCounts.GetValueOrDefault(sid, 0);
                var totalSeasonsInSeries = firstRecentSeriesId.HasValue
                    ? seriesSeasonCounts.GetValueOrDefault(firstRecentSeriesId.Value, 1)
                    : 1;

                var hasMultipleOrAllEpisodes = recentEpisodeCount > 1 || recentEpisodeCount == totalEpisodes;

                if (totalSeasonsInSeries > 1 && hasMultipleOrAllEpisodes)
                {
                    seasonId = sid;
                    entitiesToFetch.Add(sid);
                }
                else if (hasMultipleOrAllEpisodes && firstRecentSeriesId.HasValue)
                {
                    seriesId = firstRecentSeriesId;
                    entitiesToFetch.Add(firstRecentSeriesId.Value);
                }
            }
            else if (seasonIds.Count > 1 && firstRecentSeriesId.HasValue)
            {
                seriesId = firstRecentSeriesId;
                entitiesToFetch.Add(seriesId!.Value);
            }

            if (seasonId is null && seriesId is null)
            {
                entitiesToFetch.Add(mostRecentEpisodeId);
            }

            seriesResults.Add((seasonId, seriesId, maxDate, mostRecentEpisodeId));
        }

        // Step 6: fetch the chosen entities with navigation properties.
        var entities = entitiesToFetch.Count > 0
            ? _queryHelpers.ApplyNavigations(
                    context.BaseItems.AsNoTracking().Where(e => entitiesToFetch.Contains(e.Id)),
                    filter)
                .AsSingleQuery()
                .ToDictionary(e => e.Id)
            : [];

        // Step 7: build final results, preferring Season > Series > Episode.
        var results = new List<(BaseItemEntity Entity, DateTime MaxDate)>(seriesResults.Count);
        foreach (var (seasonId, seriesId, maxDate, mostRecentEpisodeId) in seriesResults)
        {
            if (seasonId.HasValue && entities.TryGetValue(seasonId.Value, out var seasonEntity))
            {
                results.Add((seasonEntity, maxDate));
                continue;
            }

            if (seriesId.HasValue && entities.TryGetValue(seriesId.Value, out var seriesEntity))
            {
                results.Add((seriesEntity, maxDate));
                continue;
            }

            if (entities.TryGetValue(mostRecentEpisodeId, out var episodeEntity))
            {
                results.Add((episodeEntity, maxDate));
            }
        }

        IEnumerable<(BaseItemEntity Entity, DateTime MaxDate)> finalResults = results
            .OrderByDescending(r => r.MaxDate)
            .ThenByDescending(r => r.Entity.Id);

        if (limit.HasValue)
        {
            finalResults = finalResults.Take(limit.Value);
        }

        return finalResults
            .Select(r => _queryHelpers.DeserializeBaseItem(r.Entity, filter.SkipDeserialization))
            .Where(dto => dto is not null)
            .ToArray()!;
    }
}
