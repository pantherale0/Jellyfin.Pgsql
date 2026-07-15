using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions;
using Jellyfin.Plugin.Pgsql.Taste;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using BaseItemDto = MediaBrowser.Controller.Entities.BaseItem;

namespace Jellyfin.Plugin.Pgsql.Similar;

/// <summary>
/// PostgreSQL-backed similar items for series: genre/tag/studio/people + taste re-rank.
/// </summary>
public sealed class PostgresSeriesSimilarItemsProvider : ILocalSimilarItemsProvider<Series>
{
    private static readonly (ItemValueType Type, int Weight)[] ItemValueDimensions =
    [
        (ItemValueType.Genre, SeriesSimilarityWeights.GenreWeight),
        (ItemValueType.Tags, SeriesSimilarityWeights.TagWeight),
        (ItemValueType.Studios, SeriesSimilarityWeights.StudioWeight)
    ];

    private static readonly Dictionary<string, int> PersonTypeWeights = new(StringComparer.Ordinal)
    {
        [nameof(PersonKind.Director)] = SeriesSimilarityWeights.DirectorWeight,
        [nameof(PersonKind.Actor)] = SeriesSimilarityWeights.ActorWeight,
        [nameof(PersonKind.GuestStar)] = SeriesSimilarityWeights.ActorWeight,
    };

    private static readonly string[] ScoredPersonTypes = [.. PersonTypeWeights.Keys];

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IItemQueryHelpers _queryHelpers;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly UserTasteProfileStore _tasteProfileStore;
    private readonly ILogger<PostgresSeriesSimilarItemsProvider> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PostgresSeriesSimilarItemsProvider"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="queryHelpers">Shared item query helpers.</param>
    /// <param name="itemTypeLookup">Base item type name lookup.</param>
    /// <param name="tasteProfileStore">User taste profile cache.</param>
    /// <param name="logger">Logger.</param>
    public PostgresSeriesSimilarItemsProvider(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IItemQueryHelpers queryHelpers,
        IItemTypeLookup itemTypeLookup,
        UserTasteProfileStore tasteProfileStore,
        ILogger<PostgresSeriesSimilarItemsProvider> logger)
    {
        _dbProvider = dbProvider;
        _queryHelpers = queryHelpers;
        _itemTypeLookup = itemTypeLookup;
        _tasteProfileStore = tasteProfileStore;
        _logger = logger;
    }

    /// <inheritdoc/>
    public string Name => "PostgreSQL Series Similarity";

    /// <inheritdoc/>
    public MetadataPluginType Type => MetadataPluginType.LocalSimilarityProvider;

    /// <inheritdoc/>
    public async Task<IReadOnlyList<BaseItemDto>> GetSimilarItemsAsync(
        Series item,
        SimilarItemsQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(item);
        var scores = await ComputeScoresAsync(item.Id, query.User?.Id, cancellationToken).ConfigureAwait(false);
        if (scores.Count == 0)
        {
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("No similar series scores for {SeriesId}", item.Id);
            }

            return [];
        }

        var limit = query.Limit ?? 50;
        var topIds = scores.OrderByDescending(kvp => kvp.Value)
            .Take(limit * 3)
            .Select(kvp => kvp.Key)
            .ToList();

        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var dtoOptions = query.DtoOptions ?? new DtoOptions();
            var filter = new InternalItemsQuery(query.User)
            {
                IncludeItemTypes = [BaseItemKind.Series],
                ExcludeItemIds = [.. query.ExcludeItemIds, item.Id],
                DtoOptions = dtoOptions,
                EnableGroupByMetadataKey = true,
                EnableTotalRecordCount = false,
                IsPlayed = false
            };

            _queryHelpers.PrepareFilterQuery(filter);
            var baseQuery = _queryHelpers.PrepareItemQuery(context, filter);
            baseQuery = _queryHelpers.TranslateQuery(baseQuery, context, filter);

            var accessible = await baseQuery
                .WhereOneOrMany(topIds, e => e.Id)
                .Select(e => new { e.Id, e.PresentationUniqueKey, e.ProductionYear, e.SortName })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            var orderedIds = accessible
                .OrderByDescending(a => scores.GetValueOrDefault(a.Id))
                .ThenBy(a => a.SortName)
                .Select(a => a.Id)
                .Distinct()
                .Take(limit)
                .ToList();

            if (orderedIds.Count == 0)
            {
                return [];
            }

            var entities = await _queryHelpers.ApplyNavigations(
                    context.BaseItems.AsNoTracking().WhereOneOrMany(orderedIds, e => e.Id),
                    filter)
                .AsSplitQuery()
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            var entitiesById = entities
                .Select(e => _queryHelpers.DeserializeBaseItem(e, filter.SkipDeserialization))
                .Where(dto => dto is not null)
                .ToDictionary(i => i!.Id);

            return orderedIds
                .Where(entitiesById.ContainsKey)
                .Select(id => entitiesById[id]!)
                .ToList();
        }
    }

    /// <summary>
    /// Computes candidate scores for a source series (tests / diagnostics).
    /// </summary>
    /// <param name="sourceId">Source series id.</param>
    /// <param name="userId">Optional user for taste.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Candidate id → score.</returns>
    public async Task<Dictionary<Guid, int>> ComputeScoresAsync(
        Guid sourceId,
        Guid? userId,
        CancellationToken cancellationToken)
    {
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var scores = new Dictionary<Guid, int>();
            await ApplyItemValueScoresAsync(sourceId, context, scores, cancellationToken).ConfigureAwait(false);
            await ApplyPersonScoresAsync(sourceId, context, scores, cancellationToken).ConfigureAwait(false);
            await ApplyTasteScoresAsync(userId, context, scores, cancellationToken).ConfigureAwait(false);
            scores.Remove(sourceId);
            return scores;
        }
    }

    private async Task ApplyItemValueScoresAsync(
        Guid sourceId,
        JellyfinDbContext context,
        Dictionary<Guid, int> scores,
        CancellationToken cancellationToken)
    {
        var seriesType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Series];
        foreach (var (valueType, weight) in ItemValueDimensions)
        {
            var sourceValues = await context.ItemValuesMap.AsNoTracking()
                .Where(m => m.ItemId == sourceId && m.ItemValue.Type == valueType)
                .Select(m => m.ItemValue.CleanValue)
                .Where(v => v != null && v != string.Empty)
                .Distinct()
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            if (sourceValues.Count == 0)
            {
                continue;
            }

            var matches = await context.ItemValuesMap.AsNoTracking()
                .Where(m => m.ItemId != sourceId
                    && m.ItemValue.Type == valueType
                    && sourceValues.Contains(m.ItemValue.CleanValue)
                    && m.Item.Type == seriesType)
                .GroupBy(m => m.ItemId)
                .Select(g => new { ItemId = g.Key, Shared = g.Select(x => x.ItemValue.CleanValue).Distinct().Count() })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            foreach (var match in matches)
            {
                scores[match.ItemId] = scores.GetValueOrDefault(match.ItemId) + (match.Shared * weight);
            }
        }
    }

    private async Task ApplyPersonScoresAsync(
        Guid sourceId,
        JellyfinDbContext context,
        Dictionary<Guid, int> scores,
        CancellationToken cancellationToken)
    {
        var seriesType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Series];
        var sourcePeople = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => m.ItemId == sourceId && ScoredPersonTypes.Contains(m.People.PersonType))
            .Select(m => new { m.PeopleId, m.People.PersonType })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (sourcePeople.Count == 0)
        {
            return;
        }

        var peopleIds = sourcePeople.Select(p => p.PeopleId).Distinct().ToList();
        var weightByPerson = sourcePeople
            .GroupBy(p => p.PeopleId)
            .ToDictionary(
                g => g.Key,
                g => g.Max(x => PersonTypeWeights.GetValueOrDefault(x.PersonType ?? string.Empty)));

        var candidates = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => m.ItemId != sourceId
                && peopleIds.Contains(m.PeopleId)
                && m.Item.Type == seriesType)
            .Select(m => new { m.ItemId, m.PeopleId })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        foreach (var group in candidates.GroupBy(c => c.ItemId))
        {
            var bonus = group.Select(c => weightByPerson.GetValueOrDefault(c.PeopleId)).Sum();
            if (bonus > 0)
            {
                scores[group.Key] = scores.GetValueOrDefault(group.Key) + bonus;
            }
        }
    }

    private async Task ApplyTasteScoresAsync(
        Guid? userId,
        JellyfinDbContext context,
        Dictionary<Guid, int> scores,
        CancellationToken cancellationToken)
    {
        if (userId is null || scores.Count == 0)
        {
            return;
        }

        var options = TasteOptions.Current;
        if (!options.EnableTasteProfiles)
        {
            return;
        }

        _ = options.UseNeuralForServing;

        var profile = await _tasteProfileStore.TryGetAsync(userId.Value, cancellationToken).ConfigureAwait(false);
        if (profile is null)
        {
            return;
        }

        var candidateIds = scores.Keys.ToList();
        var featuresByItem = await TasteCandidateFeatureLoader.LoadAsync(context, candidateIds, cancellationToken)
            .ConfigureAwait(false);
        var cap = Math.Min(options.MaxTasteBonus, SeriesSimilarityWeights.MaxTasteBonus);
        foreach (var candidateId in candidateIds)
        {
            if (!featuresByItem.TryGetValue(candidateId, out var features))
            {
                continue;
            }

            var bonus = LinearTasteScorer.ComputeBonus(profile.Value.Payload, features, cap);
            if (bonus > 0)
            {
                scores[candidateId] = scores[candidateId] + bonus;
            }
        }
    }
}
