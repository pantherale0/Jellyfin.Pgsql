using System;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// One shadow taste-model evaluation run for the admin dashboard.
/// </summary>
public sealed class TasteModelEvalRunDto
{
    /// <summary>Gets or sets the run identifier.</summary>
    public Guid Id { get; set; }

    /// <summary>Gets or sets when the run finished (UTC).</summary>
    public DateTime CreatedAt { get; set; }

    /// <summary>Gets or sets training duration in milliseconds.</summary>
    public long TrainDurationMs { get; set; }

    /// <summary>Gets or sets the number of positive training pairs.</summary>
    public int PositiveCount { get; set; }

    /// <summary>Gets or sets the number of negative training pairs.</summary>
    public int NegativeCount { get; set; }

    /// <summary>Gets or sets the holdout set size.</summary>
    public int HoldoutCount { get; set; }

    /// <summary>Gets or sets holdout accuracy.</summary>
    public double? Accuracy { get; set; }

    /// <summary>Gets or sets holdout ROC AUC.</summary>
    public double? Auc { get; set; }

    /// <summary>Gets or sets precision at 10 on the ranked holdout.</summary>
    public double? PrecisionAt10 { get; set; }

    /// <summary>Gets or sets macro-averaged precision at 10 across users.</summary>
    public double? MeanPrecisionAt10 { get; set; }

    /// <summary>Gets or sets the holdout split strategy.</summary>
    public string? SplitType { get; set; }

    /// <summary>Gets or sets the holdout fraction of the event-time span.</summary>
    public double? HoldoutFraction { get; set; }

    /// <summary>Gets or sets the inclusive start of the holdout window (UTC).</summary>
    public DateTime? HoldoutWindowStart { get; set; }

    /// <summary>Gets or sets the end of the holdout window (UTC).</summary>
    public DateTime? HoldoutWindowEnd { get; set; }

    /// <summary>Gets or sets the number of training examples (excluding holdout).</summary>
    public int TrainCount { get; set; }

    /// <summary>Gets or sets matured For You impression→engage rate.</summary>
    public double? ForYouEngageRate { get; set; }

    /// <summary>Gets or sets the For You engage window in days.</summary>
    public int? ForYouEngageWindowDays { get; set; }

    /// <summary>Gets or sets the matured distinct For You impression count.</summary>
    public int? ForYouImpressionCount { get; set; }

    /// <summary>Gets or sets the matured For You engage count.</summary>
    public int? ForYouEngageCount { get; set; }

    /// <summary>Gets or sets the relative model artifact path.</summary>
    public string? ModelPath { get; set; }

    /// <summary>Gets or sets skip/failure notes when training did not produce metrics.</summary>
    public string? Notes { get; set; }

    /// <summary>Gets or sets a value indicating whether this run produced evaluation metrics.</summary>
    public bool Succeeded { get; set; }
}
