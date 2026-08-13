using System;
using System.Collections.Generic;
using System.Linq;

#pragma warning disable SA1402 // Companion split record lives in this file.

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Holdout split and ranking metrics for shadow taste evaluation.
/// </summary>
public static class TasteEvalMetrics
{
    /// <summary>Persisted split-type value for time-based holdout.</summary>
    public const string SplitTypeTimeBased = "TimeBased";

    /// <summary>Default holdout fraction of the event-time span.</summary>
    public const float DefaultHoldoutFraction = 0.2f;

    /// <summary>
    /// Splits examples into train/holdout using the newest <paramref name="holdoutFraction"/> of the event-time span.
    /// </summary>
    /// <typeparam name="T">Example type.</typeparam>
    /// <param name="examples">Pooled examples.</param>
    /// <param name="eventUtc">Event time selector.</param>
    /// <param name="holdoutFraction">Fraction of the [min,max] span assigned to holdout.</param>
    /// <returns>Train, holdout, and window bounds.</returns>
    public static TasteTimeSplit<T> SplitByEventTime<T>(
        IReadOnlyList<T> examples,
        Func<T, DateTime> eventUtc,
        float holdoutFraction = DefaultHoldoutFraction)
    {
        ArgumentNullException.ThrowIfNull(examples);
        ArgumentNullException.ThrowIfNull(eventUtc);
        holdoutFraction = Math.Clamp(holdoutFraction, 0.05f, 0.5f);

        if (examples.Count == 0)
        {
            return new TasteTimeSplit<T>([], [], DateTime.UtcNow, DateTime.UtcNow);
        }

        var ordered = examples.OrderBy(e => eventUtc(e)).ToList();
        var min = eventUtc(ordered[0]);
        var max = eventUtc(ordered[^1]);
        DateTime cutoff;
        if (max <= min)
        {
            var holdoutCount = Math.Max(1, (int)(ordered.Count * holdoutFraction));
            var train = ordered.Take(Math.Max(0, ordered.Count - holdoutCount)).ToList();
            var holdout = ordered.Skip(train.Count).ToList();
            return new TasteTimeSplit<T>(train, holdout, min, max);
        }

        var span = max - min;
        cutoff = min + TimeSpan.FromTicks((long)(span.Ticks * (1f - holdoutFraction)));
        var trainRows = new List<T>();
        var holdoutRows = new List<T>();
        foreach (var row in ordered)
        {
            if (eventUtc(row) >= cutoff)
            {
                holdoutRows.Add(row);
            }
            else
            {
                trainRows.Add(row);
            }
        }

        if (holdoutRows.Count == 0 && trainRows.Count > 0)
        {
            holdoutRows.Add(trainRows[^1]);
            trainRows.RemoveAt(trainRows.Count - 1);
        }

        return new TasteTimeSplit<T>(trainRows, holdoutRows, cutoff, max);
    }

    /// <summary>
    /// Returns true when <paramref name="labels"/> contains at least one positive and one negative.
    /// ML.NET ROC AUC is undefined for a single-class holdout.
    /// </summary>
    /// <param name="labels">Binary labels.</param>
    /// <returns>True when both classes are present.</returns>
    public static bool HasBothBinaryClasses(IEnumerable<bool> labels)
    {
        ArgumentNullException.ThrowIfNull(labels);
        var sawPositive = false;
        var sawNegative = false;
        foreach (var label in labels)
        {
            if (label)
            {
                sawPositive = true;
            }
            else
            {
                sawNegative = true;
            }

            if (sawPositive && sawNegative)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Global precision at K on a score-ranked list.
    /// </summary>
    /// <param name="ranked">Rows already ordered by descending score.</param>
    /// <param name="k">Cut size.</param>
    /// <returns>Precision in 0…1.</returns>
    public static double PrecisionAtK(IReadOnlyList<(float Score, bool Label)> ranked, int k)
    {
        if (ranked is null || ranked.Count == 0 || k <= 0)
        {
            return 0;
        }

        var top = ranked.Take(Math.Min(k, ranked.Count)).ToList();
        return top.Count(x => x.Label) / (double)top.Count;
    }

    /// <summary>
    /// Macro-average precision at K across users.
    /// </summary>
    /// <param name="rows">Holdout rows with user, score, and label.</param>
    /// <param name="k">Cut size.</param>
    /// <returns>Mean per-user precision, or 0 when empty.</returns>
    public static double MeanPrecisionAtK(
        IEnumerable<(Guid UserId, float Score, bool Label)> rows,
        int k)
    {
        ArgumentNullException.ThrowIfNull(rows);
        if (k <= 0)
        {
            return 0;
        }

        var scores = new List<double>();
        foreach (var group in rows.GroupBy(r => r.UserId))
        {
            var ranked = group
                .OrderByDescending(x => x.Score)
                .Select(x => (x.Score, x.Label))
                .ToList();
            if (ranked.Count == 0)
            {
                continue;
            }

            scores.Add(PrecisionAtK(ranked, k));
        }

        return scores.Count == 0 ? 0 : scores.Average();
    }

    /// <summary>
    /// Mid-point of the train window (used for catalog-negative event times).
    /// </summary>
    /// <param name="minEventUtc">Earliest labeled event.</param>
    /// <param name="windowStart">Holdout window start (train ends here).</param>
    /// <returns>Train-window midpoint.</returns>
    public static DateTime TrainWindowMidpoint(DateTime minEventUtc, DateTime windowStart)
    {
        if (windowStart <= minEventUtc)
        {
            return minEventUtc;
        }

        return minEventUtc + TimeSpan.FromTicks((windowStart - minEventUtc).Ticks / 2);
    }
}

/// <summary>
/// Result of a time-based train/holdout split.
/// </summary>
/// <typeparam name="T">Example type.</typeparam>
/// <param name="Train">Train rows.</param>
/// <param name="Holdout">Holdout rows.</param>
/// <param name="WindowStart">Holdout window start (inclusive).</param>
/// <param name="WindowEnd">Holdout window end.</param>
public sealed record TasteTimeSplit<T>(
    IReadOnlyList<T> Train,
    IReadOnlyList<T> Holdout,
    DateTime WindowStart,
    DateTime WindowEnd);
