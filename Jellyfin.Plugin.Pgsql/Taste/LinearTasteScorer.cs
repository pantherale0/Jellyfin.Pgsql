using System;
using System.Collections.Generic;
using Jellyfin.Plugin.Pgsql.Similar;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Computes a capped linear taste bonus from a user profile vs candidate item features.
/// </summary>
public static class LinearTasteScorer
{
    /// <summary>Scale for shared genre weight contribution.</summary>
    public const float GenreScale = 90f;

    /// <summary>Scale for shared tag weight contribution.</summary>
    public const float TagScale = 40f;

    /// <summary>Scale for shared studio weight contribution.</summary>
    public const float StudioScale = 40f;

    /// <summary>Scale for shared director weight contribution.</summary>
    public const float DirectorScale = 70f;

    /// <summary>Scale for shared actor weight contribution.</summary>
    public const float ActorScale = 35f;

    /// <summary>Penalty when community rating sits outside the user's rating band.</summary>
    public const int RatingBandPenalty = 25;

    /// <summary>
    /// Computes a taste bonus capped below franchise tiers.
    /// </summary>
    /// <param name="profile">User taste features.</param>
    /// <param name="candidate">Candidate item features.</param>
    /// <param name="maxBonus">Absolute cap (from config).</param>
    /// <returns>Non-negative integer bonus.</returns>
    public static int ComputeBonus(UserTasteFeaturePayload profile, TasteCandidateFeatures candidate, int maxBonus)
    {
        ArgumentNullException.ThrowIfNull(profile);

        if (maxBonus <= 0)
        {
            return 0;
        }

        float score = 0f;
        score += SumMatches(profile.Genres, candidate.Genres, GenreScale);
        score += SumMatches(profile.Tags, candidate.Tags, TagScale);
        score += SumMatches(profile.Studios, candidate.Studios, StudioScale);
        score += SumGuidMatches(profile.Directors, candidate.DirectorIds, DirectorScale);
        score += SumGuidMatches(profile.Actors, candidate.ActorIds, ActorScale);

        if (candidate.CommunityRating is float rating
            && profile.RatingP25 is float p25
            && profile.RatingP75 is float p75
            && (rating < p25 - 0.5f || rating > p75 + 0.5f))
        {
            score -= RatingBandPenalty;
        }

        var bonus = (int)Math.Round(score, MidpointRounding.AwayFromZero);
        if (bonus < 0)
        {
            bonus = 0;
        }

        var cap = Math.Min(maxBonus, MovieSimilarityWeights.MaxTasteBonus);
        return Math.Min(bonus, cap);
    }

    private static float SumMatches(
        Dictionary<string, float> weights,
        IReadOnlyCollection<string> values,
        float scale)
    {
        if (weights.Count == 0 || values.Count == 0)
        {
            return 0f;
        }

        float sum = 0f;
        foreach (var value in values)
        {
            if (weights.TryGetValue(value, out var weight))
            {
                sum += weight * scale;
            }
        }

        return sum;
    }

    private static float SumGuidMatches(
        Dictionary<string, float> weights,
        IReadOnlyCollection<Guid> ids,
        float scale)
    {
        if (weights.Count == 0 || ids.Count == 0)
        {
            return 0f;
        }

        float sum = 0f;
        foreach (var id in ids)
        {
            if (weights.TryGetValue(id.ToString("N"), out var weight)
                || weights.TryGetValue(id.ToString("D"), out weight))
            {
                sum += weight * scale;
            }
        }

        return sum;
    }
}
