using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// A single requestable title from Seerr search.
/// </summary>
public sealed class SeerrSearchItem
{
    /// <summary>
    /// Gets or sets the media type (<c>movie</c> or <c>tv</c>).
    /// </summary>
    [JsonPropertyName("mediaType")]
    public required string MediaType { get; set; }

    /// <summary>
    /// Gets or sets the TMDB media id.
    /// </summary>
    [JsonPropertyName("mediaId")]
    public int MediaId { get; set; }

    /// <summary>
    /// Gets or sets the display title.
    /// </summary>
    [JsonPropertyName("title")]
    public required string Title { get; set; }

    /// <summary>
    /// Gets or sets the release / first-air year when known.
    /// </summary>
    [JsonPropertyName("year")]
    public int? Year { get; set; }

    /// <summary>
    /// Gets or sets the overview text.
    /// </summary>
    [JsonPropertyName("overview")]
    public string? Overview { get; set; }

    /// <summary>
    /// Gets or sets the absolute poster URL when available.
    /// </summary>
    [JsonPropertyName("posterUrl")]
    public string? PosterUrl { get; set; }

    /// <summary>
    /// Gets or sets the normalized availability status.
    /// </summary>
    [JsonPropertyName("status")]
    public SeerrMediaStatus Status { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this title can be requested.
    /// </summary>
    [JsonPropertyName("canRequest")]
    public bool CanRequest { get; set; }
}
