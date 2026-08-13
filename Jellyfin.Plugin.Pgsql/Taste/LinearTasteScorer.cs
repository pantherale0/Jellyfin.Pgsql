using System;
using System.Collections.Generic;
using System.Linq;
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

    /// <summary>Scale for shared writer weight contribution.</summary>
    public const float WriterScale = 55f;

    /// <summary>Scale for shared box-set membership contribution.</summary>
    public const float BoxSetScale = 45f;

    /// <summary>Scale for shared original-language contribution.</summary>
    public const float LanguageScale = 30f;

    /// <summary>Scale for shared production-country contribution.</summary>
    public const float CountryScale = 25f;

    /// <summary>Penalty when community rating sits outside the user's rating band.</summary>
    public const int RatingBandPenalty = 25;

    /// <summary>Penalty when production year sits outside the user's year band.</summary>
    public const int YearBandPenalty = 25;

    /// <summary>Penalty when runtime sits outside the user's runtime band.</summary>
    public const int RuntimeBandPenalty = 25;

    /// <summary>Penalty when parental rating sits outside the user's parental band.</summary>
    public const int ParentalBandPenalty = 25;

    /// <summary>Penalty when candidate type mismatches a strong movie/series preference.</summary>
    public const int TypeMismatchPenalty = 25;

    /// <summary>Penalty for confirmed For You impression skips (no later engagement).</summary>
    public const int ImpressionSkipPenalty = 25;

    /// <summary>Slack (years) around the year P25/P75 band.</summary>
    public const float YearBandSlack = 5f;

    /// <summary>Slack (minutes) around the runtime P25/P75 band.</summary>
    public const float RuntimeBandSlackMinutes = 20f;

    /// <summary>Slack (rating steps) around the parental P25/P75 band.</summary>
    public const float ParentalBandSlack = 1f;

    /// <summary>SeriesShare below this means a strong movie preference.</summary>
    public const float SeriesShareMovieMajority = 0.25f;

    /// <summary>SeriesShare above this means a strong series preference.</summary>
    public const float SeriesShareSeriesMajority = 0.75f;

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
        score += SumGuidMatches(profile.Writers, candidate.WriterIds ?? [], WriterScale);
        score += SumGuidMatches(profile.BoxSets, candidate.BoxSetIds ?? [], BoxSetScale);
        if (!string.IsNullOrWhiteSpace(candidate.OriginalLanguage))
        {
            score += SumMatches(profile.Languages, [candidate.OriginalLanguage], LanguageScale);
        }

        score += SumMatches(profile.Countries, candidate.ProductionCountries ?? [], CountryScale);

        if (IsOutOfBand(candidate.CommunityRating, profile.RatingP25, profile.RatingP75, slack: 0.5f))
        {
            score -= RatingBandPenalty;
        }

        if (candidate.ProductionYear is int year
            && IsOutOfBand(year, profile.YearP25, profile.YearP75, YearBandSlack))
        {
            score -= YearBandPenalty;
        }

        if (candidate.RunTimeTicks is long runtimeTicks and > 0
            && profile.RuntimeP25Ticks is float runtimeP25
            && profile.RuntimeP75Ticks is float runtimeP75)
        {
            var slackTicks = TimeSpan.FromMinutes(RuntimeBandSlackMinutes).Ticks;
            if (IsOutOfBand(runtimeTicks, runtimeP25, runtimeP75, slackTicks))
            {
                score -= RuntimeBandPenalty;
            }
        }

        if (candidate.InheritedParentalRatingValue is int parental
            && IsOutOfBand(parental, profile.ParentalP25, profile.ParentalP75, ParentalBandSlack))
        {
            score -= ParentalBandPenalty;
        }

        if (IsTypeMismatch(profile.SeriesShare, candidate.IsSeries))
        {
            score -= TypeMismatchPenalty;
        }

        var bonus = (int)Math.Round(score, MidpointRounding.AwayFromZero);
        if (bonus < 0)
        {
            bonus = 0;
        }

        var cap = Math.Min(maxBonus, MovieSimilarityWeights.MaxTasteBonus);
        return Math.Min(bonus, cap);
    }

    /// <summary>
    /// Whether a candidate type mismatches a strong movie/series preference.
    /// </summary>
    /// <param name="seriesShare">Share of positive signals that are series.</param>
    /// <param name="isSeries">Whether the candidate is a series.</param>
    /// <returns>True when the type should be penalized.</returns>
    public static bool IsTypeMismatch(float? seriesShare, bool isSeries)
    {
        if (seriesShare is not float share)
        {
            return false;
        }

        return (share < SeriesShareMovieMajority && isSeries)
            || (share > SeriesShareSeriesMajority && !isSeries);
    }

    /// <summary>
    /// Whether a value sits outside [p25 - slack, p75 + slack].
    /// </summary>
    /// <param name="value">Candidate value.</param>
    /// <param name="p25">Profile 25th percentile.</param>
    /// <param name="p75">Profile 75th percentile.</param>
    /// <param name="slack">Allowed slack outside the band.</param>
    /// <returns>True when out of band.</returns>
    public static bool IsOutOfBand(float? value, float? p25, float? p75, float slack)
    {
        if (value is not float v || p25 is not float low || p75 is not float high)
        {
            return false;
        }

        return v < low - slack || v > high + slack;
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
        foreach (var value in values.Where(weights.ContainsKey))
        {
            sum += weights[value] * scale;
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
        foreach (var weight in ids
                     .Select(id =>
                         weights.TryGetValue(id.ToString("N"), out var w)
                         || weights.TryGetValue(id.ToString("D"), out w)
                             ? (float?)w
                             : null)
                     .Where(w => w.HasValue)
                     .Select(w => w!.Value))
        {
            sum += weight * scale;
        }

        return sum;
    }
}
