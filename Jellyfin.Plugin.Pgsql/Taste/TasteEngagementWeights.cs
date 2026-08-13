using System;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Completion-aware and For You impression engagement weighting helpers.
/// </summary>
public static class TasteEngagementWeights
{
    /// <summary>Completion ratio below which a play may count as abandon.</summary>
    public const float AbandonMaxRatio = 0.20f;

    /// <summary>Completion ratio at or above which a play counts as mid engagement.</summary>
    public const float MidMinRatio = 0.25f;

    /// <summary>Completion ratio at or above which a play counts as deep/completed.</summary>
    public const float DeepMinRatio = 0.80f;

    /// <summary>Days without a later play required to confirm abandon.</summary>
    public const int AbandonNoReturnDays = 14;

    /// <summary>Days after a For You impression before an unengaged item counts as a skip.</summary>
    public const int ImpressionSkipConfirmDays = AbandonNoReturnDays;

    /// <summary>Hours within which duplicate For You impressions for the same item are skipped.</summary>
    public const int ImpressionDedupeHours = 24;

    /// <summary>Linear weight for a confirmed abandon without a For You impression.</summary>
    public const float AbandonLinearWeight = -1.0f;

    /// <summary>Linear weight for a confirmed abandon after a For You impression.</summary>
    public const float RecAbandonLinearWeight = -2.0f;

    /// <summary>Multiplier applied to positive item weight when For You impressed then engaged.</summary>
    public const float RecPositiveEngageMultiplier = 1.5f;

    /// <summary>Neural sample weight for favorites.</summary>
    public const float NeuralFavoriteWeight = 3.0f;

    /// <summary>Neural sample weight for likes.</summary>
    public const float NeuralLikeWeight = 2.0f;

    /// <summary>Neural sample weight for deep/completed plays.</summary>
    public const float NeuralDeepPlayWeight = 1.5f;

    /// <summary>Neural sample weight for mid plays.</summary>
    public const float NeuralMidPlayWeight = 1.0f;

    /// <summary>Neural sample weight for abandons (negative label).</summary>
    public const float NeuralAbandonWeight = 2.0f;

    /// <summary>Neural sample weight for recommended then positively engaged.</summary>
    public const float NeuralRecPositiveWeight = 4.0f;

    /// <summary>Neural sample weight for recommended then abandoned (negative label).</summary>
    public const float NeuralRecAbandonWeight = 3.0f;

    /// <summary>Neural sample weight for random catalog negatives.</summary>
    public const float NeuralCatalogNegativeWeight = 1.0f;

    /// <summary>Neural sample weight for confirmed For You impression skips (no later engagement).</summary>
    public const float NeuralImpressionSkipWeight = 0.75f;

    /// <summary>Half-life window (days) for neural labeled-sample recency decay.</summary>
    public const double NeuralRecencyHalfLifeDays = 180.0;

    /// <summary>Minimum watched duration (ticks) before a short play can count as abandon.</summary>
    public static readonly long MinAbandonWatchTicks = TimeSpan.FromSeconds(60).Ticks;

    /// <summary>
    /// Classifies engagement for an item.
    /// </summary>
    /// <param name="input">Engagement inputs.</param>
    /// <param name="nowUtc">Current UTC time (for abandon age checks).</param>
    /// <returns>Engagement kind.</returns>
    public static TasteEngagementKind Classify(in TasteEngagementInput input, DateTime nowUtc)
    {
        if (input.IsFavorite || input.Likes == true)
        {
            return TasteEngagementKind.FavoriteOrLike;
        }

        if (input.Likes == false)
        {
            // Explicit dislike is handled as negative linear weight separately; not abandon.
            return TasteEngagementKind.None;
        }

        var ratio = CompletionRatio(input.MaxPlayedTicks, input.RunTimeTicks);
        if (input.Played || (ratio is >= DeepMinRatio))
        {
            return TasteEngagementKind.DeepPlay;
        }

        if (ratio is >= MidMinRatio and < DeepMinRatio)
        {
            return TasteEngagementKind.MidPlay;
        }

        if (IsAbandon(input, ratio, nowUtc))
        {
            return TasteEngagementKind.Abandon;
        }

        if (input.PlayCount > 0 || input.MaxPlayedTicks > 0)
        {
            // Short open below abandon threshold, or unknown runtime with plays → treat as weak mid.
            return ratio is null && (input.PlayCount > 0 || input.Played)
                ? TasteEngagementKind.DeepPlay
                : TasteEngagementKind.None;
        }

        return TasteEngagementKind.None;
    }

    /// <summary>
    /// Computes the linear taste signal weight for an item.
    /// </summary>
    /// <param name="input">Engagement inputs.</param>
    /// <param name="nowUtc">Current UTC time.</param>
    /// <returns>Signed weight (may be negative for abandon/dislike).</returns>
    public static float ComputeLinearWeight(in TasteEngagementInput input, DateTime nowUtc)
    {
        float weight = 0f;
        if (input.IsFavorite)
        {
            weight += 3f;
        }

        if (input.Likes == true)
        {
            weight += 2f;
        }
        else if (input.Likes == false)
        {
            weight -= 2f;
        }

        var kind = Classify(input, nowUtc);
        switch (kind)
        {
            case TasteEngagementKind.DeepPlay:
                weight += DeepPlayLinearDelta(input);
                break;
            case TasteEngagementKind.MidPlay:
                weight += MidPlayLinearDelta(input);
                break;
            case TasteEngagementKind.Abandon:
                weight += input.WasRecommended ? RecAbandonLinearWeight : AbandonLinearWeight;
                break;
            case TasteEngagementKind.FavoriteOrLike:
                // Favorites/likes already counted; still add play bonus when present.
                if (input.Played || input.PlayCount > 0 || CompletionRatio(input.MaxPlayedTicks, input.RunTimeTicks) >= MidMinRatio)
                {
                    weight += DeepPlayLinearDelta(input);
                }

                break;
        }

        if (input.UserRating is double userRating)
        {
            weight += (float)(userRating / 10.0);
        }

        if (kind is TasteEngagementKind.FavoriteOrLike or TasteEngagementKind.DeepPlay or TasteEngagementKind.MidPlay
            && input.WasRecommended
            && weight > 0f)
        {
            weight *= RecPositiveEngageMultiplier;
        }

        if (input.LastPlayedUtc is DateTime lastPlayed)
        {
            var ageDays = Math.Max(0, (nowUtc - lastPlayed.ToUniversalTime()).TotalDays);
            weight *= (float)Math.Exp(-ageDays / 180.0);
        }

        return weight;
    }

    /// <summary>
    /// Computes the neural training sample weight and whether the example is a positive label.
    /// </summary>
    /// <param name="input">Engagement inputs.</param>
    /// <param name="nowUtc">Current UTC time.</param>
    /// <param name="isPositive">True when the example should be labeled positive.</param>
    /// <param name="sampleWeight">ML.NET example weight.</param>
    /// <returns>False when the item should be skipped (no training signal).</returns>
    public static bool TryGetNeuralExample(
        in TasteEngagementInput input,
        DateTime nowUtc,
        out bool isPositive,
        out float sampleWeight)
    {
        isPositive = false;
        sampleWeight = 0f;

        if (input.Likes == false)
        {
            isPositive = false;
            sampleWeight = ApplyNeuralRecencyDecay(NeuralAbandonWeight, input.LastPlayedUtc, nowUtc);
            return true;
        }

        var kind = Classify(input, nowUtc);
        switch (kind)
        {
            case TasteEngagementKind.FavoriteOrLike:
                isPositive = true;
                sampleWeight = input.WasRecommended
                    ? NeuralRecPositiveWeight
                    : (input.IsFavorite ? NeuralFavoriteWeight : NeuralLikeWeight);
                break;
            case TasteEngagementKind.DeepPlay:
                isPositive = true;
                sampleWeight = input.WasRecommended ? NeuralRecPositiveWeight : NeuralDeepPlayWeight;
                break;
            case TasteEngagementKind.MidPlay:
                isPositive = true;
                sampleWeight = input.WasRecommended ? NeuralRecPositiveWeight : NeuralMidPlayWeight;
                break;
            case TasteEngagementKind.Abandon:
                isPositive = false;
                sampleWeight = input.WasRecommended ? NeuralRecAbandonWeight : NeuralAbandonWeight;
                break;
            default:
                return false;
        }

        sampleWeight = ApplyNeuralRecencyDecay(sampleWeight, input.LastPlayedUtc, nowUtc);
        return true;
    }

    /// <summary>
    /// Applies exponential recency decay to a neural sample weight.
    /// </summary>
    /// <param name="weight">Base sample weight.</param>
    /// <param name="eventUtc">Event time (play or impression), or null.</param>
    /// <param name="nowUtc">Current UTC time.</param>
    /// <returns>Decayed weight (unchanged when event time is missing).</returns>
    public static float ApplyNeuralRecencyDecay(float weight, DateTime? eventUtc, DateTime nowUtc)
    {
        if (eventUtc is not DateTime when)
        {
            return weight;
        }

        var ageDays = Math.Max(0, (nowUtc - when.ToUniversalTime()).TotalDays);
        return weight * (float)Math.Exp(-ageDays / NeuralRecencyHalfLifeDays);
    }

    /// <summary>
    /// Whether a For You impression is old enough to count as a confirmed skip.
    /// </summary>
    /// <param name="servedAtUtc">Impression time UTC.</param>
    /// <param name="nowUtc">Current UTC time.</param>
    /// <returns>True when the confirm window has elapsed.</returns>
    public static bool IsConfirmedImpressionSkip(DateTime servedAtUtc, DateTime nowUtc)
    {
        var ageDays = (nowUtc - servedAtUtc.ToUniversalTime()).TotalDays;
        return ageDays >= ImpressionSkipConfirmDays;
    }

    /// <summary>
    /// Completion ratio, or null when runtime is unknown.
    /// </summary>
    /// <param name="maxPlayedTicks">Max played ticks.</param>
    /// <param name="runTimeTicks">Runtime ticks.</param>
    /// <returns>Ratio in 0…∞, or null.</returns>
    public static float? CompletionRatio(long maxPlayedTicks, long? runTimeTicks)
    {
        if (runTimeTicks is null or <= 0 || maxPlayedTicks <= 0)
        {
            return null;
        }

        return (float)maxPlayedTicks / runTimeTicks.Value;
    }

    /// <summary>
    /// Series-level abandon: majority of touched episodes abandoned and no binge progress (fewer than 3 episodes).
    /// </summary>
    /// <param name="touchedEpisodeCount">Distinct episodes with any play signal.</param>
    /// <param name="abandonedEpisodeCount">Episodes classified as abandon.</param>
    /// <returns>True when the series should be treated as abandoned.</returns>
    public static bool IsSeriesAbandon(int touchedEpisodeCount, int abandonedEpisodeCount)
    {
        if (touchedEpisodeCount <= 0 || abandonedEpisodeCount <= 0)
        {
            return false;
        }

        return abandonedEpisodeCount * 2 >= touchedEpisodeCount
            && touchedEpisodeCount < 3;
    }

    private static bool IsAbandon(in TasteEngagementInput input, float? ratio, DateTime nowUtc)
    {
        if (input.IsFavorite || input.Likes == true || input.Played)
        {
            return false;
        }

        if (input.HasLaterPlayWithinNoReturnWindow)
        {
            return false;
        }

        if (input.MaxPlayedTicks < MinAbandonWatchTicks)
        {
            return false;
        }

        if (ratio is null or >= AbandonMaxRatio)
        {
            return false;
        }

        // Require the short watch to be old enough that the no-return window has elapsed,
        // unless LastPlayedUtc is unknown (treat as confirmed when caller already set the flag).
        if (input.LastPlayedUtc is DateTime lastPlayed)
        {
            var ageDays = (nowUtc - lastPlayed.ToUniversalTime()).TotalDays;
            if (ageDays < AbandonNoReturnDays)
            {
                return false;
            }
        }

        return true;
    }

    private static float DeepPlayLinearDelta(in TasteEngagementInput input)
    {
        var play = 1f + (Math.Min(Math.Max(input.PlayCount, 1), 5) * 0.15f);
        var ratio = CompletionRatio(input.MaxPlayedTicks, input.RunTimeTicks);
        if (ratio is float r)
        {
            play *= Math.Clamp(r, DeepMinRatio, 1.25f);
        }

        return play;
    }

    private static float MidPlayLinearDelta(in TasteEngagementInput input)
    {
        var ratio = CompletionRatio(input.MaxPlayedTicks, input.RunTimeTicks) ?? MidMinRatio;
        return Math.Clamp(ratio, MidMinRatio, DeepMinRatio) * 0.85f;
    }
}
