namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// A single requestable title from Seerr search.
/// </summary>
public sealed class SeerrSearchItem
{
    /// <summary>
    /// Gets or sets the media type (<c>movie</c> or <c>tv</c>).
    /// </summary>
    public required string MediaType { get; set; }

    /// <summary>
    /// Gets or sets the TMDB media id.
    /// </summary>
    public int MediaId { get; set; }

    /// <summary>
    /// Gets or sets the display title.
    /// </summary>
    public required string Title { get; set; }

    /// <summary>
    /// Gets or sets the release / first-air year when known.
    /// </summary>
    public int? Year { get; set; }

    /// <summary>
    /// Gets or sets the overview text.
    /// </summary>
    public string? Overview { get; set; }

    /// <summary>
    /// Gets or sets the absolute poster URL when available.
    /// </summary>
    public string? PosterUrl { get; set; }

    /// <summary>
    /// Gets or sets the normalized availability status.
    /// </summary>
    public SeerrMediaStatus Status { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this title can be requested.
    /// </summary>
    public bool CanRequest { get; set; }
}
