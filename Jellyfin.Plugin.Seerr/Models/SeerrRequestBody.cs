namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Request body for creating a Seerr media request.
/// </summary>
public sealed class SeerrRequestBody
{
    /// <summary>
    /// Gets or sets the media type (<c>movie</c> or <c>tv</c>).
    /// </summary>
    public required string MediaType { get; set; }

    /// <summary>
    /// Gets or sets the TMDB media id.
    /// </summary>
    public int MediaId { get; set; }
}
