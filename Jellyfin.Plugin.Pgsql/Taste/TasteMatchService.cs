using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Scores candidate items against a taste profile and assigns relative match tiers.
/// Episode ids are scored using their Series features; tiers are returned for the original ids.
/// </summary>
public sealed class TasteMatchService
{
    /// <summary>Maximum item ids accepted per match request.</summary>
    public const int MaxBatchSize = 64;

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly UserTasteProfileStore _profileStore;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly TasteNeuralModelStore _modelStore;

    /// <summary>
    /// Initializes a new instance of the <see cref="TasteMatchService"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="profileStore">Taste profile store.</param>
    /// <param name="itemTypeLookup">Item type name lookup.</param>
    /// <param name="modelStore">Loaded shadow model store.</param>
    public TasteMatchService(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        UserTasteProfileStore profileStore,
        IItemTypeLookup itemTypeLookup,
        TasteNeuralModelStore modelStore)
    {
        _dbProvider = dbProvider;
        _profileStore = profileStore;
        _itemTypeLookup = itemTypeLookup;
        _modelStore = modelStore;
    }

    /// <summary>
    /// Scores items and returns sparse high/mid tiers relative to the batch.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="itemIds">Candidate item ids.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Match rows for badge-worthy items.</returns>
    public async Task<IReadOnlyList<TasteMatchItem>> MatchAsync(
        Guid userId,
        IReadOnlyList<Guid> itemIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        if (itemIds.Count == 0)
        {
            return [];
        }

        var profile = await _profileStore.TryGetAsync(userId, cancellationToken).ConfigureAwait(false);
        if (profile is null)
        {
            return [];
        }

        var capped = itemIds.Distinct().Take(MaxBatchSize).ToList();
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var featureIdsByRequestId = await ResolveFeatureItemIdsAsync(context, capped, cancellationToken)
                .ConfigureAwait(false);
            var featureIds = featureIdsByRequestId.Values.Distinct().ToList();
            _itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.Series, out var seriesTypeName);
            _itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.BoxSet, out var boxSetTypeName);
            var features = await TasteCandidateFeatureLoader
                .LoadAsync(context, featureIds, cancellationToken, seriesTypeName, boxSetTypeName)
                .ConfigureAwait(false);
            var options = TasteOptions.Current;
            var neural = TasteNeuralScoring.TryPredict(
                _modelStore,
                profile.Value.Payload,
                features,
                featureIds,
                useNeural: false);
            var scored = new List<(Guid Id, int Score)>();
            foreach (var requestId in capped)
            {
                if (!featureIdsByRequestId.TryGetValue(requestId, out var featureId))
                {
                    continue;
                }

                if (!features.TryGetValue(featureId, out var candidate))
                {
                    continue;
                }

                var linear = LinearTasteScorer.ComputeBonus(profile.Value.Payload, candidate, options.MaxTasteBonus);
                var score = TasteScoreCombiner.Blend(
                    linear,
                    TasteNeuralScoring.Probability(neural, featureId),
                    options.UseNeuralForServing,
                    options.MaxTasteBonus);
                if (score > 0)
                {
                    scored.Add((requestId, score));
                }
            }

            return AssignTiers(scored);
        }
    }

    /// <summary>
    /// Assigns high/mid tiers to the top half of positive scores.
    /// </summary>
    /// <param name="scored">Positive scores.</param>
    /// <returns>Tiered matches.</returns>
    public static IReadOnlyList<TasteMatchItem> AssignTiers(IReadOnlyList<(Guid Id, int Score)> scored)
    {
        if (scored.Count == 0)
        {
            return [];
        }

        var ordered = scored.OrderByDescending(s => s.Score).ThenBy(s => s.Id).ToList();
        var highCount = Math.Max(1, (int)Math.Ceiling(ordered.Count * 0.25));
        var midCount = Math.Max(0, (int)Math.Ceiling(ordered.Count * 0.25));
        var result = new List<TasteMatchItem>(highCount + midCount);
        for (var i = 0; i < ordered.Count && i < highCount + midCount; i++)
        {
            var tier = i < highCount ? "high" : "mid";
            result.Add(new TasteMatchItem(ordered[i].Id, tier, ordered[i].Score));
        }

        return result;
    }

    /// <summary>
    /// Maps request item ids to feature-bearing ids (SeriesId for episodes when present).
    /// </summary>
    /// <param name="context">Database context.</param>
    /// <param name="itemIds">Request item ids.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Request id → feature item id.</returns>
    public static async Task<Dictionary<Guid, Guid>> ResolveFeatureItemIdsAsync(
        JellyfinDbContext context,
        IReadOnlyList<Guid> itemIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (itemIds.Count == 0)
        {
            return [];
        }

        var idList = itemIds as List<Guid> ?? itemIds.ToList();
        var rows = await context.BaseItems.AsNoTracking()
            .Where(i => idList.Contains(i.Id))
            .Select(i => new { i.Id, i.Type, i.SeriesId })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var map = new Dictionary<Guid, Guid>();
        foreach (var row in rows)
        {
            if (row.SeriesId is Guid seriesId)
            {
                map[row.Id] = seriesId;
                continue;
            }

            // Episodes without SeriesId cannot be scored against a series profile.
            if (row.Type is not null
                && row.Type.EndsWith("Episode", StringComparison.Ordinal))
            {
                continue;
            }

            map[row.Id] = row.Id;
        }

        return map;
    }
}
