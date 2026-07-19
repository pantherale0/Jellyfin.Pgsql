namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Parental-rating metadata resolved from Seerr/TMDB for a single title.
/// </summary>
public sealed class SeerrMediaRating
{
    /// <summary>
    /// Gets a failed lookup result (fail-closed for restricted users).
    /// </summary>
    public static SeerrMediaRating Failed { get; } = new() { LookupFailed = true };

    /// <summary>
    /// Gets or sets a value indicating whether TMDB flags the title as adult.
    /// </summary>
    public bool Adult { get; set; }

    /// <summary>
    /// Gets or sets the preferred content certification string (e.g. PG-13, TV-14).
    /// </summary>
    public string? Certification { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the detail/certification lookup failed.
    /// </summary>
    public bool LookupFailed { get; set; }
}
