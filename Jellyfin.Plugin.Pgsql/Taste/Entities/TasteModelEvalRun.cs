using System;

namespace Jellyfin.Plugin.Pgsql.Taste.Entities;

/// <summary>
/// Offline evaluation metrics for a shadow neural / ML training run.
/// </summary>
public sealed class TasteModelEvalRun
{
    /// <summary>
    /// Gets or sets the evaluation run identifier.
    /// </summary>
    public Guid Id { get; set; }

    /// <summary>
    /// Gets or sets when the run finished (UTC).
    /// </summary>
    public DateTime CreatedAt { get; set; }

    /// <summary>
    /// Gets or sets training duration in milliseconds.
    /// </summary>
    public long TrainDurationMs { get; set; }

    /// <summary>
    /// Gets or sets the number of positive training pairs.
    /// </summary>
    public int PositiveCount { get; set; }

    /// <summary>
    /// Gets or sets the number of negative training pairs.
    /// </summary>
    public int NegativeCount { get; set; }

    /// <summary>
    /// Gets or sets the holdout set size used for evaluation.
    /// </summary>
    public int HoldoutCount { get; set; }

    /// <summary>
    /// Gets or sets accuracy on the holdout set (0–1), or null when unevaluable.
    /// </summary>
    public double? Accuracy { get; set; }

    /// <summary>
    /// Gets or sets area under the ROC curve on the holdout set, or null when unevaluable.
    /// </summary>
    public double? Auc { get; set; }

    /// <summary>
    /// Gets or sets precision at 10 on the holdout ranking, or null when unevaluable.
    /// </summary>
    public double? PrecisionAt10 { get; set; }

    /// <summary>
    /// Gets or sets the saved model artifact relative path under the plugin data folder.
    /// </summary>
    public string? ModelPath { get; set; }

    /// <summary>
    /// Gets or sets an optional human-readable note (e.g. skip reason).
    /// </summary>
    public string? Notes { get; set; }
}
