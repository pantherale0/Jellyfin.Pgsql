using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Scores candidate items against a taste profile and assigns relative match tiers.
/// </summary>
public sealed class TasteMatchService
{
    /// <summary>Maximum item ids accepted per match request.</summary>
    public const int MaxBatchSize = 64;

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly UserTasteProfileStore _profileStore;

    /// <summary>
    /// Initializes a new instance of the <see cref="TasteMatchService"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="profileStore">Taste profile store.</param>
    public TasteMatchService(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        UserTasteProfileStore profileStore)
    {
        _dbProvider = dbProvider;
        _profileStore = profileStore;
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
            var features = await TasteCandidateFeatureLoader.LoadAsync(context, capped, cancellationToken)
                .ConfigureAwait(false);
            var options = TasteOptions.Current;
            var scored = new List<(Guid Id, int Score)>();
            foreach (var id in capped)
            {
                if (!features.TryGetValue(id, out var candidate))
                {
                    continue;
                }

                var score = LinearTasteScorer.ComputeBonus(profile.Value.Payload, candidate, options.MaxTasteBonus);
                if (score > 0)
                {
                    scored.Add((id, score));
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
}
