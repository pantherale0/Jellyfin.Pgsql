using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions;
using Jellyfin.Plugin.Pgsql.Search;
using Jellyfin.Plugin.Pgsql.Taste;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
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
    /// <summary>Per-source cap before taste feature load / neural (refresh and live miss).</summary>
    public const int TasteRerankCap = 250;

    /// <summary>Stored similar items per Because you X baseline.</summary>
    public const int BecauseYouPerSourceLimit = 16;

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
    private readonly UserTasteProfileStore _tasteProfileStore;
    private readonly TasteNeuralModelStore _modelStore;
    private readonly ILogger<PostgresMovieSimilarItemsProvider> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PostgresMovieSimilarItemsProvider"/> class.
    /// </summary>
    /// <param name="dbProvider">The database context factory.</param>
    /// <param name="queryHelpers">Shared item query helpers.</param>
    /// <param name="itemTypeLookup">Base item type name lookup.</param>
    /// <param name="serverConfigurationManager">Server configuration.</param>
    /// <param name="tasteProfileStore">User taste profile cache.</param>
    /// <param name="modelStore">Loaded shadow model store.</param>
    /// <param name="logger">Logger.</param>
    public PostgresMovieSimilarItemsProvider(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IItemQueryHelpers queryHelpers,
        IItemTypeLookup itemTypeLookup,
        IServerConfigurationManager serverConfigurationManager,
        UserTasteProfileStore tasteProfileStore,
        TasteNeuralModelStore modelStore,
        ILogger<PostgresMovieSimilarItemsProvider> logger)
    {
        _dbProvider = dbProvider;
        _queryHelpers = queryHelpers;
        _itemTypeLookup = itemTypeLookup;
        _serverConfigurationManager = serverConfigurationManager;
        _tasteProfileStore = tasteProfileStore;
        _modelStore = modelStore;
        _logger = logger;
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
            var storedBySource = await LoadStoredSimilarAsync(
                    context,
                    query.User?.Id,
                    sourceIds,
                    cancellationToken)
                .ConfigureAwait(false);

            var missingIds = sourceIds
                .Where(id => !storedBySource.TryGetValue(id, out var rows) || rows.Count == 0)
                .ToList();
            Dictionary<Guid, Dictionary<Guid, int>> perSourceScores;
            if (missingIds.Count == 0)
            {
                perSourceScores = [];
            }
            else
            {
                perSourceScores = await ComputeBatchScoresAsync(
                        missingIds,
                        context,
                        query.User?.Id,
                        useNeural: false,
                        cancellationToken)
                    .ConfigureAwait(false);
            }

            var allCandidateIds = new HashSet<Guid>();
            foreach (var rows in storedBySource.Values)
            {
                allCandidateIds.UnionWith(rows.Select(r => r.ItemId));
            }

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
                IsMovie = true
            };

            _queryHelpers.PrepareFilterQuery(filter);
            var baseQuery = _queryHelpers.PrepareItemQuery(context, filter);
            baseQuery = _queryHelpers.TranslateQuery(baseQuery, context, filter);

            var allCandidateIdsList = allCandidateIds.ToList();
            var playedIds = await LoadPlayedItemIdsAsync(
                    context,
                    query.User?.Id,
                    allCandidateIdsList,
                    cancellationToken)
                .ConfigureAwait(false);
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
            if (playedIds.Count > 0)
            {
                accessibleItems = accessibleItems.Where(x => !playedIds.Contains(x.Id)).ToList();
            }

            var allOrderedIds = new HashSet<Guid>();
            var perSourceOrderedIds = new Dictionary<Guid, List<Guid>>();

            foreach (var item in sourceItems)
            {
                List<Guid> orderedIds;
                if (storedBySource.TryGetValue(item.Id, out var stored) && stored.Count > 0)
                {
                    var storedSet = stored.Select(r => r.ItemId).ToHashSet();
                    var accessibleById = accessibleItems.Where(x => storedSet.Contains(x.Id)).ToDictionary(x => x.Id);
                    orderedIds = stored
                        .Where(r => accessibleById.ContainsKey(r.ItemId))
                        .DistinctBy(r => accessibleById[r.ItemId].PresentationUniqueKey)
                        .Take(limit)
                        .Select(r => r.ItemId)
                        .ToList();
                }
                else if (perSourceScores.TryGetValue(item.Id, out var scores))
                {
                    orderedIds = accessibleItems
                        .Where(x => scores.ContainsKey(x.Id))
                        .OrderByDescending(x => scores.GetValueOrDefault(x.Id))
                        .ThenBy(x => x.ProductionYear ?? int.MaxValue)
                        .ThenBy(x => x.SortName ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                        .DistinctBy(x => x.PresentationUniqueKey)
                        .Take(limit)
                        .Select(x => x.Id)
                        .ToList();
                }
                else
                {
                    continue;
                }

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
    /// <param name="userId">Optional user for taste re-ranking.</param>
    /// <param name="useNeural">When true, blend neural scores (refresh path only).</param>
    /// <returns>Per-source map of candidate ID → score.</returns>
    public async Task<Dictionary<Guid, Dictionary<Guid, int>>> ComputeBatchScoresAsync(
        IReadOnlyList<Guid> sourceIds,
        CancellationToken cancellationToken,
        Guid? userId = null,
        bool useNeural = false)
    {
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            return await ComputeBatchScoresAsync(sourceIds.ToList(), context, userId, useNeural, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task<Dictionary<Guid, Dictionary<Guid, int>>> ComputeBatchScoresAsync(
        List<Guid> sourceIds,
        JellyfinDbContext context,
        Guid? userId,
        bool useNeural,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<Guid, Dictionary<Guid, int>>();
        foreach (var id in sourceIds)
        {
            result[id] = [];
        }

        // Isolate each signal so a franchise/trigram failure cannot wipe genre/people results
        // (which previously left More Like This empty when the stock movie provider was disabled).
        await TryApplyScorePhaseAsync(
            "collection",
            () => ApplyCollectionScoresAsync(sourceIds, context, result, cancellationToken)).ConfigureAwait(false);
        await TryApplyScorePhaseAsync(
            "title-franchise",
            () => ApplyTitleFranchiseScoresAsync(sourceIds, context, result, cancellationToken)).ConfigureAwait(false);
        await TryApplyScorePhaseAsync(
            "item-values",
            () => ApplyItemValueScoresAsync(sourceIds, context, result, cancellationToken)).ConfigureAwait(false);
        await TryApplyScorePhaseAsync(
            "people",
            () => ApplyPersonScoresAsync(sourceIds, context, result, cancellationToken)).ConfigureAwait(false);
        await TryApplyScorePhaseAsync(
            "taste",
            () => ApplyTasteScoresAsync(userId, context, result, useNeural, cancellationToken)).ConfigureAwait(false);

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

    private async Task ApplyTasteScoresAsync(
        Guid? userId,
        JellyfinDbContext context,
        Dictionary<Guid, Dictionary<Guid, int>> result,
        bool useNeural,
        CancellationToken cancellationToken)
    {
        if (userId is null)
        {
            return;
        }

        var options = TasteOptions.Current;
        if (!options.EnableTasteProfiles)
        {
            return;
        }

        var profile = await _tasteProfileStore.TryGetAsync(userId.Value, cancellationToken).ConfigureAwait(false);
        if (profile is null)
        {
            return;
        }

        var rerankIds = SelectTasteRerankIds(result, TasteRerankCap);
        if (rerankIds.Count == 0)
        {
            return;
        }

        _itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.BoxSet, out var boxSetTypeName);
        var featuresByItem = await TasteCandidateFeatureLoader.LoadAsync(
                context,
                rerankIds,
                cancellationToken,
                boxSetType: boxSetTypeName)
            .ConfigureAwait(false);
        var neural = TasteNeuralScoring.TryPredict(
            _modelStore,
            profile.Value.Payload,
            featuresByItem,
            rerankIds,
            useNeural && options.UseNeuralForServing);
        foreach (var scoreMap in result.Values)
        {
            foreach (var candidateId in scoreMap.Keys.ToList())
            {
                if (!featuresByItem.TryGetValue(candidateId, out var features))
                {
                    continue;
                }

                var linear = LinearTasteScorer.ComputeBonus(profile.Value.Payload, features, options.MaxTasteBonus);
                var bonus = TasteScoreCombiner.Blend(
                    linear,
                    TasteNeuralScoring.Probability(neural, candidateId),
                    useNeural && options.UseNeuralForServing,
                    options.MaxTasteBonus);
                if (bonus > 0)
                {
                    scoreMap[candidateId] = scoreMap[candidateId] + bonus;
                }
            }
        }
    }

    /// <summary>
    /// Unique top-K candidate ids per source, for taste feature load.
    /// </summary>
    /// <param name="result">Per-source score maps.</param>
    /// <param name="capPerSource">Max candidates per source.</param>
    /// <returns>Union of shortlisted ids.</returns>
    public static List<Guid> SelectTasteRerankIds(
        Dictionary<Guid, Dictionary<Guid, int>> result,
        int capPerSource)
    {
        ArgumentNullException.ThrowIfNull(result);
        capPerSource = Math.Max(1, capPerSource);
        var ids = new HashSet<Guid>();
        foreach (var map in result.Values)
        {
            foreach (var id in map
                .OrderByDescending(kvp => kvp.Value)
                .ThenBy(kvp => kvp.Key)
                .Take(capPerSource)
                .Select(kvp => kvp.Key))
            {
                ids.Add(id);
            }
        }

        return [.. ids];
    }

    private static async Task<Dictionary<Guid, List<StoredSimilarRow>>> LoadStoredSimilarAsync(
        JellyfinDbContext context,
        Guid? userId,
        List<Guid> sourceIds,
        CancellationToken cancellationToken)
    {
        if (userId is null || sourceIds.Count == 0)
        {
            return [];
        }

        var rows = await context.UserTasteBecauseYouRecommendations.AsNoTracking()
            .Where(r => r.UserId == userId && sourceIds.Contains(r.SourceItemId))
            .OrderBy(r => r.Rank)
            .Select(r => new StoredSimilarRow(r.SourceItemId, r.ItemId, r.Rank))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return rows
            .GroupBy(r => r.SourceItemId)
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.Rank).ToList());
    }

    private readonly record struct StoredSimilarRow(Guid SourceItemId, Guid ItemId, int Rank);

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
        var types = new[] { movieType, trailerType };

        var sources = await context.BaseItems.AsNoTracking()
            .Where(e => sourceIds.Contains(e.Id))
            .Select(e => new { e.Id, e.CleanName })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var namedSources = sources
            .Where(s => !string.IsNullOrWhiteSpace(s.CleanName))
            .ToList();
        if (namedSources.Count == 0)
        {
            return;
        }

        var sourceIdsArr = namedSources.Select(s => s.Id).ToArray();
        var sourceNamesArr = namedSources.Select(s => s.CleanName!).ToArray();

        var tokenSourceIds = new List<Guid>();
        var tokenValues = new List<string>();
        foreach (var source in namedSources)
        {
            foreach (var token in FranchiseTitleHelper.ExtractSignificantTokens(source.CleanName))
            {
                tokenSourceIds.Add(source.Id);
                tokenValues.Add(EscapeLikeLiteral(token));
            }
        }

        await using var threshold = await PgTrgmThresholdScope
            .BeginAsync(context, MovieSimilarityWeights.TitleWordSimilarityFloor, cancellationToken)
            .ConfigureAwait(false);

        // `<%` (via SET LOCAL threshold) can use IX_BaseItems_CleanName_trgm instead of
        // evaluating word_similarity() against every movie/trailer.
        var similarRows = await context.Database
            .SqlQuery<FranchiseSimilarityRow>($"""
                SELECT s.sid AS "SourceId", e."Id" AS "CandidateId",
                       word_similarity(s.sname, e."CleanName") AS "Similarity"
                FROM unnest({sourceIdsArr}, {sourceNamesArr}) AS s(sid, sname)
                JOIN "BaseItems" e
                  ON e."Type" = ANY({types})
                 AND e."CleanName" IS NOT NULL
                 AND NOT e."IsVirtualItem"
                 AND e."Id" <> s.sid
                 AND s.sname <% e."CleanName"
                """)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        foreach (var row in similarRows)
        {
            if (!result.TryGetValue(row.SourceId, out var scoreMap))
            {
                continue;
            }

            var franchiseScore = FranchiseTitleHelper.FranchiseScoreFromWordSimilarity(row.Similarity);
            if (franchiseScore > 0)
            {
                ApplyFranchiseBand(scoreMap, row.CandidateId, franchiseScore);
            }
        }

        if (tokenSourceIds.Count == 0)
        {
            await threshold.CommitAsync(cancellationToken).ConfigureAwait(false);
            return;
        }

        var tokenSourceIdsArr = tokenSourceIds.ToArray();
        var tokenValuesArr = tokenValues.ToArray();
        var tokenRows = await context.Database
            .SqlQuery<FranchiseTokenRow>($"""
                SELECT s.sid AS "SourceId", e."Id" AS "CandidateId", e."CleanName" AS "CleanName"
                FROM unnest({tokenSourceIdsArr}, {tokenValuesArr}) AS s(sid, token)
                JOIN "BaseItems" e
                  ON e."Type" = ANY({types})
                 AND e."CleanName" IS NOT NULL
                 AND NOT e."IsVirtualItem"
                 AND e."Id" <> s.sid
                 AND e."CleanName" ILIKE ('%' || s.token || '%') ESCAPE '\'
                """)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var sourceNameById = namedSources.ToDictionary(s => s.Id, s => s.CleanName!);
        foreach (var row in tokenRows)
        {
            if (!result.TryGetValue(row.SourceId, out var scoreMap)
                || !sourceNameById.TryGetValue(row.SourceId, out var sourceName)
                || !FranchiseTitleHelper.SharesSignificantToken(sourceName, row.CleanName))
            {
                continue;
            }

            ApplyFranchiseBand(
                scoreMap,
                row.CandidateId,
                MovieSimilarityWeights.SharedSignificantTokenWeight);
        }

        await threshold.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    private static string EscapeLikeLiteral(string value)
        => value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal);

    private static async Task<HashSet<Guid>> LoadPlayedItemIdsAsync(
        JellyfinDbContext context,
        Guid? userId,
        List<Guid> candidateIds,
        CancellationToken cancellationToken)
    {
        if (userId is null || candidateIds.Count == 0)
        {
            return [];
        }

        var played = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId && ud.Played && candidateIds.Contains(ud.ItemId))
            .Select(ud => ud.ItemId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        return played.ToHashSet();
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

    private async Task ApplyPersonScoresAsync(
        List<Guid> sourceIds,
        JellyfinDbContext context,
        Dictionary<Guid, Dictionary<Guid, int>> result,
        CancellationToken cancellationToken)
    {
        var movieType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Movie];
        var trailerType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Trailer];

        var personSourceRows = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => sourceIds.Contains(m.ItemId) && ScoredPersonTypes.Contains(m.People.PersonType))
            .Select(m => new { m.ItemId, m.PeopleId, m.People.PersonType })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        if (personSourceRows.Count == 0)
        {
            return;
        }

        var peopleIds = personSourceRows.Select(r => r.PeopleId).Distinct().ToList();
        var personCandidateRows = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => peopleIds.Contains(m.PeopleId)
                && (m.Item.Type == movieType || m.Item.Type == trailerType))
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

    private async Task TryApplyScorePhaseAsync(string phaseName, Func<Task> phase)
    {
        try
        {
            await phase().ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Movie similarity scoring phase '{Phase}' failed; continuing with remaining signals", phaseName);
        }
    }

    private sealed class FranchiseSimilarityRow
    {
        public Guid SourceId { get; set; }

        public Guid CandidateId { get; set; }

        public double Similarity { get; set; }
    }

    private sealed class FranchiseTokenRow
    {
        public Guid SourceId { get; set; }

        public Guid CandidateId { get; set; }

        public string? CleanName { get; set; }
    }
}
