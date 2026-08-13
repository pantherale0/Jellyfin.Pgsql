using System;
using System.Collections.Generic;
using System.Linq;

#pragma warning disable SA1402 // Feature-row builder lives next to the example schema.

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Feature row shared by shadow training and live neural inference.
/// Concatenate column order must stay stable across train/serve.
/// </summary>
public sealed class TasteNeuralExample
{
    /// <summary>Gets concatenate column names in pipeline order.</summary>
    public static readonly string[] FeatureColumnNames =
    [
        nameof(GenreOverlap),
        nameof(TagOverlap),
        nameof(StudioOverlap),
        nameof(DirectorOverlap),
        nameof(ActorOverlap),
        nameof(RatingDistance),
        nameof(YearDistance),
        nameof(RuntimeDistance),
        nameof(ParentalDistance),
        nameof(RatingOutOfBand),
        nameof(YearOutOfBand),
        nameof(RuntimeOutOfBand),
        nameof(ParentalOutOfBand),
        nameof(TypeMatch),
        nameof(WriterOverlap),
        nameof(BoxSetOverlap),
        nameof(LanguageOverlap),
        nameof(CountryOverlap)
    ];

    /// <summary>Gets or sets a value indicating whether the example is a positive label (training only).</summary>
    public bool Label { get; set; }

    /// <summary>Gets or sets the example weight.</summary>
    public float Weight { get; set; } = 1f;

    /// <summary>Gets or sets genre overlap.</summary>
    public float GenreOverlap { get; set; }

    /// <summary>Gets or sets tag overlap.</summary>
    public float TagOverlap { get; set; }

    /// <summary>Gets or sets studio overlap.</summary>
    public float StudioOverlap { get; set; }

    /// <summary>Gets or sets director overlap.</summary>
    public float DirectorOverlap { get; set; }

    /// <summary>Gets or sets actor overlap.</summary>
    public float ActorOverlap { get; set; }

    /// <summary>Gets or sets community-rating distance.</summary>
    public float RatingDistance { get; set; }

    /// <summary>Gets or sets production-year distance.</summary>
    public float YearDistance { get; set; }

    /// <summary>Gets or sets runtime distance in hours.</summary>
    public float RuntimeDistance { get; set; }

    /// <summary>Gets or sets parental-rating distance.</summary>
    public float ParentalDistance { get; set; }

    /// <summary>Gets or sets 1 when rating is out of band.</summary>
    public float RatingOutOfBand { get; set; }

    /// <summary>Gets or sets 1 when year is out of band.</summary>
    public float YearOutOfBand { get; set; }

    /// <summary>Gets or sets 1 when runtime is out of band.</summary>
    public float RuntimeOutOfBand { get; set; }

    /// <summary>Gets or sets 1 when parental rating is out of band.</summary>
    public float ParentalOutOfBand { get; set; }

    /// <summary>Gets or sets type match (series share or 1 − series share).</summary>
    public float TypeMatch { get; set; }

    /// <summary>Gets or sets writer overlap.</summary>
    public float WriterOverlap { get; set; }

    /// <summary>Gets or sets box-set overlap.</summary>
    public float BoxSetOverlap { get; set; }

    /// <summary>Gets or sets original-language overlap.</summary>
    public float LanguageOverlap { get; set; }

    /// <summary>Gets or sets production-country overlap.</summary>
    public float CountryOverlap { get; set; }
}

/// <summary>
/// Builds <see cref="TasteNeuralExample"/> rows from a profile and candidate snapshot.
/// </summary>
public static class TasteNeuralExampleBuilder
{
    /// <summary>
    /// Creates a feature row.
    /// </summary>
    /// <param name="profile">User taste payload.</param>
    /// <param name="features">Candidate features.</param>
    /// <param name="label">Training label (false for inference).</param>
    /// <param name="weight">Example weight.</param>
    /// <returns>Feature row.</returns>
    public static TasteNeuralExample Create(
        UserTasteFeaturePayload profile,
        TasteCandidateFeatures features,
        bool label,
        float weight)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var seriesShare = profile.SeriesShare ?? 0.5f;
        return new TasteNeuralExample
        {
            Label = label,
            Weight = weight,
            GenreOverlap = SumWeights(profile.Genres, features.Genres),
            TagOverlap = SumWeights(profile.Tags, features.Tags),
            StudioOverlap = SumWeights(profile.Studios, features.Studios),
            DirectorOverlap = SumGuidWeights(profile.Directors, features.DirectorIds),
            ActorOverlap = SumGuidWeights(profile.Actors, features.ActorIds),
            RatingDistance = Distance(features.CommunityRating, profile.RatingMean),
            YearDistance = Distance(
                features.ProductionYear is int y ? (float?)y : null,
                profile.YearMean),
            RuntimeDistance = RuntimeDistanceHours(features.RunTimeTicks, profile.RuntimeMeanTicks),
            ParentalDistance = Distance(
                features.InheritedParentalRatingValue is int p ? p : null,
                profile.ParentalMean),
            RatingOutOfBand = OutOfBandFlag(
                features.CommunityRating,
                profile.RatingP25,
                profile.RatingP75,
                slack: 0.5f),
            YearOutOfBand = OutOfBandFlag(
                features.ProductionYear is int year ? year : null,
                profile.YearP25,
                profile.YearP75,
                LinearTasteScorer.YearBandSlack),
            RuntimeOutOfBand = RuntimeOutOfBandFlag(features.RunTimeTicks, profile),
            ParentalOutOfBand = OutOfBandFlag(
                features.InheritedParentalRatingValue is int parental ? parental : null,
                profile.ParentalP25,
                profile.ParentalP75,
                LinearTasteScorer.ParentalBandSlack),
            TypeMatch = features.IsSeries ? seriesShare : 1f - seriesShare,
            WriterOverlap = SumGuidWeights(profile.Writers, features.WriterIds ?? []),
            BoxSetOverlap = SumGuidWeights(profile.BoxSets, features.BoxSetIds ?? []),
            LanguageOverlap = string.IsNullOrWhiteSpace(features.OriginalLanguage)
                ? 0f
                : SumWeights(profile.Languages, [features.OriginalLanguage]),
            CountryOverlap = SumWeights(profile.Countries, features.ProductionCountries ?? [])
        };
    }

    private static float SumWeights(Dictionary<string, float> weights, IReadOnlyCollection<string> values)
    {
        float sum = 0f;
        foreach (var value in values.Where(weights.ContainsKey))
        {
            sum += weights[value];
        }

        return sum;
    }

    private static float SumGuidWeights(Dictionary<string, float> weights, IReadOnlyCollection<Guid> ids)
    {
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
            sum += weight;
        }

        return sum;
    }

    private static float Distance(float? value, float? mean)
    {
        if (value is null || mean is null)
        {
            return 0f;
        }

        return Math.Abs(value.Value - mean.Value);
    }

    private static float RuntimeDistanceHours(long? runtimeTicks, float? meanTicks)
    {
        if (runtimeTicks is null or <= 0 || meanTicks is null or <= 0)
        {
            return 0f;
        }

        var hours = runtimeTicks.Value / (float)TimeSpan.TicksPerHour;
        var meanHours = meanTicks.Value / (float)TimeSpan.TicksPerHour;
        return Math.Abs(hours - meanHours);
    }

    private static float OutOfBandFlag(float? value, float? p25, float? p75, float slack)
        => LinearTasteScorer.IsOutOfBand(value, p25, p75, slack) ? 1f : 0f;

    private static float RuntimeOutOfBandFlag(long? runtimeTicks, UserTasteFeaturePayload profile)
    {
        if (runtimeTicks is null or <= 0
            || profile.RuntimeP25Ticks is null
            || profile.RuntimeP75Ticks is null)
        {
            return 0f;
        }

        var slackTicks = TimeSpan.FromMinutes(LinearTasteScorer.RuntimeBandSlackMinutes).Ticks;
        return LinearTasteScorer.IsOutOfBand(
            runtimeTicks.Value,
            profile.RuntimeP25Ticks,
            profile.RuntimeP75Ticks,
            slackTicks)
            ? 1f
            : 0f;
    }
}
