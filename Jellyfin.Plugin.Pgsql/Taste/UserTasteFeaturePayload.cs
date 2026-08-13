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
    /// Gets or sets writer people id string → weight.
    /// </summary>
    [JsonPropertyName("writers")]
    public Dictionary<string, float> Writers { get; set; } = new(System.StringComparer.Ordinal);

    /// <summary>
    /// Gets or sets box-set item id string → weight.
    /// </summary>
    [JsonPropertyName("boxSets")]
    public Dictionary<string, float> BoxSets { get; set; } = new(System.StringComparer.Ordinal);

    /// <summary>
    /// Gets or sets original-language code → weight.
    /// </summary>
    [JsonPropertyName("languages")]
    public Dictionary<string, float> Languages { get; set; } = new(System.StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Gets or sets production-country token → weight.
    /// </summary>
    [JsonPropertyName("countries")]
    public Dictionary<string, float> Countries { get; set; } = new(System.StringComparer.OrdinalIgnoreCase);

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

    /// <summary>
    /// Gets or sets mean production year of positive items.
    /// </summary>
    [JsonPropertyName("yearMean")]
    public float? YearMean { get; set; }

    /// <summary>
    /// Gets or sets approximate 25th percentile production year of positive items.
    /// </summary>
    [JsonPropertyName("yearP25")]
    public float? YearP25 { get; set; }

    /// <summary>
    /// Gets or sets approximate 75th percentile production year of positive items.
    /// </summary>
    [JsonPropertyName("yearP75")]
    public float? YearP75 { get; set; }

    /// <summary>
    /// Gets or sets mean runtime (ticks) of positive items.
    /// </summary>
    [JsonPropertyName("runtimeMeanTicks")]
    public float? RuntimeMeanTicks { get; set; }

    /// <summary>
    /// Gets or sets approximate 25th percentile runtime (ticks) of positive items.
    /// </summary>
    [JsonPropertyName("runtimeP25Ticks")]
    public float? RuntimeP25Ticks { get; set; }

    /// <summary>
    /// Gets or sets approximate 75th percentile runtime (ticks) of positive items.
    /// </summary>
    [JsonPropertyName("runtimeP75Ticks")]
    public float? RuntimeP75Ticks { get; set; }

    /// <summary>
    /// Gets or sets mean inherited parental rating value of positive items.
    /// </summary>
    [JsonPropertyName("parentalMean")]
    public float? ParentalMean { get; set; }

    /// <summary>
    /// Gets or sets approximate 25th percentile inherited parental rating of positive items.
    /// </summary>
    [JsonPropertyName("parentalP25")]
    public float? ParentalP25 { get; set; }

    /// <summary>
    /// Gets or sets approximate 75th percentile inherited parental rating of positive items.
    /// </summary>
    [JsonPropertyName("parentalP75")]
    public float? ParentalP75 { get; set; }

    /// <summary>
    /// Gets or sets the share of positive signals that are series (0…1).
    /// </summary>
    [JsonPropertyName("seriesShare")]
    public float? SeriesShare { get; set; }
}
#pragma warning restore CA2227
