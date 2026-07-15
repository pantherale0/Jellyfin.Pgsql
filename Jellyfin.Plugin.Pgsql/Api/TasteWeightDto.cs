namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Labeled weight for charts.
/// </summary>
public sealed class TasteWeightDto
{
    /// <summary>Gets or sets label.</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>Gets or sets weight 0–1.</summary>
    public float Weight { get; set; }
}
