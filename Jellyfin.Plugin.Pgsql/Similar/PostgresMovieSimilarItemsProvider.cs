using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using BaseItemDto = MediaBrowser.Controller.Entities.BaseItem;
using DbLinkedChildType = Jellyfin.Database.Implementations.Entities.LinkedChildType;

namespace Jellyfin.Plugin.Pgsql.Similar;

/// <summary>
/// PostgreSQL-backed similar items for movies/trailers with franchise-first ranking:
/// same BoxSet, then title-franchise overlap, then genre/tag/studio/people weights.
/// </summary>
public sealed class PostgresMovieSimilarItemsProvider :
    ILocalSimilarItemsProvider<Movie>,
    ILocalSimilarItemsProvider<Trailer>,
    IBatchLocalSimilarItemsProvider
{
    private const int MaxBatchSourceItems = 64;

    private static readonly (ItemValueType Type, int Weight)[] ItemValueDimensions =
    [
        (ItemValueType.Genre, MovieSimilarityWeights.GenreWeight),
        (ItemValueType.Tags, MovieSimilarityWeights.TagWeight),
        (ItemValueType.Studios, MovieSimilarityWeights.StudioWeight)
    ];

    private static readonly Dictionary<string, int> PersonTypeWeights = new(StringComparer.Ordinal)
    {
        [nameof(PersonKind.Director)] = MovieSimilarityWeights.DirectorWeight,
        [nameof(PersonKind.Actor)] = MovieSimilarityWeights.ActorWeight,
        [nameof(PersonKind.GuestStar)] = MovieSimilarityWeights.ActorWeight,
    };

    private static readonly string[] ScoredPersonTypes = [.. PersonTypeWeights.Keys];

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IItemQueryHelpers _queryHelpers;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly IServerConfigurationManager _serverConfigurationManager;

    /// <summary>
    /// Initializes a new instance of the <see cref="PostgresMovieSimilarItemsProvider"/> class.
    /// </summary>
    /// <param name="dbProvider">The database context factory.</param>
    /// <param name="queryHelpers">Shared item query helpers.</param>
    /// <param name="itemTypeLookup">Base item type name lookup.</param>
    /// <param name="serverConfigurationManager">Server configuration.</param>
    public PostgresMovieSimilarItemsProvider(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IItemQueryHelpers queryHelpers,
        IItemTypeLookup itemTypeLookup,
        IServerConfigurationManager serverConfigurationManager)
    {
        _dbProvider = dbProvider;
        _queryHelpers = queryHelpers;
        _itemTypeLookup = itemTypeLookup;
        _serverConfigurationManager = serverConfigurationManager;
    }

    /// <inheritdoc/>
    public string Name => "PostgreSQL Similarity";

    /// <inheritdoc/>
    public MetadataPluginType Type => MetadataPluginType.LocalSimilarityProvider;

    /// <inheritdoc/>
    public async Task<IReadOnlyList<BaseItemDto>> GetSimilarItemsAsync(
        Movie item,
        SimilarItemsQuery query,
        CancellationToken cancellationToken)
    {
        var results = await GetBatchSimilarItemsAsync([item], query, cancellationToken).ConfigureAwait(false);
        return results.TryGetValue(item.Id, out var items) ? items : [];
    }

    /// <inheritdoc/>
    public async Task<IReadOnlyList<BaseItemDto>> GetSimilarItemsAsync(
        Trailer item,
        SimilarItemsQuery query,
        CancellationToken cancellationToken)
    {
        var results = await GetBatchSimilarItemsAsync([item], query, cancellationToken).ConfigureAwait(false);
        return results.TryGetValue(item.Id, out var items) ? items : [];
    }

    bool ILocalSimilarItemsProvider.Supports(Type itemType)
        => typeof(Movie).IsAssignableFrom(itemType) || typeof(Trailer).IsAssignableFrom(itemType);

    Task<IReadOnlyList<BaseItem>> ILocalSimilarItemsProvider.GetSimilarItemsAsync(
        BaseItem item,
        SimilarItemsQuery query,
        CancellationToken cancellationToken)
        => item switch
        {
            Movie movie => GetSimilarItemsAsync(movie, query, cancellationToken),
            Trailer trailer => GetSimilarItemsAsync(trailer, query, cancellationToken),
            _ => throw new ArgumentException($"Unsupported item type {item.GetType()}", nameof(item))
        };

    /// <inheritdoc/>
    public async Task<Dictionary<Guid, IReadOnlyList<BaseItemDto>>> GetBatchSimilarItemsAsync(
        IReadOnlyList<BaseItemDto> sourceItems,
        SimilarItemsQuery query,
        CancellationToken cancellationToken)
    {
        var includeItemTypes = new List<BaseItemKind> { BaseItemKind.Movie };
        if (_serverConfigurationManager.Configuration.EnableExternalContentInSuggestions)
        {
            includeItemTypes.Add(BaseItemKind.Trailer);
            includeItemTypes.Add(BaseItemKind.LiveTvProgram);
        }

        var limit = query.Limit ?? 50;
        var dtoOptions = query.DtoOptions ?? new DtoOptions();

        if (sourceItems.Count > MaxBatchSourceItems)
        {
            sourceItems = sourceItems.Take(MaxBatchSourceItems).ToList();
        }

        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var sourceIds = sourceItems.Select(i => i.Id).ToList();
            var perSourceScores = await ComputeBatchScoresAsync(sourceIds, context, cancellationToken)
                .ConfigureAwait(false);

            var allCandidateIds = new HashSet<Guid>();
            foreach (var (_, scores) in perSourceScores)
            {
                allCandidateIds.UnionWith(
                    scores.OrderByDescending(kvp => kvp.Value)
                        .Take(limit * 3)
                        .Select(kvp => kvp.Key));
            }

            var result = new Dictionary<Guid, IReadOnlyList<BaseItemDto>>();
            if (allCandidateIds.Count == 0)
            {
                return result;
            }

            var filter = new InternalItemsQuery(query.User)
            {
                IncludeItemTypes = [.. includeItemTypes],
                ExcludeItemIds = [.. query.ExcludeItemIds],
                DtoOptions = dtoOptions,
                EnableGroupByMetadataKey = true,
                EnableTotalRecordCount = false,
                IsMovie = true,
                IsPlayed = false
            };

            _queryHelpers.PrepareFilterQuery(filter);
            var baseQuery = _queryHelpers.PrepareItemQuery(context, filter);
            baseQuery = _queryHelpers.TranslateQuery(baseQuery, context, filter);

            var allCandidateIdsList = allCandidateIds.ToList();
            var accessibleItems = await baseQuery
                .WhereOneOrMany(allCandidateIdsList, e => e.Id)
                .Select(e => new
                {
                    e.Id,
                    e.PresentationUniqueKey,
                    e.ProductionYear,
                    e.SortName
                })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            var allOrderedIds = new HashSet<Guid>();
            var perSourceOrderedIds = new Dictionary<Guid, List<Guid>>();

            foreach (var item in sourceItems)
            {
                if (!perSourceScores.TryGetValue(item.Id, out var scores))
                {
                    continue;
                }

                var orderedIds = accessibleItems
                    .Where(x => scores.ContainsKey(x.Id))
                    .OrderByDescending(x => scores.GetValueOrDefault(x.Id))
                    .ThenBy(x => x.ProductionYear ?? int.MaxValue)
                    .ThenBy(x => x.SortName ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                    .DistinctBy(x => x.PresentationUniqueKey)
                    .Take(limit)
                    .Select(x => x.Id)
                    .ToList();

                if (orderedIds.Count > 0)
                {
                    perSourceOrderedIds[item.Id] = orderedIds;
                    allOrderedIds.UnionWith(orderedIds);
                }
            }

            if (allOrderedIds.Count == 0)
            {
                return result;
            }

            var allOrderedIdsList = allOrderedIds.ToList();
            var entities = await _queryHelpers.ApplyNavigations(
                    context.BaseItems.AsNoTracking().WhereOneOrMany(allOrderedIdsList, e => e.Id),
                    filter)
                .AsSplitQuery()
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            var entitiesById = entities
                .Select(e => _queryHelpers.DeserializeBaseItem(e, filter.SkipDeserialization))
                .Where(dto => dto is not null)
                .ToDictionary(i => i!.Id);

            foreach (var (sourceId, orderedIds) in perSourceOrderedIds)
            {
                var items = orderedIds
                    .Where(entitiesById.ContainsKey)
                    .Select(id => entitiesById[id]!)
                    .ToList();

                if (items.Count > 0)
                {
                    result[sourceId] = items;
                }
            }

            return result;
        }
    }

    /// <summary>
    /// Computes per-source similarity scores. Exposed for integration tests.
    /// </summary>
    /// <param name="sourceIds">Source item IDs.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Per-source map of candidate ID → score.</returns>
    public async Task<Dictionary<Guid, Dictionary<Guid, int>>> ComputeBatchScoresAsync(
        IReadOnlyList<Guid> sourceIds,
        CancellationToken cancellationToken)
    {
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            return await ComputeBatchScoresAsync(sourceIds.ToList(), context, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task<Dictionary<Guid, Dictionary<Guid, int>>> ComputeBatchScoresAsync(
        List<Guid> sourceIds,
        JellyfinDbContext context,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<Guid, Dictionary<Guid, int>>();
        foreach (var id in sourceIds)
        {
            result[id] = [];
        }

        await ApplyCollectionScoresAsync(sourceIds, context, result, cancellationToken).ConfigureAwait(false);
        await ApplyTitleFranchiseScoresAsync(sourceIds, context, result, cancellationToken).ConfigureAwait(false);
        await ApplyItemValueScoresAsync(sourceIds, context, result, cancellationToken).ConfigureAwait(false);
        await ApplyPersonScoresAsync(sourceIds, context, result, cancellationToken).ConfigureAwait(false);

        foreach (var sourceId in sourceIds)
        {
            var scoreMap = result[sourceId];
            scoreMap.Remove(sourceId);
            if (scoreMap.Count == 0)
            {
                result.Remove(sourceId);
            }
        }

        return result;
    }

    private async Task ApplyCollectionScoresAsync(
        List<Guid> sourceIds,
        JellyfinDbContext context,
        Dictionary<Guid, Dictionary<Guid, int>> result,
        CancellationToken cancellationToken)
    {
        var boxSetTypeName = _itemTypeLookup.BaseItemKindNames[BaseItemKind.BoxSet];

        var sourceBoxSets = await context.LinkedChildren.AsNoTracking()
            .Where(lc => sourceIds.Contains(lc.ChildId) && lc.ChildType == DbLinkedChildType.Manual)
            .Join(
                context.BaseItems.AsNoTracking().Where(bs => bs.Type == boxSetTypeName),
                lc => lc.ParentId,
                bs => bs.Id,
                (lc, bs) => new { SourceId = lc.ChildId, BoxSetId = lc.ParentId })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        if (sourceBoxSets.Count == 0)
        {
            return;
        }

        var boxSetIds = sourceBoxSets.Select(x => x.BoxSetId).Distinct().ToList();
        var mates = await context.LinkedChildren.AsNoTracking()
            .Where(lc => boxSetIds.Contains(lc.ParentId) && lc.ChildType == DbLinkedChildType.Manual)
            .Select(lc => new { lc.ParentId, MateId = lc.ChildId })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var matesByBoxSet = mates
            .GroupBy(m => m.ParentId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.MateId).ToList());

        foreach (var group in sourceBoxSets.GroupBy(x => x.SourceId))
        {
            var scoreMap = result[group.Key];
            foreach (var boxSetId in group.Select(x => x.BoxSetId).Distinct())
            {
                if (!matesByBoxSet.TryGetValue(boxSetId, out var mateIds))
                {
                    continue;
                }

                foreach (var mateId in mateIds)
                {
                    if (mateId == group.Key)
                    {
                        continue;
                    }

                    // Max so multi-collection membership does not stack unboundedly.
                    var current = scoreMap.GetValueOrDefault(mateId);
                    if (current < MovieSimilarityWeights.CollectionWeight)
                    {
                        scoreMap[mateId] = MovieSimilarityWeights.CollectionWeight;
                    }
                }
            }
        }
    }

    private async Task ApplyTitleFranchiseScoresAsync(
        List<Guid> sourceIds,
        JellyfinDbContext context,
        Dictionary<Guid, Dictionary<Guid, int>> result,
        CancellationToken cancellationToken)
    {
        var movieType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Movie];
        var trailerType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Trailer];

        var sources = await context.BaseItems.AsNoTracking()
            .Where(e => sourceIds.Contains(e.Id))
            .Select(e => new { e.Id, e.CleanName })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        // MaxBatchSourceItems keeps per-source SQL fan-out bounded.
        foreach (var source in sources)
        {
            if (string.IsNullOrWhiteSpace(source.CleanName))
            {
                continue;
            }

            var sourceName = source.CleanName;
            var scoreMap = result[source.Id];

            var similarRows = await context.BaseItems.AsNoTracking()
                .Where(e => (e.Type == movieType || e.Type == trailerType)
                    && e.CleanName != null
                    && !e.IsVirtualItem
                    && e.Id != source.Id
                    && EF.Functions.TrigramsWordSimilarity(sourceName, e.CleanName)
                        >= (float)MovieSimilarityWeights.TitleWordSimilarityFloor)
                .Select(e => new
                {
                    e.Id,
                    Similarity = EF.Functions.TrigramsWordSimilarity(sourceName, e.CleanName!)
                })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            foreach (var row in similarRows)
            {
                var franchiseScore = FranchiseTitleHelper.FranchiseScoreFromWordSimilarity(row.Similarity);
                if (franchiseScore > 0)
                {
                    ApplyFranchiseBand(scoreMap, row.Id, franchiseScore);
                }
            }

            var sourceTokens = FranchiseTitleHelper.ExtractSignificantTokens(sourceName);
            foreach (var token in sourceTokens)
            {
                var tokenMatches = await context.BaseItems.AsNoTracking()
                    .Where(e => (e.Type == movieType || e.Type == trailerType)
                        && e.CleanName != null
                        && !e.IsVirtualItem
                        && e.Id != source.Id
                        && e.CleanName.Contains(token))
                    .Select(e => new { e.Id, e.CleanName })
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false);

                foreach (var match in tokenMatches)
                {
                    if (!FranchiseTitleHelper.SharesSignificantToken(sourceName, match.CleanName))
                    {
                        continue;
                    }

                    ApplyFranchiseBand(
                        scoreMap,
                        match.Id,
                        MovieSimilarityWeights.SharedSignificantTokenWeight);
                }
            }
        }
    }

    private static async Task ApplyItemValueScoresAsync(
        List<Guid> sourceIds,
        JellyfinDbContext context,
        Dictionary<Guid, Dictionary<Guid, int>> result,
        CancellationToken cancellationToken)
    {
        foreach (var (valueType, weight) in ItemValueDimensions)
        {
            var sourceRows = await context.ItemValuesMap.AsNoTracking()
                .Where(m => sourceIds.Contains(m.ItemId) && m.ItemValue.Type == valueType)
                .Select(m => new { m.ItemId, Key = m.ItemValue.CleanValue })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            var sourceMap = sourceRows
                .GroupBy(r => r.ItemId)
                .ToDictionary(g => g.Key, g => g.Select(x => x.Key).ToHashSet());
            var allKeys = sourceMap.Values.SelectMany(v => v).Distinct().ToList();
            if (allKeys.Count == 0)
            {
                continue;
            }

            var candidateRows = await context.ItemValuesMap.AsNoTracking()
                .Where(m => m.ItemValue.Type == valueType && allKeys.Contains(m.ItemValue.CleanValue))
                .Select(m => new { m.ItemId, Key = m.ItemValue.CleanValue })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            var keyToCandidates = candidateRows
                .GroupBy(r => r.Key)
                .ToDictionary(g => g.Key, g => g.Select(x => x.ItemId).ToList());
            ApplyDimensionScores(sourceIds, sourceMap, keyToCandidates, weight, result);
        }
    }

    private static async Task ApplyPersonScoresAsync(
        List<Guid> sourceIds,
        JellyfinDbContext context,
        Dictionary<Guid, Dictionary<Guid, int>> result,
        CancellationToken cancellationToken)
    {
        var personSourceRows = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => sourceIds.Contains(m.ItemId) && ScoredPersonTypes.Contains(m.People.PersonType))
            .Select(m => new { m.ItemId, m.PeopleId, m.People.PersonType })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        if (personSourceRows.Count == 0)
        {
            return;
        }

        var personCandidateRows = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => context.PeopleBaseItemMap
                .Where(s => sourceIds.Contains(s.ItemId) && ScoredPersonTypes.Contains(s.People.PersonType))
                .Select(s => s.PeopleId)
                .Contains(m.PeopleId))
            .Select(m => new { m.ItemId, m.PeopleId })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var personToCandidates = personCandidateRows
            .GroupBy(r => r.PeopleId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.ItemId).ToList());

        foreach (var weightGroup in personSourceRows.GroupBy(r => PersonTypeWeights[r.PersonType!]))
        {
            var sourceMap = weightGroup
                .GroupBy(r => r.ItemId)
                .ToDictionary(g => g.Key, g => g.Select(x => x.PeopleId).ToHashSet());
            ApplyDimensionScores(sourceIds, sourceMap, personToCandidates, weightGroup.Key, result);
        }
    }

    private static void ApplyDimensionScores<TKey>(
        List<Guid> sourceIds,
        Dictionary<Guid, HashSet<TKey>> sourceMap,
        Dictionary<TKey, List<Guid>> keyToCandidates,
        int weight,
        Dictionary<Guid, Dictionary<Guid, int>> result)
        where TKey : notnull
    {
        foreach (var sourceId in sourceIds)
        {
            if (!sourceMap.TryGetValue(sourceId, out var sourceKeys))
            {
                continue;
            }

            var scoreMap = result[sourceId];
            foreach (var key in sourceKeys)
            {
                if (!keyToCandidates.TryGetValue(key, out var candidates))
                {
                    continue;
                }

                foreach (var candidateId in candidates)
                {
                    scoreMap[candidateId] = scoreMap.GetValueOrDefault(candidateId) + weight;
                }
            }
        }
    }

    /// <summary>
    /// Applies a franchise-band score with Max below the collection tier.
    /// Genre/people weights still sum afterward via <see cref="ApplyDimensionScores{TKey}"/>.
    /// </summary>
    private static void ApplyFranchiseBand(Dictionary<Guid, int> scoreMap, Guid candidateId, int weight)
    {
        var current = scoreMap.GetValueOrDefault(candidateId);
        if (current >= MovieSimilarityWeights.CollectionWeight)
        {
            return;
        }

        scoreMap[candidateId] = Math.Max(current, weight);
    }
}
