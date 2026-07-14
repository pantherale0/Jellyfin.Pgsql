namespace Jellyfin.Plugin.Seerr.Services;

/// <summary>
/// Seerr <c>/status</c> payload.
/// </summary>
public sealed class SeerrStatusDto
{
    /// <summary>
    /// Gets or sets the Seerr version.
    /// </summary>
    public string? Version { get; set; }
}
