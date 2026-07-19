namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// A Seerr search hit plus fields needed for parental filtering before client mapping.
/// </summary>
public sealed class SeerrSearchCandidate
{
    /// <summary>
    /// Gets or sets the gateway search item.
    /// </summary>
    public required SeerrSearchItem Item { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether TMDB flagged the title as adult on the search payload.
    /// </summary>
    public bool Adult { get; set; }
}
