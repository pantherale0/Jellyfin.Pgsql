using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Batch neural inference helpers for taste scoring (refresh / opt-in only).
/// </summary>
internal static class TasteNeuralScoring
{
    /// <summary>
    /// Predicts probabilities for candidates when a model is loaded.
    /// </summary>
    /// <param name="store">Model store.</param>
    /// <param name="profile">User taste payload.</param>
    /// <param name="featuresByItem">Candidate features.</param>
    /// <param name="itemIds">Candidate ids.</param>
    /// <param name="useNeural">When false, skip inference (live request path).</param>
    /// <returns>Probability map, or null when unavailable.</returns>
    public static IReadOnlyDictionary<Guid, float>? TryPredict(
        TasteNeuralModelStore store,
        UserTasteFeaturePayload profile,
        IReadOnlyDictionary<Guid, TasteCandidateFeatures> featuresByItem,
        IEnumerable<Guid> itemIds,
        bool useNeural = false)
    {
        if (!useNeural)
        {
            return null;
        }

        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(featuresByItem);
        ArgumentNullException.ThrowIfNull(itemIds);
        if (!store.IsLoaded)
        {
            return null;
        }

        var ids = new List<Guid>();
        var examples = new List<TasteNeuralExample>();
        foreach (var id in itemIds)
        {
            if (!featuresByItem.TryGetValue(id, out var features))
            {
                continue;
            }

            ids.Add(id);
            examples.Add(TasteNeuralExampleBuilder.Create(profile, features, label: false, weight: 1f));
        }

        if (examples.Count == 0 || !store.TryPredictBatch(examples, out var probabilities))
        {
            return null;
        }

        var map = new Dictionary<Guid, float>(ids.Count);
        for (var i = 0; i < ids.Count; i++)
        {
            map[ids[i]] = probabilities[i];
        }

        return map;
    }

    /// <summary>
    /// Looks up a predicted probability, or null when missing.
    /// </summary>
    /// <param name="map">Probability map.</param>
    /// <param name="itemId">Item id.</param>
    /// <returns>Probability or null.</returns>
    public static float? Probability(IReadOnlyDictionary<Guid, float>? map, Guid itemId)
        => map is not null && map.TryGetValue(itemId, out var probability) ? probability : null;
}
