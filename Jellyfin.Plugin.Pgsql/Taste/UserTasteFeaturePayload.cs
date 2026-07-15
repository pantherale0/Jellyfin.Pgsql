using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Serialized taste dimensions for a user (weights are L1-normalized per bucket when non-empty).
/// </summary>
#pragma warning disable CA2227 // Collection properties set when deserializing / rebuilding profiles
public sealed class UserTasteFeaturePayload
{
    /// <summary>
    /// Gets or sets genre CleanValue → weight.
    /// </summary>
    [JsonPropertyName("genres")]
    public Dictionary<string, float> Genres { get; set; } = new(System.StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Gets or sets tag CleanValue → weight.
    /// </summary>
    [JsonPropertyName("tags")]
    public Dictionary<string, float> Tags { get; set; } = new(System.StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Gets or sets studio CleanValue → weight.
    /// </summary>
    [JsonPropertyName("studios")]
    public Dictionary<string, float> Studios { get; set; } = new(System.StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Gets or sets director people id string → weight.
    /// </summary>
    [JsonPropertyName("directors")]
    public Dictionary<string, float> Directors { get; set; } = new(System.StringComparer.Ordinal);

    /// <summary>
    /// Gets or sets actor people id string → weight.
    /// </summary>
    [JsonPropertyName("actors")]
    public Dictionary<string, float> Actors { get; set; } = new(System.StringComparer.Ordinal);

    /// <summary>
    /// Gets or sets mean community rating of positive items.
    /// </summary>
    [JsonPropertyName("ratingMean")]
    public float? RatingMean { get; set; }

    /// <summary>
    /// Gets or sets approximate 25th percentile community rating of positive items.
    /// </summary>
    [JsonPropertyName("ratingP25")]
    public float? RatingP25 { get; set; }

    /// <summary>
    /// Gets or sets approximate 75th percentile community rating of positive items.
    /// </summary>
    [JsonPropertyName("ratingP75")]
    public float? RatingP75 { get; set; }
}
#pragma warning restore CA2227
